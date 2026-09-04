import type Database from 'better-sqlite3';
import type {
  TriageActionRecord,
  TriageItem,
  TriageSourcePlatform,
  TriageSuggestedAction,
} from '@/types';
import {
  assertValidTriageCaptureBatch,
  assertValidTriageSyncRun,
  normalizeTriageQueueCategoryFilters,
  resolveTriageQueueListPageLimit,
  TRIAGE_CACHED_THUMBNAIL_URL_PREFIX,
  TRIAGE_CAPTURE_IMAGE_URL_PREFIX,
  type GitHubCredentialFallbackRepository,
  type TriageCaptureOutcome,
  type TriageCaptureRepository,
  type TriageContentTypeRecord,
  type TriageContentTypeRepository,
  type TriageContentTypeSuppressionInput,
  type TriageContentTypeUpsertInput,
  type TriageDeleteBySourceInput,
  type TriageDigestSnapshot,
  type TriageDigestSnapshotInput,
  type TriageEmbedBackfillCandidate,
  type TriageEmbedBackfillPage,
  type TriageEmbedBackfillQuery,
  type TriageMaintenanceRepository,
  type TriageMergeMetadataOptions,
  type TriageMissingThumbnailCandidate,
  type TriagePersistenceRepositories,
  type TriageQueueFacetStats,
  type TriageQueueHealthPendingSnapshotEntry,
  type TriageQueueHealthRepository,
  type TriageQueueItemRepository,
  type TriageQueueListFilters,
  type TriageQueueListResult,
  type TriageStorageRefRow,
  type TriageSyncRunInput,
  type TriageSyncRunResult,
  type TriageSyncStateRecord,
  type TriageSyncStateRepository,
} from './triage-repositories';

type SqliteDatabase = Database.Database;

/** A single SQL condition fragment paired with its positional parameters, composable via {@link combineConditions}. */
interface SqlCondition {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Combines condition fragments into a single `WHERE ... AND ...` clause (or an empty clause when there are none). */
function combineConditions(conditions: readonly (SqlCondition | null)[]): {
  readonly whereSql: string;
  readonly params: unknown[];
} {
  const present = conditions.filter((condition): condition is SqlCondition => condition !== null);
  if (present.length === 0) return { whereSql: '', params: [] };
  return {
    whereSql: `WHERE ${present.map((condition) => condition.sql).join(' AND ')}`,
    params: present.flatMap((condition) => [...condition.params]),
  };
}

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

function parseArrayOrEmpty<T>(value: unknown): T[] {
  try {
    const parsed = parseJson(value, 'triage item JSON array');
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseObjectOrEmpty(value: unknown): Record<string, unknown> {
  try {
    const parsed = parseJson(value, 'triage item JSON object');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
    aiCategories: parseArrayOrEmpty<string>(row.ai_categories),
    aiSuggestedActions: parseArrayOrEmpty<TriageSuggestedAction>(row.ai_suggested_actions),
    aiRelevanceScore: row.ai_relevance_score,
    aiUrgency: (row.ai_urgency as TriageItem['aiUrgency']) || 'evergreen',
    rawMetadata: parseObjectOrEmpty(row.raw_metadata),
    actionsTaken: parseArrayOrEmpty<TriageActionRecord>(row.actions_taken),
    sourceOrder: row.source_order ?? undefined,
  };
}

interface TriageContentTypeRow {
  id: string;
  name: string;
  icon: string | null;
  color: string;
  builtin: number;
  suppressed: number;
  priority: number;
  url_patterns: unknown;
  keyword_hints: unknown;
  description: string | null;
  created_at: string;
  updated_at: string;
}

const TRIAGE_CONTENT_TYPE_COLUMNS = `
  id, name, icon, color, builtin, suppressed, priority,
  url_patterns, keyword_hints, description, created_at, updated_at
`;

function mapContentTypeRow(row: TriageContentTypeRow): TriageContentTypeRecord {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    builtin: row.builtin === 1,
    suppressed: row.suppressed === 1,
    priority: row.priority,
    urlPatterns: parseArray<string>(row.url_patterns, 'triage_content_types.url_patterns'),
    keywordHints: parseArray<string>(row.keyword_hints, 'triage_content_types.keyword_hints'),
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

const TRIAGE_STATUS_PRIORITY_CASE_SQL = `CASE status
  WHEN 'pending' THEN 0
  WHEN 'snoozed' THEN 1
  WHEN 'actioned' THEN 2
  WHEN 'dismissed' THEN 3
  ELSE 4
END`;

class SqliteTriageQueueItemRepository implements TriageQueueItemRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(filters: TriageQueueListFilters): Promise<TriageQueueListResult> {
    const limit = resolveTriageQueueListPageLimit(filters);
    const offset = filters.offset ?? 0;
    const normalizedCategories = normalizeTriageQueueCategoryFilters(filters.categories);

    const statusCondition: SqlCondition | null = filters.status && filters.status !== 'all'
      ? { sql: 'status = ?', params: [filters.status] }
      : null;
    const sourceCondition: SqlCondition | null = filters.source && filters.source !== 'all'
      ? { sql: 'source_platform = ?', params: [filters.source] }
      : null;
    const qCondition: SqlCondition | null = filters.q
      ? {
          sql: '(title LIKE ? OR description LIKE ? OR source_url LIKE ?)',
          params: (() => {
            const pattern = `%${filters.q!.trim()}%`;
            return [pattern, pattern, pattern];
          })(),
        }
      : null;
    const categoryCondition: SqlCondition | null = normalizedCategories.length > 0
      ? {
          sql: `(${normalizedCategories.map(() => `EXISTS (
            SELECT 1 FROM json_each(ai_categories) AS triage_category
            WHERE instr(lower(triage_category.value), ?) > 0
          )`).join(' OR ')})`,
          params: normalizedCategories,
        }
      : null;

    const fullWhere = combineConditions([statusCondition, sourceCondition, qCondition, categoryCondition]);
    const statusFacetWhere = combineConditions([sourceCondition, qCondition, categoryCondition]);
    const sourceFacetWhere = combineConditions([statusCondition, qCondition, categoryCondition]);

    const sortBy = filters.sortBy ?? 'relevance';
    const orderBySql = sortBy === 'newest'
      ? 'captured_at DESC'
      : sortBy === 'oldest'
        ? 'captured_at ASC'
        : sortBy === 'score'
          ? `${TRIAGE_STATUS_PRIORITY_CASE_SQL} ASC, ai_relevance_score DESC`
          : `${TRIAGE_STATUS_PRIORITY_CASE_SQL} ASC, ai_relevance_score DESC, captured_at DESC, source_order ASC`;

    const rows = this.db.prepare(`
      SELECT ${TRIAGE_ITEM_COLUMNS}
      FROM triage_items
      ${fullWhere.whereSql}
      ORDER BY ${orderBySql}
      LIMIT ? OFFSET ?
    `).all(...fullWhere.params, limit, offset) as TriageItemRow[];
    const items = rows.map(mapTriageItem);

    const totalsRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'snoozed' THEN 1 ELSE 0 END) AS snoozed,
        SUM(CASE WHEN status = 'actioned' THEN 1 ELSE 0 END) AS actioned,
        SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
      FROM triage_items
      ${statusFacetWhere.whereSql}
    `).get(...statusFacetWhere.params) as {
      total: number;
      pending: number | null;
      snoozed: number | null;
      actioned: number | null;
      dismissed: number | null;
    };

    const sourceRows = this.db.prepare(`
      SELECT source_platform, COUNT(*) AS count
      FROM triage_items
      ${sourceFacetWhere.whereSql}
      GROUP BY source_platform
    `).all(...sourceFacetWhere.params) as { source_platform: string; count: number }[];

    const filteredCountRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM triage_items ${fullWhere.whereSql}
    `).get(...fullWhere.params) as { count: number };
    const totalFiltered = filteredCountRow.count;

    const stats: TriageQueueFacetStats = {
      total: totalsRow.total ?? 0,
      pending: totalsRow.pending ?? 0,
      snoozed: totalsRow.snoozed ?? 0,
      actioned: totalsRow.actioned ?? 0,
      dismissed: totalsRow.dismissed ?? 0,
      sourceCounts: Object.fromEntries(
        sourceRows.map((row) => [row.source_platform, row.count]),
      ),
    };

    return {
      items,
      totalFiltered,
      hasMore: offset + items.length < totalFiltered,
      stats,
    };
  }

  async get(id: string): Promise<TriageItem | null> {
    const row = this.db.prepare(`
      SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE id = ?
    `).get(id) as TriageItemRow | undefined;
    return row ? mapTriageItem(row) : null;
  }

  async create(item: TriageItem): Promise<TriageItem> {
    const transaction = this.db.transaction((): TriageItem => {
      const inserted = this.db.prepare(`
        INSERT INTO triage_items (${TRIAGE_ITEM_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
        throw new Error('Failed to persist triage item');
      }
      const persisted = this.db.prepare(`
        SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE id = ?
      `).get(item.id) as TriageItemRow | undefined;
      if (!persisted) throw new Error('Created triage item could not be read');
      return mapTriageItem(persisted);
    });
    return transaction.immediate();
  }

  async seedIfEmpty(items: readonly TriageItem[]): Promise<void> {
    if (items.length === 0) return;
    const transaction = this.db.transaction(() => {
      const countRow = this.db.prepare(
        'SELECT COUNT(*) AS count FROM triage_items',
      ).get() as { count: number };
      if (countRow.count > 0) return;

      const insert = this.db.prepare(`
        INSERT INTO triage_items (${TRIAGE_ITEM_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insert.run(
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
      }
    });
    transaction.immediate();
  }

  async mergeMetadata(
    id: string,
    patch: Record<string, unknown>,
    options?: TriageMergeMetadataOptions,
  ): Promise<TriageItem | null> {
    const transaction = this.db.transaction((): TriageItem | null => {
      const current = this.db.prepare(`
        SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE id = ?
      `).get(id) as TriageItemRow | undefined;
      if (!current) return null;

      const currentMeta = parseObjectOrEmpty(current.raw_metadata);
      const skipKey = options?.skipWhenKeyPresent;
      if (skipKey && currentMeta[skipKey]) {
        return mapTriageItem(current);
      }

      const mergedMeta = { ...currentMeta, ...patch };
      this.db.prepare(`
        UPDATE triage_items
        SET raw_metadata = ?,
            thumbnail_url = CASE
              WHEN thumbnail_url IS NULL THEN COALESCE(?, thumbnail_url)
              ELSE thumbnail_url
            END
        WHERE id = ?
      `).run(JSON.stringify(mergedMeta), options?.fillThumbnailUrl ?? null, id);

      const updated = this.db.prepare(`
        SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE id = ?
      `).get(id) as TriageItemRow | undefined;
      if (!updated) throw new Error('Merged triage metadata could not be read');
      return mapTriageItem(updated);
    });
    return transaction.immediate();
  }

  async setContentType(id: string, contentType: string): Promise<TriageItem | null> {
    const transaction = this.db.transaction((): TriageItem | null => {
      this.db.prepare(
        'UPDATE triage_items SET content_type = ? WHERE id = ?',
      ).run(contentType, id);
      const row = this.db.prepare(`
        SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE id = ?
      `).get(id) as TriageItemRow | undefined;
      return row ? mapTriageItem(row) : null;
    });
    return transaction.immediate();
  }

  async setContentTypes(ids: readonly string[], contentType: string): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const result = this.db.prepare(`
      UPDATE triage_items SET content_type = ? WHERE id IN (${placeholders})
    `).run(contentType, ...ids);
    return result.changes;
  }

  async listForReclassification(ids?: readonly string[]): Promise<TriageItem[]> {
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE id IN (${placeholders})
      `).all(...ids) as TriageItemRow[];
      return rows.map(mapTriageItem);
    }
    const rows = this.db.prepare(`
      SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items
    `).all() as TriageItemRow[];
    return rows.map(mapTriageItem);
  }

  async findBySourceId(sourceId: string): Promise<TriageItem | null> {
    const row = this.db.prepare(`
      SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE source_id = ?
    `).get(sourceId) as TriageItemRow | undefined;
    return row ? mapTriageItem(row) : null;
  }

  async findBySourceUrl(sourceUrl: string): Promise<TriageItem | null> {
    const row = this.db.prepare(`
      SELECT ${TRIAGE_ITEM_COLUMNS} FROM triage_items WHERE source_url = ?
    `).get(sourceUrl) as TriageItemRow | undefined;
    return row ? mapTriageItem(row) : null;
  }

  async listEmbedBackfillCandidates(
    query: TriageEmbedBackfillQuery,
  ): Promise<TriageEmbedBackfillPage> {
    const sourceCondition: SqlCondition | null = query.source
      ? { sql: 'source_platform = ?', params: [query.source] }
      : null;
    const cursorCondition: SqlCondition | null = query.cursor
      ? { sql: 'id > ?', params: [query.cursor] }
      : null;
    const embedAbsentCondition: SqlCondition | null = query.force
      ? null
      : {
          sql: `CASE
            WHEN json_valid(raw_metadata) = 0 THEN 1
            WHEN json_type(raw_metadata, '$.embed') IS NULL THEN 1
            ELSE 0
          END = 1`,
          params: [],
        };

    const where = combineConditions([sourceCondition, cursorCondition, embedAbsentCondition]);
    const rows = this.db.prepare(`
      SELECT id, source_url, canonical_url
      FROM triage_items
      ${where.whereSql}
      ORDER BY id ASC
      LIMIT ?
    `).all(...where.params, query.limit) as {
      id: string;
      source_url: string;
      canonical_url: string | null;
    }[];

    const items: TriageEmbedBackfillCandidate[] = rows.map((row) => ({
      id: row.id,
      sourceUrl: row.source_url,
      canonicalUrl: row.canonical_url ?? undefined,
    }));
    const nextCursor = items.length === query.limit
      ? items[items.length - 1]?.id ?? null
      : null;

    return { items, nextCursor };
  }

  async listMissingThumbnailCandidates(
    input?: { readonly source?: string },
  ): Promise<TriageMissingThumbnailCandidate[]> {
    const sourceCondition: SqlCondition | null = input?.source
      ? { sql: 'source_platform = ?', params: [input.source] }
      : null;
    const where = combineConditions([
      { sql: 'thumbnail_url IS NULL', params: [] },
      sourceCondition,
    ]);
    const rows = this.db.prepare(`
      SELECT id, source_platform, source_url, raw_metadata
      FROM triage_items
      ${where.whereSql}
    `).all(...where.params) as {
      id: string;
      source_platform: string;
      source_url: string;
      raw_metadata: unknown;
    }[];

    return rows.map((row) => ({
      id: row.id,
      sourcePlatform: row.source_platform as TriageSourcePlatform,
      sourceUrl: row.source_url,
      rawMetadata: parseObjectOrEmpty(row.raw_metadata),
    }));
  }

  async fillThumbnailIfNull(id: string, thumbnailUrl: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE triage_items
      SET thumbnail_url = ?
      WHERE id = ? AND thumbnail_url IS NULL
    `).run(thumbnailUrl, id);
    return result.changes === 1;
  }

  async setThumbnail(id: string, thumbnailUrl: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE triage_items
      SET thumbnail_url = ?
      WHERE id = ?
    `).run(thumbnailUrl, id);
    return result.changes === 1;
  }
}

class SqliteTriageContentTypeRepository implements TriageContentTypeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<TriageContentTypeRecord[]> {
    const rows = this.db.prepare(`
      SELECT ${TRIAGE_CONTENT_TYPE_COLUMNS} FROM triage_content_types
    `).all() as TriageContentTypeRow[];
    return rows.map(mapContentTypeRow);
  }

  async upsert(record: TriageContentTypeUpsertInput): Promise<void> {
    const transaction = this.db.transaction(() => {
      const update = this.db.prepare(`
        UPDATE triage_content_types
        SET name = ?, icon = ?, color = ?, builtin = ?, suppressed = ?,
            priority = ?, url_patterns = ?, keyword_hints = ?, description = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        record.name,
        record.icon,
        record.color,
        record.builtin ? 1 : 0,
        record.suppressed ? 1 : 0,
        record.priority,
        JSON.stringify(record.urlPatterns),
        JSON.stringify(record.keywordHints),
        record.description,
        record.updatedAt,
        record.id,
      );
      if (update.changes > 0) return;

      this.db.prepare(`
        INSERT INTO triage_content_types (${TRIAGE_CONTENT_TYPE_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.name,
        record.icon,
        record.color,
        record.builtin ? 1 : 0,
        record.suppressed ? 1 : 0,
        record.priority,
        JSON.stringify(record.urlPatterns),
        JSON.stringify(record.keywordHints),
        record.description,
        record.createdAt,
        record.updatedAt,
      );
    });
    transaction.immediate();
  }

  async deleteCustom(id: string): Promise<boolean> {
    const result = this.db.prepare(
      'DELETE FROM triage_content_types WHERE id = ?',
    ).run(id);
    return result.changes > 0;
  }

  async setSuppressed(input: TriageContentTypeSuppressionInput): Promise<void> {
    const transaction = this.db.transaction(() => {
      const update = this.db.prepare(`
        UPDATE triage_content_types
        SET suppressed = ?, updated_at = ?
        WHERE id = ?
      `).run(input.suppressed ? 1 : 0, input.updatedAt, input.id);
      if (update.changes > 0) return;
      if (!input.builtin) return;

      this.db.prepare(`
        INSERT INTO triage_content_types (${TRIAGE_CONTENT_TYPE_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.builtin.name,
        input.builtin.icon,
        input.builtin.color,
        1,
        input.suppressed ? 1 : 0,
        input.builtin.priority,
        JSON.stringify(input.builtin.urlPatterns),
        JSON.stringify(input.builtin.keywordHints),
        input.builtin.description,
        input.builtin.createdAt,
        input.updatedAt,
      );
    });
    transaction.immediate();
  }
}

class SqliteTriageQueueHealthRepository implements TriageQueueHealthRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async getPendingSnapshot(): Promise<TriageQueueHealthPendingSnapshotEntry[]> {
    const rows = this.db.prepare(`
      SELECT captured_at, source_platform
      FROM triage_items
      WHERE status = 'pending'
    `).all() as { captured_at: string; source_platform: string }[];
    return rows.map((row) => ({
      capturedAt: row.captured_at,
      sourcePlatform: row.source_platform as TriageSourcePlatform,
    }));
  }

  async getDigestSnapshot(input: TriageDigestSnapshotInput): Promise<TriageDigestSnapshot> {
    const newItemRows = this.db.prepare(`
      SELECT source_platform, COUNT(*) AS count
      FROM triage_items
      WHERE ingested_at >= ?
      GROUP BY source_platform
    `).all(input.periodStart) as { source_platform: string; count: number }[];

    const actionedRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM triage_items
      WHERE status IN ('actioned', 'dismissed') AND ingested_at >= ?
      GROUP BY status
    `).all(input.periodStart) as { status: string; count: number }[];

    const queueDepthRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM triage_items WHERE status = 'pending'
    `).get() as { count: number };

    const staleCountRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM triage_items
      WHERE status = 'pending' AND captured_at < ?
    `).get(input.staleBeforeAt) as { count: number };

    const topPendingRows = this.db.prepare(`
      SELECT id, title, captured_at, ai_suggested_actions
      FROM triage_items
      WHERE status = 'pending'
      ORDER BY captured_at ASC
      LIMIT ?
    `).all(input.topPendingLimit) as {
      id: string;
      title: string;
      captured_at: string;
      ai_suggested_actions: unknown;
    }[];

    return {
      newItemsBySource: Object.fromEntries(
        newItemRows.map((row) => [row.source_platform, row.count]),
      ),
      actionedByStatus: Object.fromEntries(
        actionedRows.map((row) => [row.status, row.count]),
      ),
      queueDepth: queueDepthRow.count,
      staleCount: staleCountRow.count,
      topPending: topPendingRows.map((row) => ({
        id: row.id,
        title: row.title,
        capturedAt: row.captured_at,
        aiSuggestedActions: parseArrayOrEmpty<TriageSuggestedAction>(
          row.ai_suggested_actions,
        ),
      })),
    };
  }
}

class SqliteTriageMaintenanceRepository implements TriageMaintenanceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async countByStatus(): Promise<Record<string, number>> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM triage_items GROUP BY status
    `).all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async countBySource(): Promise<Record<string, number>> {
    const rows = this.db.prepare(`
      SELECT source_platform, COUNT(*) AS count FROM triage_items GROUP BY source_platform
    `).all() as { source_platform: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.source_platform, row.count]));
  }

  async countCachedThumbnails(): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM triage_items WHERE thumbnail_url LIKE ?
    `).get(`${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`) as { count: number };
    return row.count;
  }

  async countExternalThumbnails(): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM triage_items
      WHERE thumbnail_url IS NOT NULL
        AND thumbnail_url NOT LIKE ?
        AND thumbnail_url NOT LIKE ?
    `).get(
      `${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`,
      `${TRIAGE_CAPTURE_IMAGE_URL_PREFIX}%`,
    ) as { count: number };
    return row.count;
  }

  async listCachedThumbnailFilenames(): Promise<string[]> {
    const rows = this.db.prepare(`
      SELECT thumbnail_url FROM triage_items WHERE thumbnail_url LIKE ?
    `).all(`${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`) as { thumbnail_url: string | null }[];
    const filenames = new Set<string>();
    for (const row of rows) {
      if (!row.thumbnail_url) continue;
      const filename = row.thumbnail_url.split('/').pop();
      if (filename) filenames.add(filename);
    }
    return [...filenames];
  }

  async clearExternalThumbnails(): Promise<number> {
    const result = this.db.prepare(`
      UPDATE triage_items
      SET thumbnail_url = NULL
      WHERE thumbnail_url IS NOT NULL
        AND thumbnail_url NOT LIKE ?
        AND thumbnail_url NOT LIKE ?
    `).run(
      `${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`,
      `${TRIAGE_CAPTURE_IMAGE_URL_PREFIX}%`,
    );
    return result.changes;
  }

  async countDismissedBefore(cutoff: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM triage_items
      WHERE status = 'dismissed' AND ingested_at < ?
    `).get(cutoff) as { count: number };
    return row.count;
  }

  async purgeDismissedBefore(cutoff: string): Promise<TriageStorageRefRow[]> {
    const transaction = this.db.transaction((): TriageStorageRefRow[] => {
      const rows = this.db.prepare(`
        SELECT id, thumbnail_url, source_url
        FROM triage_items
        WHERE status = 'dismissed' AND ingested_at < ?
      `).all(cutoff) as { id: string; thumbnail_url: string | null; source_url: string }[];
      if (rows.length === 0) return [];

      const placeholders = rows.map(() => '?').join(', ');
      this.db.prepare(`
        DELETE FROM triage_items WHERE id IN (${placeholders})
      `).run(...rows.map((row) => row.id));

      return rows.map((row) => ({
        id: row.id,
        thumbnailUrl: row.thumbnail_url,
        sourceUrl: row.source_url,
      }));
    });
    return transaction.immediate();
  }

  async deleteBySource(input: TriageDeleteBySourceInput): Promise<TriageStorageRefRow[]> {
    const statusCondition: SqlCondition | null = input.includeActioned
      ? null
      : { sql: `status IN ('pending', 'dismissed')`, params: [] };
    const where = combineConditions([
      { sql: 'source_platform = ?', params: [input.source] },
      statusCondition,
    ]);

    const transaction = this.db.transaction((): TriageStorageRefRow[] => {
      const rows = this.db.prepare(`
        SELECT id, thumbnail_url, source_url
        FROM triage_items
        ${where.whereSql}
      `).all(...where.params) as { id: string; thumbnail_url: string | null; source_url: string }[];
      if (rows.length === 0) return [];

      this.db.prepare(`
        DELETE FROM triage_items ${where.whereSql}
      `).run(...where.params);

      return rows.map((row) => ({
        id: row.id,
        thumbnailUrl: row.thumbnail_url,
        sourceUrl: row.source_url,
      }));
    });
    return transaction.immediate();
  }

  async deleteByIds(ids: readonly string[]): Promise<TriageStorageRefRow[]> {
    if (ids.length === 0) return [];

    const transaction = this.db.transaction((): TriageStorageRefRow[] => {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT id, thumbnail_url, source_url
        FROM triage_items
        WHERE id IN (${placeholders})
      `).all(...ids) as { id: string; thumbnail_url: string | null; source_url: string }[];
      if (rows.length === 0) return [];

      this.db.prepare(`
        DELETE FROM triage_items WHERE id IN (${placeholders})
      `).run(...ids);

      return rows.map((row) => ({
        id: row.id,
        thumbnailUrl: row.thumbnail_url,
        sourceUrl: row.source_url,
      }));
    });
    return transaction.immediate();
  }
}

export function createSqliteTriagePersistenceRepositories(
  db: SqliteDatabase,
): TriagePersistenceRepositories {
  return {
    capture: new SqliteTriageCaptureRepository(db),
    syncState: new SqliteTriageSyncStateRepository(db),
    githubCredentialFallback: new SqliteGitHubCredentialFallbackRepository(db),
    items: new SqliteTriageQueueItemRepository(db),
    contentTypes: new SqliteTriageContentTypeRepository(db),
    health: new SqliteTriageQueueHealthRepository(db),
    maintenance: new SqliteTriageMaintenanceRepository(db),
  };
}
