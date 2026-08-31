import type Database from 'better-sqlite3';
import type {
  TriageActionRecord,
  TriageItem,
  TriageSuggestedAction,
} from '@/types';
import {
  assertValidTriageCaptureBatch,
  assertValidTriageSyncRun,
  type GitHubCredentialFallbackRepository,
  type TriageCaptureOutcome,
  type TriageCaptureRepository,
  type TriagePersistenceRepositories,
  type TriageSyncRunInput,
  type TriageSyncRunResult,
  type TriageSyncStateRecord,
  type TriageSyncStateRepository,
} from './triage-repositories';

type SqliteDatabase = Database.Database;

interface TriageItemRow {
  id: string;
  source_platform: string;
  source_id: string;
  source_url: string;
  canonical_url: string | null;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  content_type: string;
  captured_at: string;
  ingested_at: string;
  status: string;
  snoozed_until: string | null;
  ai_summary: string | null;
  ai_categories: unknown;
  ai_suggested_actions: unknown;
  ai_relevance_score: number;
  ai_urgency: string;
  raw_metadata: unknown;
  actions_taken: unknown;
  source_order: number | null;
}

interface TriageSyncStateRow {
  id: string;
  last_cursor: string | null;
  last_synced_at: string | null;
  total_imported: number;
  total_skipped: number;
  last_run_imported: number;
  last_run_skipped: number;
  last_run_errors: unknown;
  last_run_duration_ms: number | null;
  revision: number;
}

const TRIAGE_ITEM_COLUMNS = `
  id, source_platform, source_id, source_url, canonical_url, title,
  description, thumbnail_url, content_type, captured_at, ingested_at,
  status, snoozed_until, ai_summary, ai_categories, ai_suggested_actions,
  ai_relevance_score, ai_urgency, raw_metadata, actions_taken, source_order
`;

const TRIAGE_SYNC_STATE_COLUMNS = `
  id, last_cursor, last_synced_at, total_imported, total_skipped,
  last_run_imported, last_run_skipped, last_run_errors,
  last_run_duration_ms, revision
`;

function parseJson(value: unknown, field: string): unknown {
  let parsed = value;
  for (let depth = 0; depth < 5 && typeof parsed === 'string'; depth += 1) {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new Error(`Invalid JSON stored in ${field}`);
    }
  }
  return parsed;
}

function parseArray<T>(value: unknown, field: string): T[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${field} to contain a JSON array`);
  }
  return parsed as T[];
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseJson(value, field);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected ${field} to contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function mapTriageItem(row: TriageItemRow): TriageItem {
  return {
    id: row.id,
    sourcePlatform: row.source_platform as TriageItem['sourcePlatform'],
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    thumbnailUrl: row.thumbnail_url ?? undefined,
    contentType: row.content_type as TriageItem['contentType'],
    capturedAt: row.captured_at,
    ingestedAt: row.ingested_at,
    status: row.status as TriageItem['status'],
    snoozedUntil: row.snoozed_until ?? undefined,
    aiSummary: row.ai_summary ?? undefined,
    aiCategories: parseArray<string>(row.ai_categories, 'triage_items.ai_categories'),
    aiSuggestedActions: parseArray<TriageSuggestedAction>(
      row.ai_suggested_actions,
      'triage_items.ai_suggested_actions',
    ),
    aiRelevanceScore: row.ai_relevance_score,
    aiUrgency: row.ai_urgency as TriageItem['aiUrgency'],
    rawMetadata: parseObject(row.raw_metadata, 'triage_items.raw_metadata'),
    actionsTaken: parseArray<TriageActionRecord>(
      row.actions_taken,
      'triage_items.actions_taken',
    ),
    sourceOrder: row.source_order ?? undefined,
  };
}

function mapSyncState(row: TriageSyncStateRow): TriageSyncStateRecord {
  return {
    id: row.id,
    lastCursor: row.last_cursor,
    lastSyncedAt: row.last_synced_at,
    totalImported: row.total_imported,
    totalSkipped: row.total_skipped,
    lastRunImported: row.last_run_imported,
    lastRunSkipped: row.last_run_skipped,
    lastRunErrors: parseArray<string>(
      row.last_run_errors,
      'triage_sync_state.last_run_errors',
    ),
    lastRunDurationMs: row.last_run_duration_ms,
    revision: row.revision,
  };
}

class SqliteTriageCaptureRepository implements TriageCaptureRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async captureBatch(
    items: readonly TriageItem[],
  ): Promise<readonly TriageCaptureOutcome[]> {
    assertValidTriageCaptureBatch(items);
    const findBySource = this.db.prepare(`
      SELECT ${TRIAGE_ITEM_COLUMNS}
      FROM triage_items
      WHERE source_platform = ? AND source_id = ?
      LIMIT 1
    `);
    const findByCanonicalUrl = this.db.prepare(`
      SELECT ${TRIAGE_ITEM_COLUMNS}
      FROM triage_items
      WHERE canonical_url = ?
      LIMIT 1
    `);
    const insert = this.db.prepare(`
      INSERT INTO triage_items (
        ${TRIAGE_ITEM_COLUMNS}
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const transaction = this.db.transaction(() => {
      const outcomes: TriageCaptureOutcome[] = [];
      for (const item of items) {
        const sourceMatch = findBySource.get(
          item.sourcePlatform,
          item.sourceId,
        ) as TriageItemRow | undefined;
        if (sourceMatch) {
          outcomes.push({
            status: 'skipped',
            reason: 'source-replay',
            item: mapTriageItem(sourceMatch),
          });
          continue;
        }

        if (item.canonicalUrl !== undefined) {
          const canonicalMatch = findByCanonicalUrl.get(
            item.canonicalUrl,
          ) as TriageItemRow | undefined;
          if (canonicalMatch) {
            outcomes.push({
              status: 'skipped',
              reason: 'canonical-duplicate',
              item: mapTriageItem(canonicalMatch),
            });
            continue;
          }
        }

        const inserted = insert.run(
          item.id,
          item.sourcePlatform,
          item.sourceId,
          item.sourceUrl,
          item.canonicalUrl ?? null,
          item.title,
          item.description ?? null,
          item.thumbnailUrl ?? null,
          item.contentType,
          item.capturedAt,
          item.ingestedAt,
          item.status,
          item.snoozedUntil ?? null,
          item.aiSummary ?? null,
          JSON.stringify(item.aiCategories),
          JSON.stringify(item.aiSuggestedActions),
          item.aiRelevanceScore,
          item.aiUrgency,
          JSON.stringify(item.rawMetadata),
          JSON.stringify(item.actionsTaken),
          item.sourceOrder ?? null,
        );
        if (inserted.changes !== 1) {
          throw new Error('Failed to persist triage capture');
        }
        const persisted = findBySource.get(
          item.sourcePlatform,
          item.sourceId,
        ) as TriageItemRow | undefined;
        if (!persisted) {
          throw new Error('Persisted triage capture could not be read');
        }
        outcomes.push({ status: 'imported', item: mapTriageItem(persisted) });
      }
      return outcomes;
    });

    return transaction.immediate();
  }

  async enrich(
    itemId: string,
    enrichment: {
      readonly rawMetadata: Record<string, unknown>;
      readonly thumbnailUrl?: string;
    },
  ): Promise<TriageItem | null> {
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT ${TRIAGE_ITEM_COLUMNS}
        FROM triage_items
        WHERE id = ?
      `).get(itemId) as TriageItemRow | undefined;
      if (!current) return null;

      const metadata = {
        ...parseObject(current.raw_metadata, 'triage_items.raw_metadata'),
        ...enrichment.rawMetadata,
      };
      this.db.prepare(`
        UPDATE triage_items
        SET raw_metadata = ?,
            thumbnail_url = CASE
              WHEN thumbnail_url IS NULL THEN COALESCE(?, thumbnail_url)
              ELSE thumbnail_url
            END
        WHERE id = ?
      `).run(JSON.stringify(metadata), enrichment.thumbnailUrl ?? null, itemId);
      const updated = this.db.prepare(`
        SELECT ${TRIAGE_ITEM_COLUMNS}
        FROM triage_items
        WHERE id = ?
      `).get(itemId) as TriageItemRow | undefined;
      if (!updated) throw new Error('Enriched triage capture could not be read');
      return mapTriageItem(updated);
    });
    return transaction.immediate();
  }
}

class SqliteTriageSyncStateRepository implements TriageSyncStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async get(id: string): Promise<TriageSyncStateRecord | null> {
    const row = this.db.prepare(`
      SELECT ${TRIAGE_SYNC_STATE_COLUMNS}
      FROM triage_sync_state
      WHERE id = ?
    `).get(id) as TriageSyncStateRow | undefined;
    return row ? mapSyncState(row) : null;
  }

  async getAll(): Promise<TriageSyncStateRecord[]> {
    const rows = this.db.prepare(`
      SELECT ${TRIAGE_SYNC_STATE_COLUMNS}
      FROM triage_sync_state
      ORDER BY id
    `).all() as TriageSyncStateRow[];
    return rows.map(mapSyncState);
  }

  async recordRun(input: TriageSyncRunInput): Promise<TriageSyncRunResult> {
    assertValidTriageSyncRun(input);

    const transaction = this.db.transaction((): TriageSyncRunResult => {
      const cursorValue = input.cursor.operation === 'set'
        ? input.cursor.value
        : null;
      const update = this.db.prepare(`
        UPDATE triage_sync_state
        SET revision = revision + 1,
            last_cursor = CASE WHEN ? = 'preserve' THEN last_cursor ELSE ? END,
            last_synced_at = ?,
            total_imported = total_imported + ?,
            total_skipped = total_skipped + ?,
            last_run_imported = ?,
            last_run_skipped = ?,
            last_run_errors = ?,
            last_run_duration_ms = ?
        WHERE id = ? AND revision = ?
      `).run(
        input.cursor.operation,
        cursorValue,
        input.syncedAt,
        input.imported,
        input.skipped,
        input.imported,
        input.skipped,
        JSON.stringify(input.errors),
        input.durationMs,
        input.sourceId,
        input.expectedRevision,
      );

      let applied = update.changes === 1;
      if (!applied && input.expectedRevision === 0) {
        const insert = this.db.prepare(`
          INSERT INTO triage_sync_state (
            id, last_cursor, last_synced_at, total_imported, total_skipped,
            last_run_imported, last_run_skipped, last_run_errors,
            last_run_duration_ms, revision
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1 FROM triage_sync_state WHERE id = ?
          )
        `).run(
          input.sourceId,
          cursorValue,
          input.syncedAt,
          input.imported,
          input.skipped,
          input.imported,
          input.skipped,
          JSON.stringify(input.errors),
          input.durationMs,
          input.sourceId,
        );
        applied = insert.changes === 1;
      }

      const current = this.db.prepare(`
        SELECT ${TRIAGE_SYNC_STATE_COLUMNS}
        FROM triage_sync_state
        WHERE id = ?
      `).get(input.sourceId) as TriageSyncStateRow | undefined;
      const state = current ? mapSyncState(current) : null;
      if (applied && state) {
        return { status: 'applied', state };
      }
      return {
        status: 'stale',
        currentState: state,
        currentRevision: state?.revision ?? 0,
      };
    });

    return transaction.immediate();
  }
}

class SqliteGitHubCredentialFallbackRepository
implements GitHubCredentialFallbackRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async findActiveGitHubToken(): Promise<string | null> {
    const row = this.db.prepare(`
      SELECT credentials
      FROM connector_configs
      WHERE type = 'github-issues'
        AND deleted_at IS NULL
      ORDER BY created_at, id
      LIMIT 1
    `).get() as { credentials: unknown } | undefined;
    if (!row) return null;
    const credentials = parseObject(
      row.credentials,
      'connector_configs.credentials',
    );
    const token = credentials.token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  }
}

export function createSqliteTriagePersistenceRepositories(
  db: SqliteDatabase,
): TriagePersistenceRepositories {
  return {
    capture: new SqliteTriageCaptureRepository(db),
    syncState: new SqliteTriageSyncStateRepository(db),
    githubCredentialFallback: new SqliteGitHubCredentialFallbackRepository(db),
  };
}
