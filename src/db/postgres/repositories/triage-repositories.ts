import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
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
  type NativeApnsRepository,
  type NativeApnsRegistrationOutcome,
  type NativeApnsRegistrationStoredResponse,
  type NativeApnsUnregistrationOutcome,
  type NativeApnsUnregistrationStoredResponse,
  type NativeCredentialRepository,
  type NativeRequestOutcome,
  type NativeShareCaptureClaim,
  type NativeShareCaptureClaimInput,
  type NativeShareCaptureRepository,
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
} from '@/db/persistence/triage-repositories';
import type { PostgresDatabase, PostgresTransaction } from '../runtime';
import {
  apnsRegistrations,
  connectorConfigs,
  nativeInstallationCredentials,
  nativePushRequests,
  nativeShareCaptureRequests,
  nativeShareCredentials,
  triageContentTypes,
  triageItems,
  triageSyncState,
} from '../schema';

type TriageItemRow = typeof triageItems.$inferSelect;
type TriageSyncStateRow = typeof triageSyncState.$inferSelect;
type TriageContentTypeRow = typeof triageContentTypes.$inferSelect;

/** Converts a possibly-string (bigint/numeric) aggregate result from the PostgreSQL driver into a JS number. */
function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

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
    sourcePlatform: row.sourcePlatform as TriageItem['sourcePlatform'],
    sourceId: row.sourceId,
    sourceUrl: row.sourceUrl,
    canonicalUrl: row.canonicalUrl ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    thumbnailUrl: row.thumbnailUrl ?? undefined,
    contentType: row.contentType as TriageItem['contentType'],
    capturedAt: row.capturedAt,
    ingestedAt: row.ingestedAt,
    status: row.status as TriageItem['status'],
    snoozedUntil: row.snoozedUntil ?? undefined,
    aiSummary: row.aiSummary ?? undefined,
    aiCategories: parseArrayOrEmpty<string>(row.aiCategories),
    aiSuggestedActions: parseArrayOrEmpty<TriageSuggestedAction>(row.aiSuggestedActions),
    aiRelevanceScore: row.aiRelevanceScore,
    aiUrgency: (row.aiUrgency as TriageItem['aiUrgency']) || 'evergreen',
    rawMetadata: parseObjectOrEmpty(row.rawMetadata),
    actionsTaken: parseArrayOrEmpty<TriageActionRecord>(row.actionsTaken),
    sourceOrder: row.sourceOrder ?? undefined,
  };
}

function mapSyncState(row: TriageSyncStateRow): TriageSyncStateRecord {
  return {
    id: row.id,
    lastCursor: row.lastCursor,
    lastSyncedAt: row.lastSyncedAt,
    totalImported: row.totalImported,
    totalSkipped: row.totalSkipped,
    lastRunImported: row.lastRunImported,
    lastRunSkipped: row.lastRunSkipped,
    lastRunErrors: parseArray<string>(
      row.lastRunErrors,
      'triage_sync_state.last_run_errors',
    ),
    lastRunDurationMs: row.lastRunDurationMs,
    revision: row.revision,
  };
}

function mapContentTypeRow(row: TriageContentTypeRow): TriageContentTypeRecord {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    builtin: row.builtin,
    suppressed: row.suppressed,
    priority: row.priority,
    urlPatterns: parseArray<string>(row.urlPatterns, 'triage_content_types.url_patterns'),
    keywordHints: parseArray<string>(row.keywordHints, 'triage_content_types.keyword_hints'),
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class PostgresTriageCaptureRepository implements TriageCaptureRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async captureBatch(
    items: readonly TriageItem[],
  ): Promise<readonly TriageCaptureOutcome[]> {
    assertValidTriageCaptureBatch(items);
    try {
      return await this.db.transaction(async (tx) => {
        if (items.length === 0) return [];
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtext('mission-control:triage-capture')
          )
        `);
        const outcomes: TriageCaptureOutcome[] = [];
        for (const item of items) {
          const [sourceMatch] = await tx
            .select()
            .from(triageItems)
            .where(and(
              eq(triageItems.sourcePlatform, item.sourcePlatform),
              eq(triageItems.sourceId, item.sourceId),
            ))
            .limit(1);
          if (sourceMatch) {
            outcomes.push({
              status: 'skipped',
              reason: 'source-replay',
              item: mapTriageItem(sourceMatch),
            });
            continue;
          }

          if (item.canonicalUrl !== undefined) {
            const [canonicalMatch] = await tx
              .select()
              .from(triageItems)
              .where(eq(triageItems.canonicalUrl, item.canonicalUrl))
              .limit(1);
            if (canonicalMatch) {
              outcomes.push({
                status: 'skipped',
                reason: 'canonical-duplicate',
                item: mapTriageItem(canonicalMatch),
              });
              continue;
            }
          }

          const [persisted] = await tx
            .insert(triageItems)
            .values({
              id: item.id,
              sourcePlatform: item.sourcePlatform,
              sourceId: item.sourceId,
              sourceUrl: item.sourceUrl,
              canonicalUrl: item.canonicalUrl ?? null,
              title: item.title,
              description: item.description ?? null,
              thumbnailUrl: item.thumbnailUrl ?? null,
              contentType: item.contentType,
              capturedAt: item.capturedAt,
              ingestedAt: item.ingestedAt,
              status: item.status,
              snoozedUntil: item.snoozedUntil ?? null,
              aiSummary: item.aiSummary ?? null,
              aiCategories: [...item.aiCategories],
              aiSuggestedActions: [...item.aiSuggestedActions],
              aiRelevanceScore: item.aiRelevanceScore,
              aiUrgency: item.aiUrgency,
              rawMetadata: item.rawMetadata,
              actionsTaken: [...item.actionsTaken],
              sourceOrder: item.sourceOrder ?? null,
            })
            .returning();
          if (!persisted) {
            throw new Error('Failed to persist triage capture');
          }
          outcomes.push({ status: 'imported', item: mapTriageItem(persisted) });
        }
        return outcomes;
      });
    } catch {
      throw new Error('Triage capture persistence failed');
    }
  }

  async enrich(
    itemId: string,
    enrichment: {
      readonly rawMetadata: Record<string, unknown>;
      readonly thumbnailUrl?: string;
    },
  ): Promise<TriageItem | null> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(triageItems)
        .where(eq(triageItems.id, itemId))
        .limit(1);
      if (!current) return null;

      const [updated] = await tx
        .update(triageItems)
        .set({
          rawMetadata: {
            ...parseObject(current.rawMetadata, 'triage_items.raw_metadata'),
            ...enrichment.rawMetadata,
          },
          thumbnailUrl: current.thumbnailUrl ?? enrichment.thumbnailUrl ?? null,
        })
        .where(eq(triageItems.id, itemId))
        .returning();
      if (!updated) throw new Error('Enriched triage capture could not be read');
      return mapTriageItem(updated);
    });
  }
}

class PostgresTriageSyncStateRepository implements TriageSyncStateRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(id: string): Promise<TriageSyncStateRecord | null> {
    const [row] = await this.db
      .select()
      .from(triageSyncState)
      .where(eq(triageSyncState.id, id))
      .limit(1);
    return row ? mapSyncState(row) : null;
  }

  async getAll(): Promise<TriageSyncStateRecord[]> {
    const rows = await this.db
      .select()
      .from(triageSyncState)
      .orderBy(asc(triageSyncState.id));
    return rows.map(mapSyncState);
  }

  async recordRun(input: TriageSyncRunInput): Promise<TriageSyncRunResult> {
    assertValidTriageSyncRun(input);

    return this.db.transaction(async (tx): Promise<TriageSyncRunResult> => {
      const lastCursor = input.cursor.operation === 'preserve'
        ? sql`${triageSyncState.lastCursor}`
        : input.cursor.value;
      const updateValues = {
        revision: sql`${triageSyncState.revision} + 1`,
        lastCursor,
        lastSyncedAt: input.syncedAt,
        totalImported: sql`${triageSyncState.totalImported} + ${input.imported}`,
        totalSkipped: sql`${triageSyncState.totalSkipped} + ${input.skipped}`,
        lastRunImported: input.imported,
        lastRunSkipped: input.skipped,
        lastRunErrors: [...input.errors],
        lastRunDurationMs: input.durationMs,
      };

      const appliedRows = input.expectedRevision === 0
        ? await tx
            .insert(triageSyncState)
            .values({
              id: input.sourceId,
              revision: 1,
              lastCursor: input.cursor.operation === 'set'
                ? input.cursor.value
                : null,
              lastSyncedAt: input.syncedAt,
              totalImported: input.imported,
              totalSkipped: input.skipped,
              lastRunImported: input.imported,
              lastRunSkipped: input.skipped,
              lastRunErrors: [...input.errors],
              lastRunDurationMs: input.durationMs,
            })
            .onConflictDoUpdate({
              target: triageSyncState.id,
              set: updateValues,
              setWhere: eq(
                triageSyncState.revision,
                input.expectedRevision,
              ),
            })
            .returning()
        : await tx
            .update(triageSyncState)
            .set(updateValues)
            .where(and(
              eq(triageSyncState.id, input.sourceId),
              eq(triageSyncState.revision, input.expectedRevision),
            ))
            .returning();

      const applied = appliedRows[0];
      if (applied) {
        return { status: 'applied', state: mapSyncState(applied) };
      }

      const [current] = await tx
        .select()
        .from(triageSyncState)
        .where(eq(triageSyncState.id, input.sourceId))
        .limit(1);
      const currentState = current ? mapSyncState(current) : null;
      return {
        status: 'stale',
        currentState,
        currentRevision: currentState?.revision ?? 0,
      };
    });
  }
}

class PostgresGitHubCredentialFallbackRepository
implements GitHubCredentialFallbackRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async findActiveGitHubToken(): Promise<string | null> {
    const [row] = await this.db
      .select({ credentials: connectorConfigs.credentials })
      .from(connectorConfigs)
      .where(and(
        eq(connectorConfigs.type, 'github-issues'),
        isNull(connectorConfigs.deletedAt),
      ))
      .orderBy(asc(connectorConfigs.createdAt), asc(connectorConfigs.id))
      .limit(1);
    if (!row) return null;
    const credentials = parseObject(
      row.credentials,
      'connector_configs.credentials',
    );
    const token = credentials.token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  }
}

const TRIAGE_STATUS_PRIORITY_SQL = sql`CASE ${triageItems.status}
  WHEN 'pending' THEN 0
  WHEN 'snoozed' THEN 1
  WHEN 'actioned' THEN 2
  WHEN 'dismissed' THEN 3
  ELSE 4
END`;

class PostgresTriageQueueItemRepository implements TriageQueueItemRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async list(filters: TriageQueueListFilters): Promise<TriageQueueListResult> {
    const limit = resolveTriageQueueListPageLimit(filters);
    const offset = filters.offset ?? 0;
    const normalizedCategories = normalizeTriageQueueCategoryFilters(filters.categories);

    const statusCondition = filters.status && filters.status !== 'all'
      ? eq(triageItems.status, filters.status)
      : undefined;
    const sourceCondition = filters.source && filters.source !== 'all'
      ? eq(triageItems.sourcePlatform, filters.source)
      : undefined;
    const qCondition = filters.q
      ? (() => {
          const pattern = `%${filters.q!.trim()}%`;
          return or(
            sql`${triageItems.title} ILIKE ${pattern}`,
            sql`${triageItems.description} ILIKE ${pattern}`,
            sql`${triageItems.sourceUrl} ILIKE ${pattern}`,
          );
        })()
      : undefined;
    const categoryCondition = normalizedCategories.length > 0
      ? or(...normalizedCategories.map((category) => sql`EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${triageItems.aiCategories}) AS triage_category
          WHERE triage_category ILIKE ${`%${category}%`}
        )`))
      : undefined;

    type QueueCondition = NonNullable<typeof statusCondition>;
    const fullConditions = [statusCondition, sourceCondition, qCondition, categoryCondition]
      .filter((condition): condition is QueueCondition => condition !== undefined);
    const fullWhere = fullConditions.length ? and(...fullConditions) : undefined;

    const statusFacetConditions = [sourceCondition, qCondition, categoryCondition]
      .filter((condition): condition is QueueCondition => condition !== undefined);
    const statusFacetWhere = statusFacetConditions.length ? and(...statusFacetConditions) : undefined;

    const sourceFacetConditions = [statusCondition, qCondition, categoryCondition]
      .filter((condition): condition is QueueCondition => condition !== undefined);
    const sourceFacetWhere = sourceFacetConditions.length ? and(...sourceFacetConditions) : undefined;

    const statusPriority = asc(TRIAGE_STATUS_PRIORITY_SQL);
    const sortBy = filters.sortBy ?? 'relevance';
    const orderBy = sortBy === 'newest'
      ? [desc(triageItems.capturedAt)]
      : sortBy === 'oldest'
        ? [asc(triageItems.capturedAt)]
        : sortBy === 'score'
          ? [statusPriority, desc(triageItems.aiRelevanceScore)]
          : [
              statusPriority,
              desc(triageItems.aiRelevanceScore),
              desc(triageItems.capturedAt),
              sql`${triageItems.sourceOrder} ASC NULLS FIRST`,
            ];

    const rows = await this.db.select().from(triageItems)
      .where(fullWhere)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);
    const items = rows.map(mapTriageItem);

    const [totals] = await this.db.select({
      total: sql<number>`count(*)`,
      pending: sql<number>`sum(case when ${triageItems.status} = 'pending' then 1 else 0 end)`,
      snoozed: sql<number>`sum(case when ${triageItems.status} = 'snoozed' then 1 else 0 end)`,
      actioned: sql<number>`sum(case when ${triageItems.status} = 'actioned' then 1 else 0 end)`,
      dismissed: sql<number>`sum(case when ${triageItems.status} = 'dismissed' then 1 else 0 end)`,
    }).from(triageItems).where(statusFacetWhere);

    const sourceRows = await this.db.select({
      sourcePlatform: triageItems.sourcePlatform,
      count: sql<number>`count(*)`,
    }).from(triageItems).where(sourceFacetWhere).groupBy(triageItems.sourcePlatform);

    const [filteredCount] = await this.db.select({ count: sql<number>`count(*)` })
      .from(triageItems)
      .where(fullWhere);
    const totalFiltered = toNumber(filteredCount?.count);

    const stats: TriageQueueFacetStats = {
      total: toNumber(totals?.total),
      pending: toNumber(totals?.pending),
      snoozed: toNumber(totals?.snoozed),
      actioned: toNumber(totals?.actioned),
      dismissed: toNumber(totals?.dismissed),
      sourceCounts: Object.fromEntries(
        sourceRows.map((row) => [row.sourcePlatform, toNumber(row.count)]),
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
    const [row] = await this.db.select().from(triageItems)
      .where(eq(triageItems.id, id))
      .limit(1);
    return row ? mapTriageItem(row) : null;
  }

  async create(item: TriageItem): Promise<TriageItem> {
    const [created] = await this.db.insert(triageItems).values({
      id: item.id,
      sourcePlatform: item.sourcePlatform,
      sourceId: item.sourceId,
      sourceUrl: item.sourceUrl,
      canonicalUrl: item.canonicalUrl ?? null,
      title: item.title,
      description: item.description ?? null,
      thumbnailUrl: item.thumbnailUrl ?? null,
      contentType: item.contentType,
      capturedAt: item.capturedAt,
      ingestedAt: item.ingestedAt,
      status: item.status,
      snoozedUntil: item.snoozedUntil ?? null,
      aiSummary: item.aiSummary ?? null,
      aiCategories: [...item.aiCategories],
      aiSuggestedActions: [...item.aiSuggestedActions],
      aiRelevanceScore: item.aiRelevanceScore,
      aiUrgency: item.aiUrgency,
      rawMetadata: item.rawMetadata,
      actionsTaken: [...item.actionsTaken],
      sourceOrder: item.sourceOrder ?? null,
    }).returning();
    if (!created) throw new Error('Failed to persist triage item');
    return mapTriageItem(created);
  }

  async seedIfEmpty(items: readonly TriageItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql.raw(
        'LOCK TABLE triage_items IN SHARE ROW EXCLUSIVE MODE',
      ));
      const [countRow] = await tx.select({ count: sql<number>`count(*)` }).from(triageItems);
      if (toNumber(countRow?.count) > 0) return;

      await tx.insert(triageItems).values(items.map((item) => ({
        id: item.id,
        sourcePlatform: item.sourcePlatform,
        sourceId: item.sourceId,
        sourceUrl: item.sourceUrl,
        canonicalUrl: item.canonicalUrl ?? null,
        title: item.title,
        description: item.description ?? null,
        thumbnailUrl: item.thumbnailUrl ?? null,
        contentType: item.contentType,
        capturedAt: item.capturedAt,
        ingestedAt: item.ingestedAt,
        status: item.status,
        snoozedUntil: item.snoozedUntil ?? null,
        aiSummary: item.aiSummary ?? null,
        aiCategories: [...item.aiCategories],
        aiSuggestedActions: [...item.aiSuggestedActions],
        aiRelevanceScore: item.aiRelevanceScore,
        aiUrgency: item.aiUrgency,
        rawMetadata: item.rawMetadata,
        actionsTaken: [...item.actionsTaken],
        sourceOrder: item.sourceOrder ?? null,
      })));
    });
  }

  async mergeMetadata(
    id: string,
    patch: Record<string, unknown>,
    options?: TriageMergeMetadataOptions,
  ): Promise<TriageItem | null> {
    return this.db.transaction(async (tx): Promise<TriageItem | null> => {
      const [current] = await tx.select().from(triageItems)
        .where(eq(triageItems.id, id))
        .limit(1)
        .for('update');
      if (!current) return null;

      const currentMeta = parseObjectOrEmpty(current.rawMetadata);
      const skipKey = options?.skipWhenKeyPresent;
      if (skipKey && currentMeta[skipKey]) {
        return mapTriageItem(current);
      }

      const mergedMeta = { ...currentMeta, ...patch };
      const [updated] = await tx.update(triageItems)
        .set({
          rawMetadata: mergedMeta,
          thumbnailUrl: current.thumbnailUrl ?? options?.fillThumbnailUrl ?? null,
        })
        .where(eq(triageItems.id, id))
        .returning();
      if (!updated) throw new Error('Merged triage metadata could not be read');
      return mapTriageItem(updated);
    });
  }

  async setContentType(id: string, contentType: string): Promise<TriageItem | null> {
    const [updated] = await this.db.update(triageItems)
      .set({ contentType })
      .where(eq(triageItems.id, id))
      .returning();
    return updated ? mapTriageItem(updated) : null;
  }

  async setContentTypes(ids: readonly string[], contentType: string): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db.update(triageItems)
      .set({ contentType })
      .where(inArray(triageItems.id, [...ids]))
      .returning({ id: triageItems.id });
    return result.length;
  }

  async listForReclassification(ids?: readonly string[]): Promise<TriageItem[]> {
    const rows = ids && ids.length > 0
      ? await this.db.select().from(triageItems).where(inArray(triageItems.id, [...ids]))
      : await this.db.select().from(triageItems);
    return rows.map(mapTriageItem);
  }

  async findBySourceId(sourceId: string): Promise<TriageItem | null> {
    const [row] = await this.db.select().from(triageItems)
      .where(eq(triageItems.sourceId, sourceId))
      .limit(1);
    return row ? mapTriageItem(row) : null;
  }

  async findBySourceUrl(sourceUrl: string): Promise<TriageItem | null> {
    const [row] = await this.db.select().from(triageItems)
      .where(eq(triageItems.sourceUrl, sourceUrl))
      .limit(1);
    return row ? mapTriageItem(row) : null;
  }

  async listEmbedBackfillCandidates(
    query: TriageEmbedBackfillQuery,
  ): Promise<TriageEmbedBackfillPage> {
    const conditions = [];
    if (query.source) conditions.push(eq(triageItems.sourcePlatform, query.source));
    if (query.cursor) conditions.push(gt(triageItems.id, query.cursor));
    if (!query.force) {
      // `raw_metadata` is native jsonb in PostgreSQL (always valid), so the
      // SQLite `json_valid`/`json_type` guard collapses to a single `?`
      // (jsonb key-exists) check for the 'embed' key.
      conditions.push(
        sql`NOT (COALESCE(${triageItems.rawMetadata}, '{}'::jsonb) ? 'embed')`,
      );
    }

    const rows = await this.db.select({
      id: triageItems.id,
      sourceUrl: triageItems.sourceUrl,
      canonicalUrl: triageItems.canonicalUrl,
    }).from(triageItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(triageItems.id))
      .limit(query.limit);

    const items: TriageEmbedBackfillCandidate[] = rows.map((row) => ({
      id: row.id,
      sourceUrl: row.sourceUrl,
      canonicalUrl: row.canonicalUrl ?? undefined,
    }));
    const nextCursor = items.length === query.limit
      ? items[items.length - 1]?.id ?? null
      : null;

    return { items, nextCursor };
  }

  async listMissingThumbnailCandidates(
    input?: { readonly source?: string },
  ): Promise<TriageMissingThumbnailCandidate[]> {
    const conditions = [isNull(triageItems.thumbnailUrl)];
    if (input?.source) conditions.push(eq(triageItems.sourcePlatform, input.source));

    const rows = await this.db.select({
      id: triageItems.id,
      sourcePlatform: triageItems.sourcePlatform,
      sourceUrl: triageItems.sourceUrl,
      rawMetadata: triageItems.rawMetadata,
    }).from(triageItems).where(and(...conditions));

    return rows.map((row) => ({
      id: row.id,
      sourcePlatform: row.sourcePlatform as TriageSourcePlatform,
      sourceUrl: row.sourceUrl,
      rawMetadata: parseObjectOrEmpty(row.rawMetadata),
    }));
  }

  async fillThumbnailIfNull(id: string, thumbnailUrl: string): Promise<boolean> {
    const result = await this.db.update(triageItems)
      .set({ thumbnailUrl })
      .where(and(eq(triageItems.id, id), isNull(triageItems.thumbnailUrl)))
      .returning({ id: triageItems.id });
    return result.length === 1;
  }

  async setThumbnail(id: string, thumbnailUrl: string): Promise<boolean> {
    const result = await this.db.update(triageItems)
      .set({ thumbnailUrl })
      .where(eq(triageItems.id, id))
      .returning({ id: triageItems.id });
    return result.length === 1;
  }
}

class PostgresTriageContentTypeRepository implements TriageContentTypeRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async list(): Promise<TriageContentTypeRecord[]> {
    const rows = await this.db.select().from(triageContentTypes);
    return rows.map(mapContentTypeRow);
  }

  async upsert(record: TriageContentTypeUpsertInput): Promise<void> {
    await this.db.insert(triageContentTypes).values({
      id: record.id,
      name: record.name,
      icon: record.icon,
      color: record.color,
      builtin: record.builtin,
      suppressed: record.suppressed,
      priority: record.priority,
      urlPatterns: [...record.urlPatterns],
      keywordHints: [...record.keywordHints],
      description: record.description,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }).onConflictDoUpdate({
      target: triageContentTypes.id,
      set: {
        name: record.name,
        icon: record.icon,
        color: record.color,
        builtin: record.builtin,
        suppressed: record.suppressed,
        priority: record.priority,
        urlPatterns: [...record.urlPatterns],
        keywordHints: [...record.keywordHints],
        description: record.description,
        updatedAt: record.updatedAt,
        // createdAt is intentionally omitted so an update never overwrites
        // the row's original creation timestamp (matches the SQLite adapter).
      },
    });
  }

  async deleteCustom(id: string): Promise<boolean> {
    const result = await this.db.delete(triageContentTypes)
      .where(eq(triageContentTypes.id, id))
      .returning({ id: triageContentTypes.id });
    return result.length > 0;
  }

  async setSuppressed(input: TriageContentTypeSuppressionInput): Promise<void> {
    const [updated] = await this.db.update(triageContentTypes)
      .set({ suppressed: input.suppressed, updatedAt: input.updatedAt })
      .where(eq(triageContentTypes.id, input.id))
      .returning({ id: triageContentTypes.id });
    if (updated) return;
    if (!input.builtin) return;

    await this.db.insert(triageContentTypes).values({
      id: input.id,
      name: input.builtin.name,
      icon: input.builtin.icon,
      color: input.builtin.color,
      builtin: true,
      suppressed: input.suppressed,
      priority: input.builtin.priority,
      urlPatterns: [...input.builtin.urlPatterns],
      keywordHints: [...input.builtin.keywordHints],
      description: input.builtin.description,
      createdAt: input.builtin.createdAt,
      updatedAt: input.updatedAt,
    }).onConflictDoNothing();
  }
}

class PostgresTriageQueueHealthRepository implements TriageQueueHealthRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getPendingSnapshot(): Promise<TriageQueueHealthPendingSnapshotEntry[]> {
    const rows = await this.db.select({
      capturedAt: triageItems.capturedAt,
      sourcePlatform: triageItems.sourcePlatform,
    }).from(triageItems).where(eq(triageItems.status, 'pending'));
    return rows.map((row) => ({
      capturedAt: row.capturedAt,
      sourcePlatform: row.sourcePlatform as TriageSourcePlatform,
    }));
  }

  async getDigestSnapshot(input: TriageDigestSnapshotInput): Promise<TriageDigestSnapshot> {
    const newItemRows = await this.db.select({
      sourcePlatform: triageItems.sourcePlatform,
      count: sql<number>`count(*)`,
    }).from(triageItems)
      .where(gte(triageItems.ingestedAt, input.periodStart))
      .groupBy(triageItems.sourcePlatform);

    const actionedRows = await this.db.select({
      status: triageItems.status,
      count: sql<number>`count(*)`,
    }).from(triageItems)
      .where(and(
        sql`${triageItems.status} IN ('actioned', 'dismissed')`,
        gte(triageItems.ingestedAt, input.periodStart),
      ))
      .groupBy(triageItems.status);

    const [queueDepthRow] = await this.db.select({ count: sql<number>`count(*)` })
      .from(triageItems)
      .where(eq(triageItems.status, 'pending'));

    const [staleCountRow] = await this.db.select({ count: sql<number>`count(*)` })
      .from(triageItems)
      .where(and(
        eq(triageItems.status, 'pending'),
        sql`${triageItems.capturedAt} < ${input.staleBeforeAt}`,
      ));

    const topPendingRows = await this.db.select({
      id: triageItems.id,
      title: triageItems.title,
      capturedAt: triageItems.capturedAt,
      aiSuggestedActions: triageItems.aiSuggestedActions,
    }).from(triageItems)
      .where(eq(triageItems.status, 'pending'))
      .orderBy(asc(triageItems.capturedAt))
      .limit(input.topPendingLimit);

    return {
      newItemsBySource: Object.fromEntries(
        newItemRows.map((row) => [row.sourcePlatform, toNumber(row.count)]),
      ),
      actionedByStatus: Object.fromEntries(
        actionedRows.map((row) => [row.status, toNumber(row.count)]),
      ),
      queueDepth: toNumber(queueDepthRow?.count),
      staleCount: toNumber(staleCountRow?.count),
      topPending: topPendingRows.map((row) => ({
        id: row.id,
        title: row.title,
        capturedAt: row.capturedAt,
        aiSuggestedActions: parseArrayOrEmpty<TriageSuggestedAction>(
          row.aiSuggestedActions,
        ),
      })),
    };
  }
}

class PostgresTriageMaintenanceRepository implements TriageMaintenanceRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db.select({
      status: triageItems.status,
      count: sql<number>`count(*)`,
    }).from(triageItems).groupBy(triageItems.status);
    return Object.fromEntries(rows.map((row) => [row.status, toNumber(row.count)]));
  }

  async countBySource(): Promise<Record<string, number>> {
    const rows = await this.db.select({
      sourcePlatform: triageItems.sourcePlatform,
      count: sql<number>`count(*)`,
    }).from(triageItems).groupBy(triageItems.sourcePlatform);
    return Object.fromEntries(rows.map((row) => [row.sourcePlatform, toNumber(row.count)]));
  }

  async countCachedThumbnails(): Promise<number> {
    const [row] = await this.db.select({ count: sql<number>`count(*)` })
      .from(triageItems)
      .where(sql`${triageItems.thumbnailUrl} ILIKE ${`${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`}`);
    return toNumber(row?.count);
  }

  async countExternalThumbnails(): Promise<number> {
    const [row] = await this.db.select({ count: sql<number>`count(*)` })
      .from(triageItems)
      .where(and(
        sql`${triageItems.thumbnailUrl} IS NOT NULL`,
        sql`${triageItems.thumbnailUrl} NOT ILIKE ${`${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`}`,
        sql`${triageItems.thumbnailUrl} NOT ILIKE ${`${TRIAGE_CAPTURE_IMAGE_URL_PREFIX}%`}`,
      ));
    return toNumber(row?.count);
  }

  async listCachedThumbnailFilenames(): Promise<string[]> {
    const rows = await this.db.select({ thumbnailUrl: triageItems.thumbnailUrl })
      .from(triageItems)
      .where(sql`${triageItems.thumbnailUrl} ILIKE ${`${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`}`);
    const filenames = new Set<string>();
    for (const row of rows) {
      if (!row.thumbnailUrl) continue;
      const filename = row.thumbnailUrl.split('/').pop();
      if (filename) filenames.add(filename);
    }
    return [...filenames];
  }

  async clearExternalThumbnails(): Promise<number> {
    const result = await this.db.update(triageItems)
      .set({ thumbnailUrl: null })
      .where(and(
        sql`${triageItems.thumbnailUrl} IS NOT NULL`,
        sql`${triageItems.thumbnailUrl} NOT ILIKE ${`${TRIAGE_CACHED_THUMBNAIL_URL_PREFIX}%`}`,
        sql`${triageItems.thumbnailUrl} NOT ILIKE ${`${TRIAGE_CAPTURE_IMAGE_URL_PREFIX}%`}`,
      ))
      .returning({ id: triageItems.id });
    return result.length;
  }

  async countDismissedBefore(cutoff: string): Promise<number> {
    const [row] = await this.db.select({ count: sql<number>`count(*)` })
      .from(triageItems)
      .where(and(
        eq(triageItems.status, 'dismissed'),
        sql`${triageItems.ingestedAt} < ${cutoff}`,
      ));
    return toNumber(row?.count);
  }

  async purgeDismissedBefore(cutoff: string): Promise<TriageStorageRefRow[]> {
    return this.db.transaction(async (tx) => {
      return tx.delete(triageItems).where(and(
        eq(triageItems.status, 'dismissed'),
        sql`${triageItems.ingestedAt} < ${cutoff}`,
      )).returning({
        id: triageItems.id,
        thumbnailUrl: triageItems.thumbnailUrl,
        sourceUrl: triageItems.sourceUrl,
      });
    });
  }

  async deleteBySource(input: TriageDeleteBySourceInput): Promise<TriageStorageRefRow[]> {
    const condition = input.includeActioned
      ? eq(triageItems.sourcePlatform, input.source)
      : and(
          eq(triageItems.sourcePlatform, input.source),
          inArray(triageItems.status, ['pending', 'dismissed']),
        );

    return this.db.transaction(async (tx) => {
      return tx.delete(triageItems).where(condition).returning({
        id: triageItems.id,
        thumbnailUrl: triageItems.thumbnailUrl,
        sourceUrl: triageItems.sourceUrl,
      });
    });
  }

  async deleteByIds(ids: readonly string[]): Promise<TriageStorageRefRow[]> {
    if (ids.length === 0) return [];

    return this.db.transaction(async (tx) => {
      return tx.delete(triageItems)
        .where(inArray(triageItems.id, [...ids]))
        .returning({
        id: triageItems.id,
        thumbnailUrl: triageItems.thumbnailUrl,
        sourceUrl: triageItems.sourceUrl,
        });
    });
  }
}

class PostgresNativeCredentialRepository implements NativeCredentialRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async findInstallationCredential(id: string) {
    const [row] = await this.db.select({
      id: nativeInstallationCredentials.id,
      installationId: nativeInstallationCredentials.installationId,
      tokenHash: nativeInstallationCredentials.tokenHash,
      scopes: nativeInstallationCredentials.scopes,
      expiresAt: nativeInstallationCredentials.expiresAt,
      revokedAt: nativeInstallationCredentials.revokedAt,
    }).from(nativeInstallationCredentials)
      .where(eq(nativeInstallationCredentials.id, id))
      .limit(1);
    return row ?? null;
  }

  async findShareCredential(id: string) {
    const [row] = await this.db.select({
      id: nativeShareCredentials.id,
      tokenHash: nativeShareCredentials.tokenHash,
      scope: nativeShareCredentials.scope,
      expiresAt: nativeShareCredentials.expiresAt,
      revokedAt: nativeShareCredentials.revokedAt,
    }).from(nativeShareCredentials)
      .where(eq(nativeShareCredentials.id, id))
      .limit(1);
    return row ?? null;
  }
}

class PostgresNativeShareCaptureRepository implements NativeShareCaptureRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async claim(input: NativeShareCaptureClaimInput): Promise<NativeShareCaptureClaim> {
    return this.db.transaction(async (tx): Promise<NativeShareCaptureClaim> => {
      await this.lock(tx, input.credentialId);
      await tx.delete(nativeShareCaptureRequests)
        .where(lt(nativeShareCaptureRequests.createdAt, input.retentionCutoff));

      const [existing] = await tx.select({
        payloadHash: nativeShareCaptureRequests.payloadHash,
        itemId: nativeShareCaptureRequests.itemId,
      }).from(nativeShareCaptureRequests).where(and(
        eq(nativeShareCaptureRequests.credentialId, input.credentialId),
        eq(nativeShareCaptureRequests.requestId, input.requestId),
      )).limit(1);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) return { status: 'replay' };
        if (existing.itemId) return { status: 'duplicate', itemId: existing.itemId };
        return { status: 'pending' };
      }

      const [recent] = await tx.select({ count: sql<number>`count(*)` })
        .from(nativeShareCaptureRequests)
        .where(and(
          eq(nativeShareCaptureRequests.credentialId, input.credentialId),
          gte(nativeShareCaptureRequests.createdAt, input.rateWindowStart),
        ));
      if (toNumber(recent?.count) >= input.maximumCaptures) {
        return { status: 'rateLimited' };
      }

      await tx.insert(nativeShareCaptureRequests).values({
        credentialId: input.credentialId,
        requestId: input.requestId,
        payloadHash: input.payloadHash,
        reservationId: input.reservationId,
        itemId: null,
        createdAt: input.now,
        completedAt: null,
      });
      return { status: 'acquired', reservationId: input.reservationId };
    });
  }

  async complete(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly reservationId: string;
    readonly payloadHash: string;
    readonly itemId: string;
    readonly completedAt: string;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, input.credentialId);
      const changed = await tx.update(nativeShareCaptureRequests).set({
        itemId: input.itemId,
        completedAt: input.completedAt,
      }).where(and(
        eq(nativeShareCaptureRequests.credentialId, input.credentialId),
        eq(nativeShareCaptureRequests.requestId, input.requestId),
        eq(nativeShareCaptureRequests.reservationId, input.reservationId),
        eq(nativeShareCaptureRequests.payloadHash, input.payloadHash),
        isNull(nativeShareCaptureRequests.itemId),
      )).returning({ credentialId: nativeShareCaptureRequests.credentialId });
      if (changed.length === 1) return true;

      const [existing] = await tx.select({
        reservationId: nativeShareCaptureRequests.reservationId,
        payloadHash: nativeShareCaptureRequests.payloadHash,
        itemId: nativeShareCaptureRequests.itemId,
      }).from(nativeShareCaptureRequests).where(and(
        eq(nativeShareCaptureRequests.credentialId, input.credentialId),
        eq(nativeShareCaptureRequests.requestId, input.requestId),
      )).limit(1);
      return existing?.reservationId === input.reservationId
        && existing.payloadHash === input.payloadHash
        && existing.itemId === input.itemId;
    });
  }

  async release(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly reservationId: string;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, input.credentialId);
      const deleted = await tx.delete(nativeShareCaptureRequests).where(and(
        eq(nativeShareCaptureRequests.credentialId, input.credentialId),
        eq(nativeShareCaptureRequests.requestId, input.requestId),
        eq(nativeShareCaptureRequests.reservationId, input.reservationId),
        isNull(nativeShareCaptureRequests.itemId),
      )).returning({ credentialId: nativeShareCaptureRequests.credentialId });
      return deleted.length === 1;
    });
  }

  private async lock(tx: PostgresTransaction, credentialId: string): Promise<void> {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${`mission-control:native-share:${credentialId}`})
      )
    `);
  }
}

class PostgresNativeApnsRepository implements NativeApnsRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async register(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly payloadHash: string;
    readonly legacyPayloadHash: string;
    readonly registrationId: string;
    readonly installationId: string;
    readonly tokenCiphertext: string;
    readonly tokenHash: string;
    readonly environment: string;
    readonly topic: string;
    readonly appVersion: string;
    readonly buildNumber: number;
    readonly locale: string;
    readonly timeZone: string;
    readonly now: string;
  }): Promise<NativeApnsRegistrationOutcome> {
    return this.db.transaction(
      async (tx): Promise<NativeApnsRegistrationOutcome> => {
        await this.lock(tx);
        const prior = await this.replay(
          tx,
          input.credentialId,
          input.requestId,
          'register',
          input.payloadHash,
          input.legacyPayloadHash,
        );
        if (prior) return prior;
        const [activeCredential] = await tx.select({ id: nativeInstallationCredentials.id })
          .from(nativeInstallationCredentials)
          .where(and(
            eq(nativeInstallationCredentials.id, input.credentialId),
            eq(nativeInstallationCredentials.installationId, input.installationId),
            isNull(nativeInstallationCredentials.revokedAt),
          ))
          .limit(1);
        if (!activeCredential) return { status: 'credentialRevoked' };

        const [existing] = await tx.select({
          id: apnsRegistrations.id,
          tokenHash: apnsRegistrations.tokenHash,
          tokenCiphertext: apnsRegistrations.tokenCiphertext,
          invalidatedAt: apnsRegistrations.invalidatedAt,
        }).from(apnsRegistrations).where(and(
          eq(apnsRegistrations.installationId, input.installationId),
          eq(apnsRegistrations.environment, input.environment),
          eq(apnsRegistrations.topic, input.topic),
        )).limit(1);
        const registrationId = existing?.id ?? input.registrationId;

        await tx.update(apnsRegistrations).set({
          invalidatedAt: input.now,
          invalidationReason: 'token_reassigned',
          updatedAt: input.now,
        }).where(and(
          eq(apnsRegistrations.tokenHash, input.tokenHash),
          eq(apnsRegistrations.environment, input.environment),
          eq(apnsRegistrations.topic, input.topic),
          isNull(apnsRegistrations.invalidatedAt),
          ne(apnsRegistrations.id, registrationId),
        ));
        await tx.update(apnsRegistrations).set({
          invalidatedAt: input.now,
          invalidationReason: 'target_changed',
          updatedAt: input.now,
        }).where(and(
          eq(apnsRegistrations.installationId, input.installationId),
          isNull(apnsRegistrations.invalidatedAt),
          ne(apnsRegistrations.id, registrationId),
        ));

        const state = existing && !existing.invalidatedAt && existing.tokenHash !== input.tokenHash
          ? 'rotated' as const
          : 'registered' as const;
        if (existing) {
          await tx.update(apnsRegistrations).set({
            tokenCiphertext: existing.tokenHash === input.tokenHash
              ? existing.tokenCiphertext
              : input.tokenCiphertext,
            tokenHash: input.tokenHash,
            appVersion: input.appVersion,
            buildNumber: input.buildNumber,
            locale: input.locale,
            timeZone: input.timeZone,
            updatedAt: input.now,
            lastSeenAt: input.now,
            invalidatedAt: null,
            invalidationReason: null,
          }).where(eq(apnsRegistrations.id, registrationId));
        } else {
          await tx.insert(apnsRegistrations).values({
            id: registrationId,
            installationId: input.installationId,
            tokenCiphertext: input.tokenCiphertext,
            tokenHash: input.tokenHash,
            environment: input.environment,
            topic: input.topic,
            appVersion: input.appVersion,
            buildNumber: input.buildNumber,
            locale: input.locale,
            timeZone: input.timeZone,
            createdAt: input.now,
            updatedAt: input.now,
            lastSeenAt: input.now,
            invalidatedAt: null,
            invalidationReason: null,
          });
        }

        const responseBody: NativeApnsRegistrationStoredResponse = {
          kind: 'registration',
          registrationId,
          state,
          updatedAt: input.now,
        };
        const response = {
          responseStatus: existing ? 200 : 201,
          responseBody,
        };
        await this.store(
          tx,
          input.credentialId,
          input.requestId,
          'register',
          input.payloadHash,
          response,
          input.now,
        );
        return { status: 'applied', response };
      },
    );
  }

  async unregister(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly payloadHash: string;
    readonly legacyPayloadHash: string;
    readonly registrationId: string;
    readonly installationId: string;
    readonly now: string;
  }): Promise<NativeApnsUnregistrationOutcome> {
    const operation = `unregister:${input.registrationId}`;
    return this.db.transaction(async (tx): Promise<NativeApnsUnregistrationOutcome> => {
      await this.lock(tx);
      const prior = await this.replay(
        tx,
        input.credentialId,
        input.requestId,
        operation,
        input.payloadHash,
        input.legacyPayloadHash,
      );
      if (prior) return prior;
      const [registration] = await tx.select({ id: apnsRegistrations.id })
        .from(apnsRegistrations)
        .where(and(
          eq(apnsRegistrations.id, input.registrationId),
          eq(apnsRegistrations.installationId, input.installationId),
        ))
        .limit(1);
      if (!registration) return { status: 'notOwned' };

      await tx.update(apnsRegistrations).set({
        invalidatedAt: sql`COALESCE(${apnsRegistrations.invalidatedAt}, ${input.now})`,
        invalidationReason: sql`COALESCE(${apnsRegistrations.invalidationReason}, 'user_unregistered')`,
        updatedAt: input.now,
      }).where(eq(apnsRegistrations.id, registration.id));
      const responseBody: NativeApnsUnregistrationStoredResponse = {
        kind: 'unregistration',
        registrationId: registration.id,
        state: 'unregistered',
        updatedAt: input.now,
      };
      const response = { responseStatus: 200, responseBody };
      await this.store(
        tx,
        input.credentialId,
        input.requestId,
        operation,
        input.payloadHash,
        response,
        input.now,
      );
      return { status: 'applied', response };
    });
  }

  async logout(input: { readonly installationId: string; readonly now: string }) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx);
      const installationCredentials = await tx.update(nativeInstallationCredentials).set({
        revokedAt: input.now,
      }).where(and(
        eq(nativeInstallationCredentials.installationId, input.installationId),
        isNull(nativeInstallationCredentials.revokedAt),
      )).returning({ id: nativeInstallationCredentials.id });
      const shareCredentials = await tx.update(nativeShareCredentials).set({
        revokedAt: input.now,
      }).where(and(
        eq(nativeShareCredentials.installationId, input.installationId),
        isNull(nativeShareCredentials.revokedAt),
      )).returning({ id: nativeShareCredentials.id });
      const registrations = await tx.update(apnsRegistrations).set({
        invalidatedAt: input.now,
        invalidationReason: 'logout',
        updatedAt: input.now,
      }).where(and(
        eq(apnsRegistrations.installationId, input.installationId),
        isNull(apnsRegistrations.invalidatedAt),
      )).returning({ id: apnsRegistrations.id });
      return {
        credentialsRevoked: installationCredentials.length + shareCredentials.length,
        registrationsRetired: registrations.length,
      };
    });
  }

  private async lock(tx: PostgresTransaction): Promise<void> {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext('mission-control:native-apns'))
    `);
  }

  private async replay(
    tx: PostgresTransaction,
    credentialId: string,
    requestId: string,
    operation: string,
    payloadHash: string,
    legacyPayloadHash: string,
  ): Promise<NativeRequestOutcome<never> | null> {
    const [prior] = await tx.select({
      operation: nativePushRequests.operation,
      payloadHash: nativePushRequests.payloadHash,
      responseStatus: nativePushRequests.responseStatus,
      responseBody: nativePushRequests.responseBody,
    }).from(nativePushRequests).where(and(
      eq(nativePushRequests.credentialId, credentialId),
      eq(nativePushRequests.requestId, requestId),
    )).limit(1);
    if (!prior) return null;
    if (
      prior.operation !== operation
      || (prior.payloadHash !== payloadHash && prior.payloadHash !== legacyPayloadHash)
    ) {
      return { status: 'mismatch' };
    }
    return {
      status: 'replay',
      response: {
        responseStatus: prior.responseStatus,
        responseBody: prior.responseBody,
      },
    };
  }

  private async store(
    tx: PostgresTransaction,
    credentialId: string,
    requestId: string,
    operation: string,
    payloadHash: string,
    response: { readonly responseStatus: number; readonly responseBody: unknown },
    now: string,
  ): Promise<void> {
    await tx.insert(nativePushRequests).values({
      credentialId,
      requestId,
      operation,
      payloadHash,
      responseStatus: response.responseStatus,
      responseBody: response.responseBody,
      createdAt: now,
    });
  }
}

export function createPostgresTriagePersistenceRepositories(
  db: PostgresDatabase,
): TriagePersistenceRepositories {
  return {
    capture: new PostgresTriageCaptureRepository(db),
    syncState: new PostgresTriageSyncStateRepository(db),
    githubCredentialFallback: new PostgresGitHubCredentialFallbackRepository(db),
    items: new PostgresTriageQueueItemRepository(db),
    contentTypes: new PostgresTriageContentTypeRepository(db),
    health: new PostgresTriageQueueHealthRepository(db),
    maintenance: new PostgresTriageMaintenanceRepository(db),
    native: {
      credentials: new PostgresNativeCredentialRepository(db),
      shareCapture: new PostgresNativeShareCaptureRepository(db),
      apns: new PostgresNativeApnsRepository(db),
    },
  };
}
