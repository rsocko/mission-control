import db, { sqlite } from '@/db';
import { notifications, tasks } from '@/db/schema';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import {
  mergeSearchFacetRows,
} from '@/lib/search/repository';
import { compareKeywordResults } from '@/lib/search/keyword-ranking';
import type {
  KeywordSearchRepository,
  SearchFacet,
  SearchFacets,
  SearchFilters,
  SearchResult,
  SearchScope,
  SearchableNotificationRecord,
  SearchableTaskRecord,
} from '@/lib/search/repository';

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

function parseIssueNumberQuery(query: string): number | null {
  const match = query.match(/^#?(\d+)$/);
  if (!match) return null;

  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
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

function searchTasks(
  query: string,
  queryText: string,
  limit: number,
  filters: SearchFilters,
): SearchResult[] {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
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
          CASE
            WHEN LOWER(TRIM(t.title)) = LOWER(TRIM(?)) THEN 0
            WHEN INSTR(LOWER(TRIM(t.title)), LOWER(TRIM(?))) = 1 THEN 1
            ELSE 2
          END AS title_match_rank,
          t.status,
          t.priority,
          t.due_date AS dueDate,
          t.source_list_name AS sourceListName,
          t.connector_type AS connectorType,
          t.updated_at AS updatedAt
        FROM tasks_fts
        INNER JOIN tasks t ON t.id = tasks_fts.entityId
        WHERE tasks_fts MATCH ?
          AND (? IS NULL OR t.source_list_name = ? OR t.connector_type = ?)
          AND (? IS NULL OR t.status = ?)
          AND (? IS NULL OR COALESCE(NULLIF(t.due_date, ''), t.updated_at) >= ?)
          AND (? IS NULL OR (
            t.due_date IS NOT NULL
            AND t.due_date <> ''
            AND t.due_date < ?
          ))
          AND (? = 0 OR LOWER(t.status) <> 'done')
          AND (? = 0 OR (
            t.parent_id IS NULL
            AND t.local_disposition = 'active'
            AND t.connector_type NOT IN (${NOTIFICATION_ONLY_CONNECTOR_TYPES.map(() => '?').join(', ')})
            AND t.connector_instance_id NOT IN (SELECT value FROM json_each(?))
          ))
        ORDER BY title_match_rank, rank, LOWER(t.title), t.id
        LIMIT ?
      `
    )
    .all(
      queryText,
      queryText,
      query,
      source,
      source,
      source,
      status,
      status,
      filters.dateFrom ?? null,
      filters.dateFrom ?? null,
      filters.dueBefore ?? null,
      filters.dueBefore ?? null,
      filters.excludeDone ? 1 : 0,
      filters.universeEligible ? 1 : 0,
      ...NOTIFICATION_ONLY_CONNECTOR_TYPES,
      JSON.stringify(filters.excludeConnectorInstanceIds ?? []),
      limit,
    ) as Array<{
      rowid: number;
      id: string;
      raw_title: string;
      title_hl: string;
      desc_snippet: string;
      rank: number;
      title_match_rank: number;
      status: string;
      priority: string;
      dueDate: string | null;
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
      ...(row.dueDate ? { dueDate: row.dueDate } : {}),
      sourceListName: row.sourceListName,
      connectorType: row.connectorType,
      updatedAt: row.updatedAt,
      rank: row.rank,
      titleMatchRank: row.title_match_rank,
      rowid: row.rowid,
    },
  }));
}

function searchTasksByIssueNumber(
  issueNumber: number,
  limit: number,
  filters: SearchFilters,
): SearchResult[] {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
  const sourceIdSuffix = `%:${issueNumber}`;
  const rows = sqlite
    .prepare(
      `
        SELECT
          t.id,
          t.title,
          t.description,
          t.status,
          t.priority,
          t.due_date AS dueDate,
          t.source_list_name AS sourceListName,
          t.connector_type AS connectorType,
          t.updated_at AS updatedAt
        FROM tasks t
        WHERE t.connector_type = 'github-issues'
          AND t.source_id LIKE ?
          AND (? IS NULL OR t.source_list_name = ? OR t.connector_type = ?)
          AND (? IS NULL OR t.status = ?)
          AND (? IS NULL OR COALESCE(NULLIF(t.due_date, ''), t.updated_at) >= ?)
          AND (? IS NULL OR (
            t.due_date IS NOT NULL
            AND t.due_date <> ''
            AND t.due_date < ?
          ))
          AND (? = 0 OR LOWER(t.status) <> 'done')
          AND (? = 0 OR (
            t.parent_id IS NULL
            AND t.local_disposition = 'active'
            AND t.connector_type NOT IN (${NOTIFICATION_ONLY_CONNECTOR_TYPES.map(() => '?').join(', ')})
            AND t.connector_instance_id NOT IN (SELECT value FROM json_each(?))
          ))
        ORDER BY t.updated_at DESC
        LIMIT ?
      `,
    )
    .all(
      sourceIdSuffix,
      source,
      source,
      source,
      status,
      status,
      filters.dateFrom ?? null,
      filters.dateFrom ?? null,
      filters.dueBefore ?? null,
      filters.dueBefore ?? null,
      filters.excludeDone ? 1 : 0,
      filters.universeEligible ? 1 : 0,
      ...NOTIFICATION_ONLY_CONNECTOR_TYPES,
      JSON.stringify(filters.excludeConnectorInstanceIds ?? []),
      limit,
    ) as Array<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      dueDate: string | null;
      sourceListName: string | null;
      connectorType: string;
      updatedAt: string;
    }>;

  return rows.map((row) => ({
    type: 'task',
    id: row.id,
    title: row.title,
    snippet: truncate(row.description) || truncate(row.sourceListName),
    score: 2,
    source: 'fts',
    href: buildTaskHref(row.id),
    highlights: {},
    metadata: {
      status: row.status,
      priority: row.priority,
      ...(row.dueDate ? { dueDate: row.dueDate } : {}),
      sourceListName: row.sourceListName,
      connectorType: row.connectorType,
      updatedAt: row.updatedAt,
      issueNumber,
      titleMatchRank: 0,
    },
  }));
}

function searchNotifications(
  query: string,
  queryText: string,
  limit: number,
  filters: SearchFilters,
): SearchResult[] {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
  const notificationKind = filters.notificationKind ?? null;
  const noteHint = `LOWER(
    COALESCE(a.category, '') || ' ' ||
    COALESCE(a.connector_type, '') || ' ' ||
    a.title || ' ' || COALESCE(a.body, '')
  )`;
  const noteMatch = `(
    INSTR(${noteHint}, 'capture') > 0
    OR INSTR(${noteHint}, 'note') > 0
    OR INSTR(${noteHint}, 'memo') > 0
    OR INSTR(${noteHint}, 'idea') > 0
    OR INSTR(${noteHint}, 'journal') > 0
  )`;
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
          CASE
            WHEN LOWER(TRIM(a.title)) = LOWER(TRIM(?)) THEN 0
            WHEN INSTR(LOWER(TRIM(a.title)), LOWER(TRIM(?))) = 1 THEN 1
            ELSE 2
          END AS title_match_rank,
          a.level AS severity,
          a.category,
          CASE WHEN a.state = 'read' THEN 1 ELSE 0 END AS isRead,
          1 AS isActionable,
          a.connector_type AS connectorType,
          a.received_at AS receivedAt,
          CASE WHEN ${noteMatch} THEN 1 ELSE 0 END AS isNote
        FROM alerts_fts
        INNER JOIN notifications a ON a.id = alerts_fts.entityId
        WHERE alerts_fts MATCH ?
          AND (? IS NULL OR a.connector_type = ?)
          AND (? IS NULL OR a.category = ?)
          AND (? IS NULL OR (? = 'notes' AND ${noteMatch}) OR (? = 'triage' AND NOT ${noteMatch}))
          AND (? IS NULL OR a.received_at >= ?)
          AND (? IS NULL)
          AND (? = 0 OR LOWER(a.category) <> 'done')
        ORDER BY title_match_rank, rank, LOWER(a.title), a.id
        LIMIT ?
      `
    )
    .all(
      queryText,
      queryText,
      query,
      source,
      source,
      status,
      status,
      notificationKind,
      notificationKind,
      notificationKind,
      filters.dateFrom ?? null,
      filters.dateFrom ?? null,
      filters.dueBefore ?? null,
      filters.excludeDone ? 1 : 0,
      limit,
    ) as Array<{
      rowid: number;
      id: string;
      raw_title: string;
      title_hl: string;
      body_snippet: string;
      rank: number;
      title_match_rank: number;
      severity: string;
      category: string;
      isRead: number;
      isActionable: number;
      connectorType: string;
      receivedAt: string;
      isNote: number;
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
      notificationKind: row.isNote ? 'notes' : 'triage',
      rank: row.rank,
      titleMatchRank: row.title_match_rank,
      rowid: row.rowid,
    },
  }));
}

function taskFacetRows(
  matchQuery: string,
  issueNumber: number | null,
  facet: 'source' | 'status',
  filters: SearchFilters,
): SearchFacet[] {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
  const valueExpression = facet === 'source'
    ? "COALESCE(NULLIF(t.source_list_name, ''), NULLIF(t.connector_type, ''))"
    : "NULLIF(t.status, '')";
  const exactIssueUnion = issueNumber === null
    ? ''
    : `
      UNION
      SELECT t.id, ${valueExpression} AS value
      FROM tasks t
      WHERE t.connector_type = 'github-issues'
        AND t.source_id LIKE ?
        AND (? IS NULL OR t.source_list_name = ? OR t.connector_type = ?)
        AND (? IS NULL OR t.status = ?)
        AND (? IS NULL OR COALESCE(NULLIF(t.due_date, ''), t.updated_at) >= ?)
        AND (? IS NULL OR (
          t.due_date IS NOT NULL
          AND t.due_date <> ''
          AND t.due_date < ?
        ))
        AND (? = 0 OR LOWER(t.status) <> 'done')
        AND (? = 0 OR (
          t.parent_id IS NULL
          AND t.local_disposition = 'active'
          AND t.connector_type NOT IN (${NOTIFICATION_ONLY_CONNECTOR_TYPES.map(() => '?').join(', ')})
          AND t.connector_instance_id NOT IN (SELECT value FROM json_each(?))
        ))
    `;
  const commonParameters = [
    source,
    source,
    source,
    status,
    status,
    filters.dateFrom ?? null,
    filters.dateFrom ?? null,
    filters.dueBefore ?? null,
    filters.dueBefore ?? null,
    filters.excludeDone ? 1 : 0,
    filters.universeEligible ? 1 : 0,
    ...NOTIFICATION_ONLY_CONNECTOR_TYPES,
    JSON.stringify(filters.excludeConnectorInstanceIds ?? []),
  ];
  const rows = sqlite.prepare(`
    WITH task_matches AS (
      SELECT t.id, ${valueExpression} AS value
      FROM tasks_fts
      INNER JOIN tasks t ON t.id = tasks_fts.entityId
      WHERE tasks_fts MATCH ?
        AND (? IS NULL OR t.source_list_name = ? OR t.connector_type = ?)
        AND (? IS NULL OR t.status = ?)
        AND (? IS NULL OR COALESCE(NULLIF(t.due_date, ''), t.updated_at) >= ?)
        AND (? IS NULL OR (
          t.due_date IS NOT NULL
          AND t.due_date <> ''
          AND t.due_date < ?
        ))
        AND (? = 0 OR LOWER(t.status) <> 'done')
        AND (? = 0 OR (
          t.parent_id IS NULL
          AND t.local_disposition = 'active'
          AND t.connector_type NOT IN (${NOTIFICATION_ONLY_CONNECTOR_TYPES.map(() => '?').join(', ')})
          AND t.connector_instance_id NOT IN (SELECT value FROM json_each(?))
        ))
      ${exactIssueUnion}
    )
    SELECT value, COUNT(*) AS count
    FROM task_matches
    WHERE value IS NOT NULL
    GROUP BY value
    ORDER BY count DESC, value COLLATE NOCASE
  `).all(
    matchQuery,
    ...commonParameters,
    ...(issueNumber === null
      ? []
      : [`%:${issueNumber}`, ...commonParameters]),
  ) as SearchFacet[];
  return rows;
}

function notificationFacetRows(
  matchQuery: string,
  facet: 'source' | 'status',
  filters: SearchFilters,
): SearchFacet[] {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
  const notificationKind = filters.notificationKind ?? null;
  const noteHint = `LOWER(
    COALESCE(a.category, '') || ' ' ||
    COALESCE(a.connector_type, '') || ' ' ||
    a.title || ' ' || COALESCE(a.body, '')
  )`;
  const noteMatch = `(
    INSTR(${noteHint}, 'capture') > 0
    OR INSTR(${noteHint}, 'note') > 0
    OR INSTR(${noteHint}, 'memo') > 0
    OR INSTR(${noteHint}, 'idea') > 0
    OR INSTR(${noteHint}, 'journal') > 0
  )`;
  const valueExpression = facet === 'source'
    ? "NULLIF(a.connector_type, '')"
    : "NULLIF(a.category, '')";
  return sqlite.prepare(`
    SELECT ${valueExpression} AS value, COUNT(*) AS count
    FROM alerts_fts
    INNER JOIN notifications a ON a.id = alerts_fts.entityId
    WHERE alerts_fts MATCH ?
      AND (? IS NULL OR a.connector_type = ?)
      AND (? IS NULL OR a.category = ?)
      AND (? IS NULL OR (? = 'notes' AND ${noteMatch}) OR (? = 'triage' AND NOT ${noteMatch}))
      AND (? IS NULL OR a.received_at >= ?)
      AND (? IS NULL)
      AND (? = 0 OR LOWER(a.category) <> 'done')
      AND ${valueExpression} IS NOT NULL
    GROUP BY value
    ORDER BY count DESC, value COLLATE NOCASE
  `).all(
    matchQuery,
    source,
    source,
    status,
    status,
    notificationKind,
    notificationKind,
    notificationKind,
    filters.dateFrom ?? null,
    filters.dateFrom ?? null,
    filters.dueBefore ?? null,
    filters.excludeDone ? 1 : 0,
  ) as SearchFacet[];
}

export async function searchFTSFacets(
  query: string,
  options: { type?: SearchScope; limit?: number } & SearchFilters = {},
): Promise<SearchFacets> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return { sources: [], statuses: [] };

  await ensureFTSReady();
  const type = options.type ?? 'all';
  const matchQuery = toMatchQuery(normalizedQuery);
  const issueNumber = parseIssueNumberQuery(normalizedQuery);
  const rowsFor = (facet: 'source' | 'status') => {
    const facetFilters = {
      ...options,
      ...(facet === 'source' ? { source: undefined } : { status: undefined }),
    };
    return [
    ...(type === 'all' || type === 'tasks'
      ? taskFacetRows(matchQuery, issueNumber, facet, facetFilters)
      : []),
    ...(type === 'all' || type === 'notifications'
      ? notificationFacetRows(matchQuery, facet, facetFilters)
      : []),
    ];
  };

  return {
    sources: mergeSearchFacetRows(rowsFor('source')),
    statuses: mergeSearchFacetRows(rowsFor('status')),
  };
}

export async function searchFTS(
  query: string,
  options: { type?: SearchScope; limit?: number } & SearchFilters = {},
): Promise<SearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  await ensureFTSReady();

  const type = options.type ?? 'all';
  const limit = normalizeLimit(options.limit);
  const matchQuery = toMatchQuery(normalizedQuery);
  const issueNumber = parseIssueNumberQuery(normalizedQuery);
  const exactIssueResults = issueNumber !== null && (type === 'all' || type === 'tasks')
    ? searchTasksByIssueNumber(issueNumber, limit, options)
    : [];

  const results = [
    ...exactIssueResults,
    ...(type === 'all' || type === 'tasks'
      ? searchTasks(matchQuery, normalizedQuery, limit, options)
      : []),
    ...(type === 'all' || type === 'notifications'
      ? searchNotifications(matchQuery, normalizedQuery, limit, options)
      : []),
  ];
  const seen = new Set<string>();

  return results
    .filter((result) => {
      const key = `${result.type}:${result.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareKeywordResults)
    .slice(0, limit);
}

export const sqliteKeywordSearchRepository: KeywordSearchRepository = {
  rebuild: rebuildSearchIndex,
  indexTask,
  removeTask: removeTaskFromIndex,
  indexNotification: indexAlert,
  removeNotification: removeAlertFromIndex,
  warmUp: warmUpFTS,
  search: searchFTS,
  facets: searchFTSFacets,
};
