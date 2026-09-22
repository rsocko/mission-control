/**
 * PostgreSQL adapter for `SemanticSourcePort`.
 *
 * Column-for-column identical to `SqliteSemanticSourcePort`, so a projection
 * built on PostgreSQL matches one built on SQLite byte for byte. Read-only.
 */

import type { Pool } from 'pg';
import type {
  SemanticAlertSource,
  SemanticProjectSource,
  SemanticHoustonSummarySource,
  SemanticSourceEntityType,
  SemanticSourceIdPage,
  SemanticSourcePort,
  SemanticSourceRecord,
  SemanticSourceRecordPage,
  SemanticTaskSource,
  SemanticTagSource,
  SemanticTriageItemSource,
} from '@/lib/semantic-index/source/contracts';

type TaskRow = Omit<
  SemanticTaskSource,
  'entityType' | 'semanticEligible' | 'tags' | 'projects' | 'isChecklistItem'
> & {
  isChecklistItem: boolean | number | null;
};

type AlertRow = Omit<SemanticAlertSource, 'entityType' | 'semanticEligible' | 'isActionable'> & {
  isActionable: boolean | number | null;
};

type ProjectRow = Omit<
  SemanticProjectSource,
  | 'entityType'
  | 'semanticEligible'
  | 'tags'
  | 'representativeTasks'
  | 'representativeTaskConnectorTypes'
  | 'taskCount'
  | 'latestTaskUpdatedAt'
>;
type TagRow = Omit<
  SemanticTagSource,
  | 'entityType'
  | 'semanticEligible'
  | 'representativeTasks'
  | 'representativeTaskConnectorTypes'
  | 'usageCount'
  | 'latestTaskUpdatedAt'
>;
type TriageRow = Omit<
  SemanticTriageItemSource,
  'entityType' | 'semanticEligible' | 'aiCategories'
> & {
  aiCategories: unknown;
};
type HoustonSummaryRow = Omit<SemanticHoustonSummarySource, 'entityType' | 'semanticEligible'>;

const TASK_COLUMNS = `
  id,
  title,
  description,
  status,
  status_reason AS "statusReason",
  micro_status AS "microStatus",
  priority,
  planning_horizon AS "planningHorizon",
  local_disposition AS "localDisposition",
  effort,
  due_date AS "dueDate",
  connector_type AS "connectorType",
  connector_instance_id AS "connectorInstanceId",
  source_list_name AS "sourceListName",
  parent_id AS "parentId",
  is_checklist_item AS "isChecklistItem",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`;

const ALERT_COLUMNS = `
  id,
  title,
  body,
  level,
  category,
  state,
  read_state AS "readState",
  disposition,
  source_state AS "sourceState",
  connector_type AS "connectorType",
  is_actionable AS "isActionable",
  received_at AS "receivedAt",
  sort_at AS "sortAt",
  expires_at AS "expiresAt",
  last_source_activity_at AS "lastSourceActivityAt",
  read_at AS "readAt",
  handled_at AS "handledAt",
  resolved_at AS "resolvedAt",
  archived_at AS "archivedAt",
  dismissed_at AS "dismissedAt",
  related_task_id AS "relatedTaskId",
  related_project_id AS "relatedProjectId"
`;

const PROJECT_COLUMNS = `
  id, name, description, status, status_override AS "statusOverride",
  hidden, category, target_date AS "targetDate", started_at AS "startedAt",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"
`;

const TAG_COLUMNS = `
  id, name, slug, type, source, confirmed, created_at AS "createdAt",
  unified_into AS "unifiedInto"
`;

const TRIAGE_COLUMNS = `
  id, source_platform AS "sourcePlatform", title, description,
  content_type AS "contentType", captured_at AS "capturedAt", ingested_at AS "ingestedAt",
  status, snoozed_until AS "snoozedUntil", ai_summary AS "aiSummary",
  ai_categories AS "aiCategories", ai_relevance_score AS "aiRelevanceScore",
  ai_urgency AS "aiUrgency"
`;

const HOUSTON_SUMMARY_COLUMNS = `
  id, authorization_scope AS "authorizationScope", title, summary, decisions,
  commitments, topics, linked_entities AS "linkedEntities", sensitivity,
  retain_until AS "retainUntil", excluded_at AS "excludedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

function toBoolean(value: boolean | number | null): boolean {
  return value === true || value === 1;
}

const MAX_PAGE = 1_000;
const REPRESENTATIVE_LIMIT = 5;

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 1;
  return Math.min(limit, MAX_PAGE);
}

export class PostgresSemanticSourcePort implements SemanticSourcePort {
  constructor(private readonly pool: Pool) {}

  async get(
    entityType: SemanticSourceEntityType,
    entityId: string,
  ): Promise<SemanticSourceRecord | null> {
    if (entityType === 'task') {
      const result = await this.pool.query(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`,
        [entityId],
      );
      const row = result.rows[0] as TaskRow | undefined;
      if (!row) return null;
      const tags = await this.pool.query(
        `
          SELECT tags.name AS name
          FROM task_tags
          JOIN tags ON tags.id = task_tags.tag_id
          WHERE task_tags.task_id = $1
        `,
        [entityId],
      );
      const projects = await this.pool.query(
        `
          SELECT hub_projects.name AS name
          FROM task_projects
          JOIN hub_projects ON hub_projects.id = task_projects.project_id
          WHERE task_projects.task_id = $1 AND hub_projects.hidden = false
        `,
        [entityId],
      );
      return {
        ...row,
        entityType: 'task',
        semanticEligible: true,
        isChecklistItem: toBoolean(row.isChecklistItem),
        tags: (tags.rows as Array<{ name: string }>).map((tag) => tag.name),
        projects: (projects.rows as Array<{ name: string }>).map((project) => project.name),
      };
    }

    if (entityType === 'project') {
      const result = await this.pool.query(
        `SELECT ${PROJECT_COLUMNS} FROM hub_projects WHERE id = $1`,
        [entityId],
      );
      const row = result.rows[0] as ProjectRow | undefined;
      return row ? (await this.hydrateProjects([row]))[0] : null;
    }

    if (entityType === 'tag') {
      const result = await this.pool.query(
        `SELECT ${TAG_COLUMNS} FROM tags WHERE id = $1`,
        [entityId],
      );
      const row = result.rows[0] as TagRow | undefined;
      return row ? (await this.hydrateTags([row]))[0] : null;
    }

    if (entityType === 'triage-item') {
      const result = await this.pool.query(
        `SELECT ${TRIAGE_COLUMNS} FROM triage_items WHERE id = $1`,
        [entityId],
      );
      const row = result.rows[0] as TriageRow | undefined;
      return row ? this.toTriage(row) : null;
    }
    if (entityType === 'houston-summary') {
      const result = await this.pool.query(
        `SELECT ${HOUSTON_SUMMARY_COLUMNS}
         FROM houston_conversation_memories WHERE id = $1`,
        [entityId],
      );
      const row = result.rows[0] as HoustonSummaryRow | undefined;
      return row ? {
        ...row,
        entityType: 'houston-summary',
        semanticEligible: row.excludedAt === null,
      } : null;
    }

    const result = await this.pool.query(
      `SELECT ${ALERT_COLUMNS} FROM notifications WHERE id = $1`,
      [entityId],
    );
    const row = result.rows[0] as AlertRow | undefined;
    if (!row) return null;
    return {
      ...row,
      entityType: 'alert',
      semanticEligible: row.sourceState !== 'deleted' && row.sourceState !== 'stale',
      isActionable: toBoolean(row.isActionable),
    };
  }

  private toTriage(row: TriageRow): SemanticTriageItemSource {
    return {
      ...row,
      entityType: 'triage-item',
      semanticEligible: row.status !== 'dismissed',
      aiCategories: Array.isArray(row.aiCategories)
        ? row.aiCategories.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }

  private async hydrateProjects(rows: ProjectRow[]): Promise<SemanticProjectSource[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [tagResult, taskResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT project_tags.project_id AS "projectId", tags.name
         FROM project_tags JOIN tags ON tags.id = project_tags.tag_id
         WHERE project_tags.project_id = ANY($1::text[])`,
        [ids],
      ),
      this.pool.query(
        `SELECT "projectId", title, "connectorType" FROM (
           SELECT task_projects.project_id AS "projectId", tasks.title,
                  tasks.connector_type AS "connectorType",
                  ROW_NUMBER() OVER (
                    PARTITION BY task_projects.project_id ORDER BY tasks.id ASC
                  ) AS row_number
           FROM task_projects JOIN tasks ON tasks.id = task_projects.task_id
           WHERE task_projects.project_id = ANY($1::text[])
         ) representatives WHERE row_number <= $2
         ORDER BY "projectId" ASC, row_number ASC`,
        [ids, REPRESENTATIVE_LIMIT],
      ),
      this.pool.query(
        `SELECT task_projects.project_id AS "projectId", COUNT(*)::int AS count,
                MAX(tasks.updated_at) AS latest
         FROM task_projects JOIN tasks ON tasks.id = task_projects.task_id
         WHERE task_projects.project_id = ANY($1::text[])
         GROUP BY task_projects.project_id`,
        [ids],
      ),
    ]);
    return rows.map((row) => {
      const count = (countResult.rows as Array<{
        projectId: string; count: number; latest: string | null;
      }>).find((item) => item.projectId === row.id);
      return {
        ...row,
        entityType: 'project',
        semanticEligible: !row.hidden,
        tags: (tagResult.rows as Array<{ projectId: string; name: string }>)
          .filter((item) => item.projectId === row.id).map((item) => item.name),
        representativeTasks: (taskResult.rows as Array<{
          projectId: string; title: string; connectorType: string;
        }>)
          .filter((item) => item.projectId === row.id).map((item) => item.title),
        representativeTaskConnectorTypes: (taskResult.rows as Array<{
          projectId: string; title: string; connectorType: string;
        }>)
          .filter((item) => item.projectId === row.id).map((item) => item.connectorType),
        taskCount: count?.count ?? 0,
        latestTaskUpdatedAt: count?.latest ?? null,
      };
    });
  }

  private async hydrateTags(rows: TagRow[]): Promise<SemanticTagSource[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [taskResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT "tagId", title, "connectorType" FROM (
           SELECT task_tags.tag_id AS "tagId", tasks.title,
                  tasks.connector_type AS "connectorType",
                  ROW_NUMBER() OVER (
                    PARTITION BY task_tags.tag_id ORDER BY tasks.id ASC
                  ) AS row_number
           FROM task_tags JOIN tasks ON tasks.id = task_tags.task_id
           WHERE task_tags.tag_id = ANY($1::text[])
         ) representatives WHERE row_number <= $2
         ORDER BY "tagId" ASC, row_number ASC`,
        [ids, REPRESENTATIVE_LIMIT],
      ),
      this.pool.query(
        `SELECT task_tags.tag_id AS "tagId", COUNT(*)::int AS count,
                MAX(tasks.updated_at) AS latest
         FROM task_tags JOIN tasks ON tasks.id = task_tags.task_id
         WHERE task_tags.tag_id = ANY($1::text[])
         GROUP BY task_tags.tag_id`,
        [ids],
      ),
    ]);
    return rows.map((row) => {
      const count = (countResult.rows as Array<{
        tagId: string; count: number; latest: string | null;
      }>).find((item) => item.tagId === row.id);
      return {
        ...row,
        entityType: 'tag',
        semanticEligible: row.confirmed && row.unifiedInto === null,
        representativeTasks: (taskResult.rows as Array<{
          tagId: string; title: string; connectorType: string;
        }>)
          .filter((item) => item.tagId === row.id).map((item) => item.title),
        representativeTaskConnectorTypes: (taskResult.rows as Array<{
          tagId: string; title: string; connectorType: string;
        }>)
          .filter((item) => item.tagId === row.id).map((item) => item.connectorType),
        usageCount: count?.count ?? 0,
        latestTaskUpdatedAt: count?.latest ?? null,
      };
    });
  }

  private tableAndEligibility(entityType: SemanticSourceEntityType): {
    table: string;
    eligibility: string;
  } {
    switch (entityType) {
      case 'task': return { table: 'tasks', eligibility: 'TRUE' };
      case 'project': return { table: 'hub_projects', eligibility: 'hidden = false' };
      case 'tag': return {
        table: 'tags',
        eligibility: 'confirmed = true AND unified_into IS NULL',
      };
      case 'triage-item': return { table: 'triage_items', eligibility: "status <> 'dismissed'" };
      case 'alert': return {
        table: 'notifications',
        eligibility: "source_state NOT IN ('deleted', 'stale')",
      };
      case 'houston-summary': return {
        table: 'houston_conversation_memories',
        eligibility: 'excluded_at IS NULL',
      };
    }
  }

  async listIds(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceIdPage> {
    const limit = boundedLimit(input.limit);
    const { table, eligibility } = this.tableAndEligibility(entityType);
    const result = await this.pool.query(
      `SELECT id FROM ${table} WHERE id > $1 AND ${eligibility} ORDER BY id ASC LIMIT $2`,
      [input.afterId ?? '', limit],
    );
    const ids = (result.rows as Array<{ id: string }>).map((row) => row.id);
    return {
      ids,
      nextCursor: ids.length === limit ? ids[ids.length - 1] : null,
    };
  }

  async list(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceRecordPage> {
    const limit = boundedLimit(input.limit);
    const after = input.afterId ?? '';

    if (entityType === 'alert') {
      const result = await this.pool.query(
        `SELECT ${ALERT_COLUMNS} FROM notifications
         WHERE id > $1 AND source_state NOT IN ('deleted', 'stale')
         ORDER BY id ASC LIMIT $2`,
        [after, limit],
      );
      const rows = result.rows as AlertRow[];
      return {
        records: rows.map((row) => ({
          ...row,
          entityType: 'alert' as const,
          semanticEligible: true,
          isActionable: toBoolean(row.isActionable),
        })),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    if (entityType === 'project') {
      const result = await this.pool.query(
        `SELECT ${PROJECT_COLUMNS} FROM hub_projects
         WHERE id > $1 AND hidden = false ORDER BY id ASC LIMIT $2`,
        [after, limit],
      );
      const rows = result.rows as ProjectRow[];
      return {
        records: await this.hydrateProjects(rows),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    if (entityType === 'tag') {
      const result = await this.pool.query(
        `SELECT ${TAG_COLUMNS} FROM tags
         WHERE id > $1 AND confirmed = true AND unified_into IS NULL
         ORDER BY id ASC LIMIT $2`,
        [after, limit],
      );
      const rows = result.rows as TagRow[];
      return {
        records: await this.hydrateTags(rows),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    if (entityType === 'triage-item') {
      const result = await this.pool.query(
        `SELECT ${TRIAGE_COLUMNS} FROM triage_items
         WHERE id > $1 AND status <> 'dismissed' ORDER BY id ASC LIMIT $2`,
        [after, limit],
      );
      const rows = result.rows as TriageRow[];
      return {
        records: rows.map((row) => this.toTriage(row)),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }
    if (entityType === 'houston-summary') {
      const result = await this.pool.query(
        `SELECT ${HOUSTON_SUMMARY_COLUMNS} FROM houston_conversation_memories
         WHERE id > $1 AND excluded_at IS NULL ORDER BY id ASC LIMIT $2`,
        [after, limit],
      );
      const rows = result.rows as HoustonSummaryRow[];
      return {
        records: rows.map((row) => ({
          ...row,
          entityType: 'houston-summary' as const,
          semanticEligible: true,
        })),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    const result = await this.pool.query(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id > $1 ORDER BY id ASC LIMIT $2`,
      [after, limit],
    );
    const rows = result.rows as TaskRow[];
    if (rows.length === 0) return { records: [], nextCursor: null };

    // One tag read per page, not per task.
    const tagResult = await this.pool.query(
      `
        SELECT task_tags.task_id AS "taskId", tags.name AS name
        FROM task_tags
        JOIN tags ON tags.id = task_tags.tag_id
        WHERE task_tags.task_id = ANY($1::text[])
      `,
      [rows.map((row) => row.id)],
    );
    const projectResult = await this.pool.query(
      `SELECT task_projects.task_id AS "taskId", hub_projects.name
       FROM task_projects
       JOIN hub_projects ON hub_projects.id = task_projects.project_id
       WHERE task_projects.task_id = ANY($1::text[]) AND hub_projects.hidden = false`,
      [rows.map((row) => row.id)],
    );
    const tagsByTask = new Map<string, string[]>();
    for (const tag of tagResult.rows as Array<{ taskId: string; name: string }>) {
      const existing = tagsByTask.get(tag.taskId);
      if (existing) existing.push(tag.name);
      else tagsByTask.set(tag.taskId, [tag.name]);
    }

    return {
      records: rows.map((row) => ({
        ...row,
        entityType: 'task' as const,
        semanticEligible: true,
        isChecklistItem: toBoolean(row.isChecklistItem),
        tags: tagsByTask.get(row.id) ?? [],
        projects: (projectResult.rows as Array<{ taskId: string; name: string }>)
          .filter((project) => project.taskId === row.id)
          .map((project) => project.name),
      })),
      nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  async listExisting(
    entityType: SemanticSourceEntityType,
    entityIds: string[],
  ): Promise<Set<string>> {
    if (entityIds.length === 0) return new Set();
    const { table, eligibility } = this.tableAndEligibility(entityType);
    const found = new Set<string>();
    for (let offset = 0; offset < entityIds.length; offset += MAX_PAGE) {
      const chunk = entityIds.slice(offset, offset + MAX_PAGE);
      const result = await this.pool.query(
        `SELECT id FROM ${table} WHERE id = ANY($1::text[]) AND ${eligibility}`,
        [chunk],
      );
      for (const row of result.rows as Array<{ id: string }>) found.add(row.id);
    }
    return found;
  }
}

export function createPostgresSemanticSourcePort(pool: Pool): SemanticSourcePort {
  return new PostgresSemanticSourcePort(pool);
}
