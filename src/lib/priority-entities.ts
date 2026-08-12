import { and, asc, eq } from 'drizzle-orm';
import db from '@/db';
import { hubProjects, priorityEntities, sourceLists, tags } from '@/db/schema';
import type { PriorityEntity } from '@/lib/smart-score';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';

type ReferencedPriorityType = 'project' | 'tag' | 'source';

export interface PriorityReference {
  referenceId: string;
  name: string;
  description?: string | null;
  color?: string | null;
}

function parseSourceReference(referenceId: string): { connectorInstanceId: string; sourceId: string } | null {
  const separatorIndex = referenceId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === referenceId.length - 1) return null;
  return {
    connectorInstanceId: referenceId.slice(0, separatorIndex),
    sourceId: referenceId.slice(separatorIndex + 1),
  };
}

export function resolvePriorityReference(
  type: ReferencedPriorityType,
  referenceId: string,
): PriorityReference | null {
  if (type === 'project') {
    const project = db.select({
      name: hubProjects.name,
      description: hubProjects.description,
      color: hubProjects.color,
    }).from(hubProjects).where(eq(hubProjects.id, referenceId)).get();
    return project ? { referenceId, ...project } : null;
  }

  if (type === 'tag') {
    const tag = db.select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      unifiedInto: tags.unifiedInto,
    }).from(tags).where(eq(tags.id, referenceId)).get();
    if (!tag) return null;
    if (!tag.unifiedInto) return { referenceId: tag.id, name: tag.name, color: tag.color };
    const canonicalTag = db.select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
    }).from(tags).where(eq(tags.id, tag.unifiedInto)).get();
    return canonicalTag
      ? { referenceId: canonicalTag.id, name: canonicalTag.name, color: canonicalTag.color }
      : null;
  }

  const parsed = parseSourceReference(referenceId);
  if (!parsed) return null;
  const source = db.select({
    name: sourceLists.name,
    userDisplayName: sourceLists.userDisplayName,
    color: sourceLists.iconColor,
  }).from(sourceLists).where(and(
    eq(sourceLists.connectorInstanceId, parsed.connectorInstanceId),
    eq(sourceLists.sourceId, parsed.sourceId),
  )).get();
  if (!source) return null;
  return {
    referenceId,
    name: resolveSourceListDisplayName(source),
    color: source.color,
  };
}

export function getResolvedPriorityEntities(options: { includeMissing?: boolean } = {}): PriorityEntity[] {
  const entities = db.select()
    .from(priorityEntities)
    .orderBy(asc(priorityEntities.rank))
    .all() as PriorityEntity[];
  const referencedEntities = entities.filter((entity) => entity.referenceId);
  if (referencedEntities.length === 0) {
    return entities.map((entity) => ({ ...entity, referenceStatus: 'resolved' }));
  }
  const referencedTypes = new Set(referencedEntities.map((entity) => entity.type));

  const projectsById = referencedTypes.has('project')
    ? new Map(
        db.select({ id: hubProjects.id, name: hubProjects.name })
          .from(hubProjects)
          .all()
          .map((project) => [project.id, project.name]),
      )
    : new Map<string, string>();
  const tagRows = referencedTypes.has('tag')
    ? db.select({ id: tags.id, name: tags.name, unifiedInto: tags.unifiedInto })
          .from(tags)
          .all()
    : [];
  const rawTagsById = new Map(tagRows.map((tag) => [tag.id, tag]));
  const sourcesById = referencedTypes.has('source')
    ? new Map(
        db.select({
          connectorInstanceId: sourceLists.connectorInstanceId,
          sourceId: sourceLists.sourceId,
          name: sourceLists.name,
          userDisplayName: sourceLists.userDisplayName,
        })
          .from(sourceLists)
          .all()
          .map((source) => [
            `${source.connectorInstanceId}:${source.sourceId}`,
            resolveSourceListDisplayName(source),
          ]),
      )
    : new Map<string, string>();

  return entities.flatMap((entity): PriorityEntity[] => {
    if (
      !entity.referenceId
      || (entity.type !== 'project' && entity.type !== 'tag' && entity.type !== 'source')
    ) {
      return [{ ...entity, referenceStatus: 'resolved' as const }];
    }

    const tag = entity.type === 'tag' ? rawTagsById.get(entity.referenceId) : null;
    const canonicalTag = tag?.unifiedInto ? rawTagsById.get(tag.unifiedInto) : tag;
    const canonicalReferenceId = entity.type === 'tag'
      ? canonicalTag?.id
      : entity.referenceId;
    const canonicalName = entity.type === 'project'
      ? projectsById.get(entity.referenceId)
      : entity.type === 'tag'
        ? canonicalTag?.name
        : sourcesById.get(entity.referenceId);
    if (!canonicalName) {
      return options.includeMissing
        ? [{ ...entity, referenceStatus: 'missing' as const }]
        : [];
    }

    return [{
      ...entity,
      name: canonicalName,
      referenceId: canonicalReferenceId,
      referenceStatus: 'resolved' as const,
    }];
  });
}
