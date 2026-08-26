import type { Pool } from 'pg';
import type {
  KeywordSearchRepository,
  SearchFilters,
  SearchOptions,
  SearchResult,
  SearchableNotificationRecord,
  SearchableTaskRecord,
} from '@/lib/search/repository';

export function normalizeLimit(limit = 20): number {
  return Math.max(1, Math.min(limit, 50));
}

export function truncate(text: string | null | undefined, max = 160): string {
  const value = (text ?? '').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function buildTaskHref(id: string): string {
  return `/?taskId=${encodeURIComponent(id)}`;
}

function buildNotificationHref(id: string): string {
  return `/notifications?id=${encodeURIComponent(id)}`;
}

export function parseIssueNumberQuery(query: string): number | null {
  const match = query.match(/^#?(\d+)$/);
  if (!match) return null;
  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

interface TaskSearchRow {
  id: string;
  rawTitle: string;
  titleHl: string;
  descSnippet: string;
  rank: number;
  status: string;
  priority: string;
  sourceListName: string | null;
  connectorType: string;
  updatedAt: string;
}

interface NotificationSearchRow {
  id: string;
  rawTitle: string;
  titleHl: string;
  bodySnippet: string;
  rank: number;
  severity: string;
  category: string;
  isRead: boolean;
  connectorType: string;
  receivedAt: string;
}

function toTaskSearchResult(row: TaskSearchRow): SearchResult {
  return {
    type: 'task',
    id: row.id,
    title: row.rawTitle,
    snippet: row.descSnippet || truncate(row.sourceListName ?? row.connectorType),
    score: row.rank,
    source: 'fts',
    href: buildTaskHref(row.id),
    highlights: {
      title: row.titleHl,
      snippet: row.descSnippet || undefined,
    },
    metadata: {
      status: row.status,
      priority: row.priority,
      sourceListName: row.sourceListName,
      connectorType: row.connectorType,
      updatedAt: row.updatedAt,
      rank: row.rank,
    },
  };
}

function toNotificationSearchResult(row: NotificationSearchRow): SearchResult {
  return {
    type: 'notification',
    id: row.id,
    title: row.rawTitle,
    snippet: row.bodySnippet || truncate(row.category),
    score: row.rank,
    source: 'fts',
    href: buildNotificationHref(row.id),
    highlights: {
      title: row.titleHl,
      snippet: row.bodySnippet || undefined,
    },
    metadata: {
      severity: row.severity,
      category: row.category,
      isRead: row.isRead,
      isActionable: true,
      connectorType: row.connectorType,
      receivedAt: row.receivedAt,
      rank: row.rank,
    },
  };
}

async function searchTasksByIssueNumber(
  pool: Pool,
  issueNumber: number,
  limit: number,
  filters: SearchFilters,
): Promise<SearchResult[]> {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
  const result = await pool.query(
    `
      SELECT
        t.id,
        t.title,
        t.description,
        t.status,
        t.priority,
        t.source_list_name AS "sourceListName",
        t.connector_type AS "connectorType",
        t.updated_at AS "updatedAt"
      FROM tasks t
      WHERE t.connector_type = 'github-issues'
        AND t.source_id LIKE $1
        AND ($2::text IS NULL OR t.source_list_name = $2 OR t.connector_type = $2)
        AND ($3::text IS NULL OR t.status = $3)
        AND ($4::boolean = false OR LOWER(t.status) <> 'done')
      ORDER BY t.updated_at DESC
      LIMIT $5
    `,
    [`%:${issueNumber}`, source, status, filters.excludeDone === true, limit],
  );
  return result.rows.map((row: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    sourceListName: string | null;
    connectorType: string;
    updatedAt: string;
  }) => ({
    type: 'task' as const,
    id: row.id,
    title: row.title,
    snippet: truncate(row.description) || truncate(row.sourceListName),
    score: 2,
    source: 'fts' as const,
    href: buildTaskHref(row.id),
    highlights: {},
    metadata: {
      status: row.status,
      priority: row.priority,
      sourceListName: row.sourceListName,
      connectorType: row.connectorType,
      updatedAt: row.updatedAt,
      issueNumber,
    },
  }));
}

async function searchTasks(
  pool: Pool,
  tsQuery: string,
  limit: number,
  filters: SearchFilters,
): Promise<SearchResult[]> {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
  const result = await pool.query(
    `
      SELECT
        t.id AS id,
        t.title AS "rawTitle",
        COALESCE(
          ts_headline('english', t.title, websearch_to_tsquery('english', $1),
            'StartSel=<mark>, StopSel=</mark>, HighlightAll=true'),
          t.title
        ) AS "titleHl",
        COALESCE(
          NULLIF(ts_headline('english', COALESCE(d.description, ''), websearch_to_tsquery('english', $1),
            'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MinWords=5, MaxWords=24'), ''),
          ''
        ) AS "descSnippet",
        ts_rank_cd(d.search_vector, websearch_to_tsquery('english', $1)) AS rank,
        t.status,
        t.priority,
        t.source_list_name AS "sourceListName",
        t.connector_type AS "connectorType",
        t.updated_at AS "updatedAt"
      FROM task_search_documents d
      INNER JOIN tasks t ON t.id = d.id
      WHERE d.search_vector @@ websearch_to_tsquery('english', $1)
        AND ($2::text IS NULL OR t.source_list_name = $2 OR t.connector_type = $2)
        AND ($3::text IS NULL OR t.status = $3)
        AND ($4::boolean = false OR LOWER(t.status) <> 'done')
      ORDER BY rank DESC
      LIMIT $5
    `,
    [tsQuery, source, status, filters.excludeDone === true, limit],
  );
  return result.rows.map(toTaskSearchResult);
}

async function searchNotifications(
  pool: Pool,
  tsQuery: string,
  limit: number,
  filters: SearchFilters,
): Promise<SearchResult[]> {
  const source = filters.source ?? null;
  const status = filters.status ?? null;
  const result = await pool.query(
    `
      SELECT
        a.id AS id,
        a.title AS "rawTitle",
        COALESCE(
          ts_headline('english', a.title, websearch_to_tsquery('english', $1),
            'StartSel=<mark>, StopSel=</mark>, HighlightAll=true'),
          a.title
        ) AS "titleHl",
        COALESCE(
          NULLIF(ts_headline('english', COALESCE(d.body, ''), websearch_to_tsquery('english', $1),
            'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MinWords=5, MaxWords=24'), ''),
          ''
        ) AS "bodySnippet",
        ts_rank_cd(d.search_vector, websearch_to_tsquery('english', $1)) AS rank,
        a.level AS severity,
        a.category,
        (a.read_state = 'read') AS "isRead",
        a.connector_type AS "connectorType",
        a.received_at AS "receivedAt"
      FROM notification_search_documents d
      INNER JOIN notifications a ON a.id = d.id
      WHERE d.search_vector @@ websearch_to_tsquery('english', $1)
        AND ($2::text IS NULL OR a.connector_type = $2)
        AND ($3::text IS NULL OR a.category = $3)
        AND ($4::boolean = false OR LOWER(a.category) <> 'done')
      ORDER BY rank DESC
      LIMIT $5
    `,
    [tsQuery, source, status, filters.excludeDone === true, limit],
  );
  return result.rows.map(toNotificationSearchResult);
}

/**
 * PostgreSQL-backed implementation of the portable `KeywordSearchRepository`
 * contract. Unlike SQLite (which maintains its FTS5 mirror tables directly
 * against `better-sqlite3`), this adapter keeps its own PostgreSQL-only
 * `task_search_documents`/`notification_search_documents` tables (see
 * `src/db/postgres/schema/search-index.ts`) as an explicitly-maintained
 * keyword-search projection — the PostgreSQL analogue of SQLite's
 * `tasks_fts`/`alerts_fts` FTS5 virtual tables. `indexTask`/`indexNotification`
 * upsert *only* into that projection table; `removeTask`/`removeNotification`
 * delete *only* the matching projection row. Neither ever mutates or deletes
 * the authoritative `tasks`/`notifications` row — those remain the
 * exclusive responsibility of `PostgresTaskRepository`/
 * `PostgresNotificationRepository`. `search()` matches against the
 * projection's own `search_vector` (title/description/sourceListName/
 * connectorType for tasks; title/body/category/connectorType for
 * notifications) and INNER JOINs the live core table for authoritative,
 * always-fresh metadata (status/priority/updatedAt; severity/isRead/
 * receivedAt) — exactly mirroring how the SQLite adapter joins its FTS5
 * mirror against `tasks`/`notifications` at query time. The projection
 * tables' `id` foreign key cascades on delete, so deleting a task or
 * notification through its owning repository automatically removes the
 * matching search-document row too.
 */
export class PostgresKeywordSearchRepository implements KeywordSearchRepository {
  constructor(private readonly pool: Pool) {}

  async rebuild(): Promise<void> {
    await this.pool.query('TRUNCATE task_search_documents');
    await this.pool.query(`
      INSERT INTO task_search_documents (id, title, description, source_list_name, connector_type)
      SELECT id, title, description, source_list_name, connector_type FROM tasks
    `);
    await this.pool.query('TRUNCATE notification_search_documents');
    await this.pool.query(`
      INSERT INTO notification_search_documents (id, title, body, category, connector_type)
      SELECT id, title, body, category, connector_type FROM notifications
    `);
  }

  async indexTask(task: SearchableTaskRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO task_search_documents (id, title, description, source_list_name, connector_type)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          source_list_name = EXCLUDED.source_list_name,
          connector_type = EXCLUDED.connector_type
      `,
      [
        task.id,
        task.title,
        task.description ?? null,
        task.sourceListName ?? null,
        task.connectorType ?? null,
      ],
    );
  }

  async removeTask(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM task_search_documents WHERE id = $1', [taskId]);
  }

  async indexNotification(notification: SearchableNotificationRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO notification_search_documents (id, title, body, category, connector_type)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          category = EXCLUDED.category,
          connector_type = EXCLUDED.connector_type
      `,
      [
        notification.id,
        notification.title,
        notification.body ?? null,
        notification.category ?? null,
        notification.connectorType ?? null,
      ],
    );
  }

  async removeNotification(notificationId: string): Promise<void> {
    await this.pool.query('DELETE FROM notification_search_documents WHERE id = $1', [notificationId]);
  }

  async warmUp(): Promise<void> {
    await this.pool.query('SELECT 1 FROM task_search_documents LIMIT 1');
    await this.pool.query('SELECT 1 FROM notification_search_documents LIMIT 1');
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const type = options.type ?? 'all';
    const limit = normalizeLimit(options.limit);
    const issueNumber = parseIssueNumberQuery(normalizedQuery);
    const exactIssueResults = issueNumber !== null && (type === 'all' || type === 'tasks')
      ? await searchTasksByIssueNumber(this.pool, issueNumber, limit, options)
      : [];

    const [taskResults, notificationResults] = await Promise.all([
      type === 'all' || type === 'tasks'
        ? searchTasks(this.pool, normalizedQuery, limit, options)
        : Promise.resolve([]),
      type === 'all' || type === 'notifications'
        ? searchNotifications(this.pool, normalizedQuery, limit, options)
        : Promise.resolve([]),
    ]);

    const results = [...exactIssueResults, ...taskResults, ...notificationResults];
    const seen = new Set<string>();

    return results
      .filter((result) => {
        const key = `${result.type}:${result.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

/**
 * Stable construction point for composition roots: builds a
 * `KeywordSearchRepository` backed by PostgreSQL from a `pg` `Pool`
 * (typically `PostgresPersistenceBackend#context.pool` from
 * `@/db/postgres/runtime`), without callers needing to know the concrete
 * class.
 */
export function createPostgresKeywordSearchRepository(pool: Pool): KeywordSearchRepository {
  return new PostgresKeywordSearchRepository(pool);
}
