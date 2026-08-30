/**
 * PostgreSQL adapter for `SemanticSourcePort`.
 *
 * Column-for-column identical to `SqliteSemanticSourcePort`, so a projection
 * built on PostgreSQL matches one built on SQLite byte for byte. Read-only.
 */

import type { Pool } from 'pg';
import type {
  SemanticAlertSource,
  SemanticSourceEntityType,
  SemanticSourceIdPage,
  SemanticSourcePort,
  SemanticSourceRecord,
  SemanticSourceRecordPage,
  SemanticTaskSource,
} from '@/lib/semantic-index/source/contracts';

type TaskRow = Omit<SemanticTaskSource, 'entityType' | 'tags' | 'isChecklistItem'> & {
  isChecklistItem: boolean | number | null;
};

type AlertRow = Omit<SemanticAlertSource, 'entityType' | 'isActionable'> & {
  isActionable: boolean | number | null;
};

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

function toBoolean(value: boolean | number | null): boolean {
  return value === true || value === 1;
}

const MAX_PAGE = 1_000;

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
      return {
        ...row,
        entityType: 'task',
        isChecklistItem: toBoolean(row.isChecklistItem),
        tags: (tags.rows as Array<{ name: string }>).map((tag) => tag.name),
      };
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
      isActionable: toBoolean(row.isActionable),
    };
  }

  async listIds(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceIdPage> {
    const limit = boundedLimit(input.limit);
    const table = entityType === 'task' ? 'tasks' : 'notifications';
    const result = await this.pool.query(
      `SELECT id FROM ${table} WHERE id > $1 ORDER BY id ASC LIMIT $2`,
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
        `SELECT ${ALERT_COLUMNS} FROM notifications WHERE id > $1 ORDER BY id ASC LIMIT $2`,
        [after, limit],
      );
      const rows = result.rows as AlertRow[];
      return {
        records: rows.map((row) => ({
          ...row,
          entityType: 'alert' as const,
          isActionable: toBoolean(row.isActionable),
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
        isChecklistItem: toBoolean(row.isChecklistItem),
        tags: tagsByTask.get(row.id) ?? [],
      })),
      nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  async listExisting(
    entityType: SemanticSourceEntityType,
    entityIds: string[],
  ): Promise<Set<string>> {
    if (entityIds.length === 0) return new Set();
    const table = entityType === 'task' ? 'tasks' : 'notifications';
    const found = new Set<string>();
    for (let offset = 0; offset < entityIds.length; offset += MAX_PAGE) {
      const chunk = entityIds.slice(offset, offset + MAX_PAGE);
      const result = await this.pool.query(
        `SELECT id FROM ${table} WHERE id = ANY($1::text[])`,
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
