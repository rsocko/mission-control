import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
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

export async function resolvePriorityReference(
  type: ReferencedPriorityType,
  referenceId: string,
): Promise<PriorityReference | null> {
  const { priorityEntities } = await getTaskCorePersistence();

  if (type === 'project') {
    const project = await priorityEntities.getProjectReference(referenceId);
    return project
      ? {
          referenceId,
          name: project.name,
          description: project.description,
          color: project.color,
        }
      : null;
  }

  if (type === 'tag') {
    const tag = await priorityEntities.getTagReference(referenceId);
    if (!tag) return null;
    if (!tag.unifiedInto) return { referenceId: tag.id, name: tag.name, color: tag.color };
    const canonicalTag = await priorityEntities.getTagReference(tag.unifiedInto);
    return canonicalTag
      ? { referenceId: canonicalTag.id, name: canonicalTag.name, color: canonicalTag.color }
      : null;
  }

  const parsed = parseSourceReference(referenceId);
  if (!parsed) return null;
  const source = await priorityEntities.getSourceListReference(
    parsed.connectorInstanceId,
    parsed.sourceId,
  );
  if (!source) return null;
  return {
    referenceId,
    name: resolveSourceListDisplayName(source),
    color: source.color,
  };
}

export async function getResolvedPriorityEntities(
  options: { includeMissing?: boolean } = {},
): Promise<PriorityEntity[]> {
  const repository = (await getTaskCorePersistence()).priorityEntities;
  const entities = await repository.listPriorityEntitiesByRank() as unknown as PriorityEntity[];
  const referencedEntities = entities.filter((entity) => entity.referenceId);
  if (referencedEntities.length === 0) {
    return entities.map((entity) => ({ ...entity, referenceStatus: 'resolved' }));
  }
  const referencedTypes = new Set(referencedEntities.map((entity) => entity.type));

  const [projectRows, tagRows, sourceRows] = await Promise.all([
    referencedTypes.has('project') ? repository.listProjectReferences() : Promise.resolve([]),
    referencedTypes.has('tag') ? repository.listTagReferences() : Promise.resolve([]),
    referencedTypes.has('source') ? repository.listSourceListReferences() : Promise.resolve([]),
  ]);

  const projectsById = new Map(projectRows.map((project) => [project.id, project.name]));
  const rawTagsById = new Map(tagRows.map((tag) => [tag.id, tag]));
  const sourcesById = new Map(sourceRows.map((source) => [
    `${source.connectorInstanceId}:${source.sourceId}`,
    resolveSourceListDisplayName(source),
  ]));

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
