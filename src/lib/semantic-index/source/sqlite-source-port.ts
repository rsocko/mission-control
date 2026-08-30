/**
 * SQLite adapter for `SemanticSourcePort`.
 *
 * Reads authoritative domain tables with the same column sets and eligibility
 * rules as the PostgreSQL adapter. Nothing here writes.
 */

import type Database from 'better-sqlite3';
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

type ProjectRow = Omit<
  SemanticProjectSource,
  | 'entityType'
  | 'semanticEligible'
  | 'hidden'
  | 'tags'
  | 'representativeTasks'
  | 'representativeTaskConnectorTypes'
  | 'taskCount'
  | 'latestTaskUpdatedAt'
> & { hidden: number };

type TagRow = Omit<
  SemanticTagSource,
  | 'entityType'
  | 'semanticEligible'
  | 'confirmed'
  | 'representativeTasks'
  | 'representativeTaskConnectorTypes'
  | 'usageCount'
  | 'latestTaskUpdatedAt'
> & { confirmed: number };

type TriageRow = Omit<
  SemanticTriageItemSource,
  'entityType' | 'semanticEligible' | 'aiCategories'
> & {
  aiCategories: string;
};

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

type HoustonSummaryRow = Omit<
  SemanticHoustonSummarySource,
  'entityType' | 'semanticEligible' | 'decisions' | 'commitments' | 'topics' | 'linkedEntities'
> & {
  decisions: string;
  commitments: string;
  topics: string;
  linkedEntities: string;
};

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

const PROJECT_COLUMNS = `
  id, name, description, status, status_override AS statusOverride,
  hidden, category, target_date AS targetDate, started_at AS startedAt,
  completed_at AS completedAt, created_at AS createdAt, updated_at AS updatedAt
`;

const TAG_COLUMNS = `
  id, name, slug, type, source, confirmed, created_at AS createdAt,
  unified_into AS unifiedInto
`;

const TRIAGE_COLUMNS = `
  id, source_platform AS sourcePlatform, title, description,
  content_type AS contentType, captured_at AS capturedAt, ingested_at AS ingestedAt,
  status, snoozed_until AS snoozedUntil, ai_summary AS aiSummary,
  ai_categories AS aiCategories, ai_relevance_score AS aiRelevanceScore,
  ai_urgency AS aiUrgency
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

const HOUSTON_SUMMARY_COLUMNS = `
  id, authorization_scope AS authorizationScope, title, summary, decisions,
  commitments, topics, linked_entities AS linkedEntities, sensitivity,
  retain_until AS retainUntil, excluded_at AS excludedAt,
  created_at AS createdAt, updated_at AS updatedAt
`;

function toTask(row: TaskRow, tags: string[]): SemanticTaskSource {
  return {
    entityType: 'task',
    semanticEligible: true,
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
    projects: [],
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toTriage(row: TriageRow): SemanticTriageItemSource {
  return {
    ...row,
    entityType: 'triage-item',
    semanticEligible: row.status !== 'dismissed',
    aiCategories: parseStringArray(row.aiCategories),
  };
}

function toAlert(row: AlertRow): SemanticAlertSource {
  return {
    entityType: 'alert',
    semanticEligible: row.sourceState !== 'deleted' && row.sourceState !== 'stale',
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

function toHoustonSummary(row: HoustonSummaryRow): SemanticHoustonSummarySource {
  const links = (() => {
    try {
      const parsed = JSON.parse(row.linkedEntities) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is SemanticHoustonSummarySource['linkedEntities'][number] =>
            typeof item === 'object' && item !== null
            && ['task', 'project', 'tag'].includes(String((item as { type?: unknown }).type))
            && typeof (item as { id?: unknown }).id === 'string'
            && typeof (item as { label?: unknown }).label === 'string')
        : [];
    } catch {
      return [];
    }
  })();
  return {
    ...row,
    entityType: 'houston-summary',
    semanticEligible: row.excludedAt === null,
    decisions: parseStringArray(row.decisions),
    commitments: parseStringArray(row.commitments),
    topics: parseStringArray(row.topics),
    linkedEntities: links,
  };
}

/** Guards against an unbounded `IN (...)` list or `LIMIT`. */
const MAX_PAGE = 1_000;
const REPRESENTATIVE_LIMIT = 5;

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
      const projects = this.db.prepare(`
        SELECT hub_projects.name AS name
        FROM task_projects
        JOIN hub_projects ON hub_projects.id = task_projects.project_id
        WHERE task_projects.task_id = ? AND hub_projects.hidden = 0
      `).all(entityId) as Array<{ name: string }>;
      return { ...toTask(row, tags.map((tag) => tag.name)), projects: projects.map((p) => p.name) };
    }
    if (entityType === 'project') {
      const row = this.db.prepare(`
        SELECT ${PROJECT_COLUMNS} FROM hub_projects WHERE id = ?
      `).get(entityId) as ProjectRow | undefined;
      if (!row) return null;
      return this.hydrateProjects([row])[0];
    }
    if (entityType === 'tag') {
      const row = this.db.prepare(`
        SELECT ${TAG_COLUMNS} FROM tags
        WHERE id = ?
      `).get(entityId) as TagRow | undefined;
      if (!row) return null;
      return this.hydrateTags([row])[0];
    }
    if (entityType === 'triage-item') {
      const row = this.db.prepare(`
        SELECT ${TRIAGE_COLUMNS} FROM triage_items WHERE id = ?
      `).get(entityId) as TriageRow | undefined;
      return row ? toTriage(row) : null;
    }
    if (entityType === 'houston-summary') {
      const row = this.db.prepare(`
        SELECT ${HOUSTON_SUMMARY_COLUMNS}
        FROM houston_conversation_memories WHERE id = ?
      `).get(entityId) as HoustonSummaryRow | undefined;
      return row ? toHoustonSummary(row) : null;
    }

    const row = this.db
      .prepare(`SELECT ${ALERT_COLUMNS} FROM notifications WHERE id = ?`)
      .get(entityId) as AlertRow | undefined;
    return row ? toAlert(row) : null;
  }

  private hydrateProjects(rows: ProjectRow[]): SemanticProjectSource[] {
    return rows.map((row) => {
      const tags = this.db.prepare(`
        SELECT tags.name AS name FROM project_tags
        JOIN tags ON tags.id = project_tags.tag_id
        WHERE project_tags.project_id = ?
      `).all(row.id) as Array<{ name: string }>;
      const tasks = this.db.prepare(`
        SELECT tasks.title AS title, tasks.connector_type AS connectorType,
               tasks.updated_at AS updatedAt
        FROM task_projects JOIN tasks ON tasks.id = task_projects.task_id
        WHERE task_projects.project_id = ?
        ORDER BY tasks.id ASC LIMIT ?
      `).all(row.id, REPRESENTATIVE_LIMIT) as Array<{
        title: string; connectorType: string; updatedAt: string;
      }>;
      const count = this.db.prepare(`
        SELECT COUNT(*) AS count, MAX(tasks.updated_at) AS latest
        FROM task_projects JOIN tasks ON tasks.id = task_projects.task_id
        WHERE task_projects.project_id = ?
      `).get(row.id) as { count: number; latest: string | null };
      return {
        ...row,
        entityType: 'project',
        semanticEligible: row.hidden !== 1,
        hidden: row.hidden === 1,
        tags: tags.map((tag) => tag.name),
        representativeTasks: tasks.map((task) => task.title),
        representativeTaskConnectorTypes: tasks.map((task) => task.connectorType),
        taskCount: count.count,
        latestTaskUpdatedAt: count.latest,
      };
    });
  }

  private hydrateTags(rows: TagRow[]): SemanticTagSource[] {
    return rows.map((row) => {
      const tasks = this.db.prepare(`
        SELECT tasks.title AS title, tasks.connector_type AS connectorType
        FROM task_tags JOIN tasks ON tasks.id = task_tags.task_id
        WHERE task_tags.tag_id = ?
        ORDER BY tasks.id ASC LIMIT ?
      `).all(row.id, REPRESENTATIVE_LIMIT) as Array<{ title: string; connectorType: string }>;
      const count = this.db.prepare(`
        SELECT COUNT(*) AS count, MAX(tasks.updated_at) AS latest
        FROM task_tags JOIN tasks ON tasks.id = task_tags.task_id
        WHERE task_tags.tag_id = ?
      `).get(row.id) as { count: number; latest: string | null };
      return {
        ...row,
        entityType: 'tag',
        semanticEligible: row.confirmed === 1 && row.unifiedInto === null,
        confirmed: row.confirmed === 1,
        usageCount: count.count,
        representativeTasks: tasks.map((task) => task.title),
        representativeTaskConnectorTypes: tasks.map((task) => task.connectorType),
        latestTaskUpdatedAt: count.latest,
      };
    });
  }

  private tableAndEligibility(entityType: SemanticSourceEntityType): {
    table: string;
    eligibility: string;
  } {
    switch (entityType) {
      case 'task': return { table: 'tasks', eligibility: '1 = 1' };
      case 'project': return { table: 'hub_projects', eligibility: 'hidden = 0' };
      case 'tag': return { table: 'tags', eligibility: 'confirmed = 1 AND unified_into IS NULL' };
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
    const rows = this.db.prepare(`
      SELECT id FROM ${table} WHERE id > ? AND ${eligibility} ORDER BY id ASC LIMIT ?
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
        SELECT ${ALERT_COLUMNS} FROM notifications
        WHERE id > ? AND source_state NOT IN ('deleted', 'stale')
        ORDER BY id ASC LIMIT ?
      `).all(after, limit) as AlertRow[];
      return {
        records: rows.map(toAlert),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    if (entityType === 'project') {
      const rows = this.db.prepare(`
        SELECT ${PROJECT_COLUMNS} FROM hub_projects
        WHERE id > ? AND hidden = 0 ORDER BY id ASC LIMIT ?
      `).all(after, limit) as ProjectRow[];
      return {
        records: this.hydrateProjects(rows),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    if (entityType === 'tag') {
      const rows = this.db.prepare(`
        SELECT ${TAG_COLUMNS} FROM tags
        WHERE id > ? AND confirmed = 1 AND unified_into IS NULL
        ORDER BY id ASC LIMIT ?
      `).all(after, limit) as TagRow[];
      return {
        records: this.hydrateTags(rows),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }

    if (entityType === 'triage-item') {
      const rows = this.db.prepare(`
        SELECT ${TRIAGE_COLUMNS} FROM triage_items
        WHERE id > ? AND status <> 'dismissed' ORDER BY id ASC LIMIT ?
      `).all(after, limit) as TriageRow[];
      return {
        records: rows.map(toTriage),
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      };
    }
    if (entityType === 'houston-summary') {
      const rows = this.db.prepare(`
        SELECT ${HOUSTON_SUMMARY_COLUMNS} FROM houston_conversation_memories
        WHERE id > ? AND excluded_at IS NULL ORDER BY id ASC LIMIT ?
      `).all(after, limit) as HoustonSummaryRow[];
      return {
        records: rows.map(toHoustonSummary),
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

    const projectRows = this.db.prepare(`
      SELECT task_projects.task_id AS taskId, hub_projects.name AS name
      FROM task_projects
      JOIN hub_projects ON hub_projects.id = task_projects.project_id
      WHERE task_projects.task_id IN (${placeholders}) AND hub_projects.hidden = 0
    `).all(...rows.map((row) => row.id)) as Array<{ taskId: string; name: string }>;
    const projectsByTask = new Map<string, string[]>();
    for (const project of projectRows) {
      const existing = projectsByTask.get(project.taskId);
      if (existing) existing.push(project.name);
      else projectsByTask.set(project.taskId, [project.name]);
    }
    return {
      records: rows.map((row) => ({
        ...toTask(row, tagsByTask.get(row.id) ?? []),
        projects: projectsByTask.get(row.id) ?? [],
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
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders}) AND ${eligibility}`)
        .all(...chunk) as Array<{ id: string }>;
      for (const row of rows) found.add(row.id);
    }
    return found;
  }
}
