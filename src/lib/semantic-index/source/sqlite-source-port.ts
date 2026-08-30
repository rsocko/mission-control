/**
 * SQLite adapter for `SemanticSourcePort`.
 *
 * Reads the authoritative `tasks` / `notifications` tables (plus the task tag
 * join) with the same column set the PostgreSQL adapter reads, so a projection
 * produced on either backend is identical. Nothing here writes.
 */

import type Database from 'better-sqlite3';
import type {
  SemanticAlertSource,
  SemanticSourceEntityType,
  SemanticSourceIdPage,
  SemanticSourcePort,
  SemanticSourceRecord,
  SemanticSourceRecordPage,
  SemanticTaskSource,
} from './contracts';

type SqliteDatabase = Database.Database;

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  statusReason: string | null;
  microStatus: string | null;
  priority: string;
  planningHorizon: string | null;
  localDisposition: string;
  effort: number | null;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  parentId: string | null;
  isChecklistItem: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface AlertRow {
  id: string;
  title: string;
  body: string | null;
  level: string;
  category: string;
  state: string;
  readState: string;
  disposition: string;
  sourceState: string;
  connectorType: string;
  isActionable: number;
  receivedAt: string;
  sortAt: string;
  expiresAt: string | null;
  lastSourceActivityAt: string | null;
  readAt: string | null;
  handledAt: string | null;
  resolvedAt: string | null;
  archivedAt: string | null;
  dismissedAt: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
}

const TASK_COLUMNS = `
  id,
  title,
  description,
  status,
  status_reason AS statusReason,
  micro_status AS microStatus,
  priority,
  planning_horizon AS planningHorizon,
  local_disposition AS localDisposition,
  effort,
  due_date AS dueDate,
  connector_type AS connectorType,
  source_list_name AS sourceListName,
  parent_id AS parentId,
  is_checklist_item AS isChecklistItem,
  created_at AS createdAt,
  updated_at AS updatedAt,
  completed_at AS completedAt
`;

const ALERT_COLUMNS = `
  id,
  title,
  body,
  level,
  category,
  state,
  read_state AS readState,
  disposition,
  source_state AS sourceState,
  connector_type AS connectorType,
  is_actionable AS isActionable,
  received_at AS receivedAt,
  sort_at AS sortAt,
  expires_at AS expiresAt,
  last_source_activity_at AS lastSourceActivityAt,
  read_at AS readAt,
  handled_at AS handledAt,
  resolved_at AS resolvedAt,
  archived_at AS archivedAt,
  dismissed_at AS dismissedAt,
  related_task_id AS relatedTaskId,
  related_project_id AS relatedProjectId
`;

function toTask(row: TaskRow, tags: string[]): SemanticTaskSource {
  return {
    entityType: 'task',
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    statusReason: row.statusReason,
    microStatus: row.microStatus,
    priority: row.priority,
    planningHorizon: row.planningHorizon,
    localDisposition: row.localDisposition,
    effort: row.effort,
    dueDate: row.dueDate,
    connectorType: row.connectorType,
    sourceListName: row.sourceListName,
    parentId: row.parentId,
    isChecklistItem: row.isChecklistItem === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    tags,
  };
}

function toAlert(row: AlertRow): SemanticAlertSource {
  return {
    entityType: 'alert',
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    category: row.category,
    state: row.state,
    readState: row.readState,
    disposition: row.disposition,
    sourceState: row.sourceState,
    connectorType: row.connectorType,
    isActionable: row.isActionable === 1,
    receivedAt: row.receivedAt,
    sortAt: row.sortAt,
    expiresAt: row.expiresAt,
    lastSourceActivityAt: row.lastSourceActivityAt,
    readAt: row.readAt,
    handledAt: row.handledAt,
    resolvedAt: row.resolvedAt,
    archivedAt: row.archivedAt,
    dismissedAt: row.dismissedAt,
    relatedTaskId: row.relatedTaskId,
    relatedProjectId: row.relatedProjectId,
  };
}

/** Guards against an unbounded `IN (...)` list or `LIMIT`. */
const MAX_PAGE = 1_000;

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 1;
  return Math.min(limit, MAX_PAGE);
}

export class SqliteSemanticSourcePort implements SemanticSourcePort {
  constructor(private readonly db: SqliteDatabase) {}

  async get(
    entityType: SemanticSourceEntityType,
    entityId: string,
  ): Promise<SemanticSourceRecord | null> {
    if (entityType === 'task') {
      const row = this.db
        .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
        .get(entityId) as TaskRow | undefined;
      if (!row) return null;
      const tags = this.db.prepare(`
        SELECT tags.name AS name
        FROM task_tags
        JOIN tags ON tags.id = task_tags.tag_id
        WHERE task_tags.task_id = ?
      `).all(entityId) as Array<{ name: string }>;
      return toTask(row, tags.map((tag) => tag.name));
    }

    const row = this.db
      .prepare(`SELECT ${ALERT_COLUMNS} FROM notifications WHERE id = ?`)
      .get(entityId) as AlertRow | undefined;
    return row ? toAlert(row) : null;
  }

  async listIds(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceIdPage> {
    const limit = boundedLimit(input.limit);
    const table = entityType === 'task' ? 'tasks' : 'notifications';
    const rows = this.db.prepare(`
      SELECT id FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?
    `).all(input.afterId ?? '', limit) as Array<{ id: string }>;
    const ids = rows.map((row) => row.id);
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
      const rows = this.db.prepare(`
        SELECT ${ALERT_COLUMNS} FROM notifications WHERE id > ? ORDER BY id ASC LIMIT ?
      `).all(after, limit) as AlertRow[];
      return {
        records: rows.map(toAlert),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    const rows = this.db.prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks WHERE id > ? ORDER BY id ASC LIMIT ?
    `).all(after, limit) as TaskRow[];
    if (rows.length === 0) return { records: [], nextCursor: null };

    // One tag read per page, not per task.
    const placeholders = rows.map(() => '?').join(', ');
    const tagRows = this.db.prepare(`
      SELECT task_tags.task_id AS taskId, tags.name AS name
      FROM task_tags
      JOIN tags ON tags.id = task_tags.tag_id
      WHERE task_tags.task_id IN (${placeholders})
    `).all(...rows.map((row) => row.id)) as Array<{ taskId: string; name: string }>;
    const tagsByTask = new Map<string, string[]>();
    for (const tag of tagRows) {
      const existing = tagsByTask.get(tag.taskId);
      if (existing) existing.push(tag.name);
      else tagsByTask.set(tag.taskId, [tag.name]);
    }

    return {
      records: rows.map((row) => toTask(row, tagsByTask.get(row.id) ?? [])),
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
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})`)
        .all(...chunk) as Array<{ id: string }>;
      for (const row of rows) found.add(row.id);
    }
    return found;
  }
}
