import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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
} from '@/db/persistence/triage-repositories';
import type { PostgresDatabase } from '../runtime';
import { connectorConfigs, triageItems, triageSyncState } from '../schema';

type TriageItemRow = typeof triageItems.$inferSelect;
type TriageSyncStateRow = typeof triageSyncState.$inferSelect;

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
    aiCategories: parseArray<string>(
      row.aiCategories,
      'triage_items.ai_categories',
    ),
    aiSuggestedActions: parseArray<TriageSuggestedAction>(
      row.aiSuggestedActions,
      'triage_items.ai_suggested_actions',
    ),
    aiRelevanceScore: row.aiRelevanceScore,
    aiUrgency: row.aiUrgency as TriageItem['aiUrgency'],
    rawMetadata: parseObject(row.rawMetadata, 'triage_items.raw_metadata'),
    actionsTaken: parseArray<TriageActionRecord>(
      row.actionsTaken,
      'triage_items.actions_taken',
    ),
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

class PostgresTriageCaptureRepository implements TriageCaptureRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async captureBatch(
    items: readonly TriageItem[],
  ): Promise<readonly TriageCaptureOutcome[]> {
    assertValidTriageCaptureBatch(items);
    return this.db.transaction(async (tx) => {
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

export function createPostgresTriagePersistenceRepositories(
  db: PostgresDatabase,
): TriagePersistenceRepositories {
  return {
    capture: new PostgresTriageCaptureRepository(db),
    syncState: new PostgresTriageSyncStateRepository(db),
    githubCredentialFallback: new PostgresGitHubCredentialFallbackRepository(db),
  };
}
