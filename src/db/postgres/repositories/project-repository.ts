import { eq, inArray } from 'drizzle-orm';
import type { HubProject, Tag } from '@/types';
import type { ProjectRepository } from '@/db/persistence/core-repositories';
import type { PostgresDatabase, PostgresTransaction } from '../runtime';
import {
  hubProjects,
  projectAutoIncludeExclusions,
  projectHierarchyCommands,
  projectHierarchyMutationContext,
  projectMilestones,
  projectPhaseItems,
  projectPhases,
  projectTags,
  tags,
  taskProjects,
} from '../schema';

type ProjectRow = typeof hubProjects.$inferSelect;

type Queryable = PostgresDatabase | PostgresTransaction;

interface TagRow {
  id: string;
  name: string;
  slug: string;
  type: string;
  source: string | null;
  color: string | null;
  confirmed: boolean;
  createdAt: string;
}

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type as Tag['type'],
    source: row.source ?? undefined,
    color: row.color ?? undefined,
    confirmed: row.confirmed,
    createdAt: row.createdAt,
  };
}

function toHubProject(row: ProjectRow, projectTagRows: Tag[]): HubProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color,
    icon: row.icon ?? undefined,
    iconColor: row.iconColor ?? undefined,
    sourceBindings: row.sourceBindings as HubProject['sourceBindings'],
    autoIncludeRules: row.autoIncludeRules as HubProject['autoIncludeRules'],
    kanbanColumns: row.kanbanColumns as HubProject['kanbanColumns'],
    defaultView: row.defaultView as HubProject['defaultView'],
    defaultFilters: (row.defaultFilters ?? undefined) as HubProject['defaultFilters'],
    status: row.status as HubProject['status'],
    statusOverride: (row.statusOverride ?? undefined) as HubProject['statusOverride'],
    hidden: row.hidden,
    category: row.category ?? undefined,
    targetDate: row.targetDate ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    sortOrder: row.sortOrder,
    metadata: row.metadata as Record<string, unknown>,
    tags: projectTagRows,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadProjectTags(client: Queryable, projectId: string): Promise<Tag[]> {
  const rows = await client
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      source: tags.source,
      color: tags.color,
      confirmed: tags.confirmed,
      createdAt: tags.createdAt,
    })
    .from(projectTags)
    .innerJoin(tags, eq(tags.id, projectTags.tagId))
    .where(eq(projectTags.projectId, projectId));
  return rows.map(toTag);
}

/**
 * Upserts the shared `tags` rows referenced by a project, then replaces the
 * `project_tags` junction rows to exactly match the provided set. Tag
 * ownership (`unified_into`) is intentionally preserved by omitting it from
 * the upsert's SET clause, since it isn't part of the portable `Tag` type.
 */
async function syncProjectTags(
  tx: PostgresTransaction,
  projectId: string,
  projectTagList: Tag[],
): Promise<void> {
  for (const tag of projectTagList) {
    await tx
      .insert(tags)
      .values({
        id: tag.id,
        name: tag.name,
        slug: tag.slug,
        type: tag.type,
        source: tag.source ?? null,
        color: tag.color ?? null,
        confirmed: tag.confirmed,
        createdAt: tag.createdAt,
      })
      .onConflictDoUpdate({
        target: tags.id,
        set: {
          name: tag.name,
          slug: tag.slug,
          type: tag.type,
          source: tag.source ?? null,
          color: tag.color ?? null,
          confirmed: tag.confirmed,
        },
      });
  }

  await tx.delete(projectTags).where(eq(projectTags.projectId, projectId));
  if (projectTagList.length > 0) {
    await tx.insert(projectTags).values(
      projectTagList.map((tag) => ({ projectId, tagId: tag.id })),
    );
  }
}

/**
 * PostgreSQL-backed implementation of the portable `ProjectRepository`
 * contract for `HubProject` records, including their `tags` relation
 * (`project_tags` junction over the shared `tags` table).
 */
export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(id: string): Promise<HubProject | null> {
    const [row] = await this.db
      .select()
      .from(hubProjects)
      .where(eq(hubProjects.id, id))
      .limit(1);
    if (!row) return null;
    const projectTagList = await loadProjectTags(this.db, id);
    return toHubProject(row, projectTagList);
  }

  async upsert(project: HubProject): Promise<HubProject> {
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const values = {
        id: project.id,
        name: project.name,
        description: project.description ?? null,
        color: project.color,
        icon: project.icon ?? null,
        iconColor: project.iconColor ?? null,
        sourceBindings: project.sourceBindings,
        autoIncludeRules: project.autoIncludeRules,
        kanbanColumns: project.kanbanColumns,
        defaultView: project.defaultView,
        defaultFilters: project.defaultFilters ?? null,
        status: project.status,
        statusOverride: project.statusOverride ?? null,
        hidden: project.hidden ?? false,
        category: project.category ?? null,
        targetDate: project.targetDate ?? null,
        startedAt: project.startedAt ?? null,
        completedAt: project.completedAt ?? null,
        sortOrder: project.sortOrder,
        metadata: project.metadata,
        createdAt: project.createdAt ?? now,
        updatedAt: now,
      };

      const [row] = await tx
        .insert(hubProjects)
        .values(values)
        .onConflictDoUpdate({
          target: hubProjects.id,
          set: {
            name: values.name,
            description: values.description,
            color: values.color,
            icon: values.icon,
            iconColor: values.iconColor,
            sourceBindings: values.sourceBindings,
            autoIncludeRules: values.autoIncludeRules,
            kanbanColumns: values.kanbanColumns,
            defaultView: values.defaultView,
            defaultFilters: values.defaultFilters,
            status: values.status,
            statusOverride: values.statusOverride,
            hidden: values.hidden,
            category: values.category,
            targetDate: values.targetDate,
            startedAt: values.startedAt,
            completedAt: values.completedAt,
            sortOrder: values.sortOrder,
            metadata: values.metadata,
            updatedAt: values.updatedAt,
          },
        })
        .returning();

      await syncProjectTags(tx, project.id, project.tags);
      const projectTagList = await loadProjectTags(tx, project.id);
      return toHubProject(row, projectTagList);
    });
  }

  /**
   * Deletes a project and every relation it owns: shared-tag links,
   * task-project links, auto-include exclusions, milestones, phases (plus
   * each phase's items), and hierarchy-command audit/mutation-context rows.
   */
  async delete(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.delete(projectTags).where(eq(projectTags.projectId, id));
      await tx.delete(taskProjects).where(eq(taskProjects.projectId, id));
      await tx.delete(projectAutoIncludeExclusions).where(eq(projectAutoIncludeExclusions.projectId, id));
      await tx.delete(projectMilestones).where(eq(projectMilestones.projectId, id));

      const ownedPhases = await tx
        .select({ id: projectPhases.id })
        .from(projectPhases)
        .where(eq(projectPhases.projectId, id));
      const ownedPhaseIds = ownedPhases.map((phase) => phase.id);
      if (ownedPhaseIds.length > 0) {
        await tx.delete(projectPhaseItems).where(inArray(projectPhaseItems.phaseId, ownedPhaseIds));
      }
      await tx.delete(projectPhases).where(eq(projectPhases.projectId, id));

      await tx.delete(projectHierarchyCommands).where(eq(projectHierarchyCommands.projectId, id));
      await tx.delete(projectHierarchyMutationContext).where(eq(projectHierarchyMutationContext.projectId, id));

      const deleted = await tx
        .delete(hubProjects)
        .where(eq(hubProjects.id, id))
        .returning({ id: hubProjects.id });
      return deleted.length > 0;
    });
  }
}
