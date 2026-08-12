import db, { sqlite } from '@/db';
import { notifications, tasks } from '@/db/schema';

type SearchScope = 'tasks' | 'notifications' | 'all';

export interface SearchResult {
  type: 'task' | 'notification';
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: 'fts' | 'semantic' | 'hybrid';
  href: string;
  highlights?: {
    title?: string;
    snippet?: string;
  };
  metadata: Record<string, unknown>;
}

export interface SearchableTaskRecord {
  id: string;
  title: string;
  description?: string | null;
  sourceListName?: string | null;
  connectorType?: string | null;
  status?: string | null;
  priority?: string | null;
  updatedAt?: string | null;
}

export interface SearchableNotificationRecord {
  id: string;
  title: string;
  body?: string | null;
  category?: string | null;
  severity?: string | null;
  isRead?: boolean | null;
  isActionable?: boolean | null;
  connectorType?: string | null;
  receivedAt?: string | null;
}

const CREATE_TASKS_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
    title,
    description,
    sourceListName,
    connectorType,
    entityId UNINDEXED
  );
`;

const CREATE_ALERTS_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS alerts_fts USING fts5(
    title,
    body,
    category,
    entityId UNINDEXED
  );
`;

let ftsReady = false;

function tableExists(name: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name);
  return Boolean(row);
}

function normalizeLimit(limit = 20) {
  return Math.max(1, Math.min(limit, 50));
}

function truncate(text: string | null | undefined, max = 160) {
  const value = (text ?? '').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function buildTaskHref(id: string) {
  return `/?taskId=${encodeURIComponent(id)}`;
}

function buildNotificationHref(id: string) {
  return `/notifications?id=${encodeURIComponent(id)}`;
}

function normalizeFTSScore(rank: number) {
  return 1 / (1 + Math.abs(rank));
}

function toMatchQuery(query: string) {
  // Check for user-provided quoted phrases
  const phrases: string[] = [];
  const withoutPhrases = query.replace(/"([^"]+)"/g, (_, phrase) => {
    phrases.push(phrase.replace(/"/g, '""'));
    return '';
  });

  const terms = withoutPhrases.match(/[\p{L}\p{N}_-]+/gu) ?? [];

  if (terms.length === 0 && phrases.length === 0) {
    return `"${query.replace(/"/g, '""')}"`;
  }

  const parts: string[] = [];

  // Each quoted phrase is matched exactly
  for (const phrase of phrases) {
    parts.push(`"${phrase}"`);
  }

  // Individual terms use prefix matching and are AND-joined
  // so all terms must appear for a result to match
  for (const term of terms) {
    parts.push(`"${term.replace(/"/g, '""')}"*`);
  }

  return parts.join(' AND ');
}

function ftsRowCount(table: string): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
    .get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function mainTableHasRows(): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM tasks LIMIT 1")
    .get();
  return Boolean(row);
}

async function ensureFTSReady() {
  if (ftsReady) {
    return;
  }

  const tasksExists = tableExists('tasks_fts');
  const alertsExists = tableExists('alerts_fts');

  sqlite.exec(CREATE_TASKS_FTS);
  sqlite.exec(CREATE_ALERTS_FTS);

  if (!tasksExists || !alertsExists) {
    await rebuildSearchIndex();
  } else if (ftsRowCount('tasks_fts') === 0 && mainTableHasRows()) {
    // Tables exist but are empty while main tables have data — rebuild
    await rebuildSearchIndex();
  } else {
    ftsReady = true;
  }
}

function insertTaskRecord(task: SearchableTaskRecord) {
  sqlite.prepare('DELETE FROM tasks_fts WHERE entityId = ?').run(task.id);
  sqlite
    .prepare(`
      INSERT INTO tasks_fts (title, description, sourceListName, connectorType, entityId)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      task.title,
      task.description ?? '',
      task.sourceListName ?? '',
      task.connectorType ?? '',
      task.id,
    );
}

function insertAlertRecord(notification: SearchableNotificationRecord) {
  sqlite.prepare('DELETE FROM alerts_fts WHERE entityId = ?').run(notification.id);
  sqlite
    .prepare(`
      INSERT INTO alerts_fts (title, body, category, entityId)
      VALUES (?, ?, ?, ?)
    `)
    .run(
      notification.title,
      notification.body ?? '',
      notification.category ?? '',
      notification.id,
    );
}

export async function rebuildSearchIndex() {
  sqlite.exec('DROP TABLE IF EXISTS tasks_fts;');
  sqlite.exec('DROP TABLE IF EXISTS alerts_fts;');
  sqlite.exec(CREATE_TASKS_FTS);
  sqlite.exec(CREATE_ALERTS_FTS);

  const taskRows = await db.select().from(tasks);
  const notificationRows = await db.select().from(notifications);

  const taskTx = sqlite.transaction((rows: SearchableTaskRecord[]) => {
    for (const row of rows) {
      insertTaskRecord(row);
    }
  });

  const alertTx = sqlite.transaction((rows: SearchableNotificationRecord[]) => {
    for (const row of rows) {
      insertAlertRecord(row);
    }
  });

  taskTx(taskRows);
  alertTx(notificationRows);
  ftsReady = true;
}

export async function indexTask(task: SearchableTaskRecord) {
  await ensureFTSReady();
  insertTaskRecord(task);
}

export async function removeTaskFromIndex(taskId: string) {
  await ensureFTSReady();
  sqlite.prepare('DELETE FROM tasks_fts WHERE entityId = ?').run(taskId);
}

export async function indexAlert(alert: SearchableNotificationRecord) {
  await ensureFTSReady();
  insertAlertRecord(alert);
}

export async function removeAlertFromIndex(alertId: string) {
  await ensureFTSReady();
  sqlite.prepare('DELETE FROM alerts_fts WHERE entityId = ?').run(alertId);
}

/** Pre-warm FTS tables so first search has no cold start. */
export async function warmUpFTS() {
  await ensureFTSReady();
}

function searchTasks(query: string, limit: number): SearchResult[] {
  const rows = sqlite
    .prepare(
      `
        SELECT
          tasks_fts.rowid AS rowid,
          tasks_fts.entityId AS id,
          t.title AS raw_title,
          COALESCE(highlight(tasks_fts, 0, '<mark>', '</mark>'), t.title) AS title_hl,
          COALESCE(NULLIF(snippet(tasks_fts, 1, '<mark>', '</mark>', '...', 24), ''), '') AS desc_snippet,
          bm25(tasks_fts, 10.0, 4.0, 2.0, 1.0) AS rank,
          t.status,
          t.priority,
          t.source_list_name AS sourceListName,
          t.connector_type AS connectorType,
          t.updated_at AS updatedAt
        FROM tasks_fts
        INNER JOIN tasks t ON t.id = tasks_fts.entityId
        WHERE tasks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `
    )
    .all(query, limit) as Array<{
      rowid: number;
      id: string;
      raw_title: string;
      title_hl: string;
      desc_snippet: string;
      rank: number;
      status: string;
      priority: string;
      sourceListName: string | null;
      connectorType: string;
      updatedAt: string;
    }>;

  return rows.map((row) => ({
    type: 'task',
    id: row.id,
    title: row.raw_title,
    snippet: row.desc_snippet || truncate(row.sourceListName ?? row.connectorType),
    score: normalizeFTSScore(row.rank),
    source: 'fts',
    href: buildTaskHref(row.id),
    highlights: {
      title: row.title_hl,
      snippet: row.desc_snippet || undefined,
    },
    metadata: {
      status: row.status,
      priority: row.priority,
      sourceListName: row.sourceListName,
      connectorType: row.connectorType,
      updatedAt: row.updatedAt,
      rank: row.rank,
      rowid: row.rowid,
    },
  }));
}

function searchNotifications(query: string, limit: number): SearchResult[] {
  const rows = sqlite
    .prepare(
      `
        SELECT
          alerts_fts.rowid AS rowid,
          alerts_fts.entityId AS id,
          a.title AS raw_title,
          COALESCE(highlight(alerts_fts, 0, '<mark>', '</mark>'), a.title) AS title_hl,
          COALESCE(NULLIF(snippet(alerts_fts, 1, '<mark>', '</mark>', '...', 24), ''), '') AS body_snippet,
          bm25(alerts_fts, 10.0, 4.0, 2.0) AS rank,
          a.level AS severity,
          a.category,
          CASE WHEN a.state = 'read' THEN 1 ELSE 0 END AS isRead,
          1 AS isActionable,
          a.connector_type AS connectorType,
          a.received_at AS receivedAt
        FROM alerts_fts
        INNER JOIN notifications a ON a.id = alerts_fts.entityId
        WHERE alerts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `
    )
    .all(query, limit) as Array<{
      rowid: number;
      id: string;
      raw_title: string;
      title_hl: string;
      body_snippet: string;
      rank: number;
      severity: string;
      category: string;
      isRead: number;
      isActionable: number;
      connectorType: string;
      receivedAt: string;
    }>;

  return rows.map((row) => ({
    type: 'notification',
    id: row.id,
    title: row.raw_title,
    snippet: row.body_snippet || truncate(row.category),
    score: normalizeFTSScore(row.rank),
    source: 'fts',
    href: buildNotificationHref(row.id),
    highlights: {
      title: row.title_hl,
      snippet: row.body_snippet || undefined,
    },
    metadata: {
      severity: row.severity,
      category: row.category,
      isRead: Boolean(row.isRead),
      isActionable: Boolean(row.isActionable),
      connectorType: row.connectorType,
      receivedAt: row.receivedAt,
      rank: row.rank,
      rowid: row.rowid,
    },
  }));
}

export async function searchFTS(
  query: string,
  options: { type?: SearchScope; limit?: number } = {},
): Promise<SearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  await ensureFTSReady();

  const type = options.type ?? 'all';
  const limit = normalizeLimit(options.limit);
  const matchQuery = toMatchQuery(normalizedQuery);

  const results = [
    ...(type === 'all' || type === 'tasks' ? searchTasks(matchQuery, limit) : []),
    ...(type === 'all' || type === 'notifications' ? searchNotifications(matchQuery, limit) : []),
  ];

  return results
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
