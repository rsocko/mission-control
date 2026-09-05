import 'server-only';

import { randomUUID } from 'node:crypto';
import { FinanceWebPersistenceError } from '@/db/persistence/finance-web';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  ConnectorConfig,
  DomainSyncContext,
  DomainSyncResult,
} from '@/types';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from './client';
import {
  MONARCH_TRANSACTION_MAX_BACKFILL_DAYS,
} from './constants';
import { FinanceAttributionCoordinator } from './attribution-coordinator';

const DEFAULT_BACKFILL_DAYS = 90;
const DEFAULT_OVERLAP_DAYS = 7;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGES = 10_000;
const MUTATION_CLAIM_STALE_MS = 15 * 60_000;

type SyncMode = 'backfill' | 'incremental';

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function subtractDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return dateOnly(date);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.min(Math.max(parsed, minimum), maximum)
    : fallback;
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof MonarchBridgeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && /cancel/i.test(error.message)) {
    return { code: 'sync_cancelled', message: 'Finance sync was cancelled' };
  }
  return { code: 'sync_failed', message: 'Finance snapshot sync failed' };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled');
  }
}

export class FinanceSnapshotSynchronizer {
  private readonly client: MonarchBridgeClient;

  constructor(private readonly config: ConnectorConfig) {
    this.client = new MonarchBridgeClient(config);
  }

  async sync(context: DomainSyncContext): Promise<DomainSyncResult> {
    const connectorId = this.config.id;
    const finance = (await getWorkerPersistenceRepositories()).finance;
    const settings = (this.config.settings ?? {}) as Record<string, unknown>;
    const backfillDays = boundedInteger(
      settings.backfillDays,
      DEFAULT_BACKFILL_DAYS,
      1,
      MONARCH_TRANSACTION_MAX_BACKFILL_DAYS,
    );
    const overlapDays = boundedInteger(
      settings.overlapDays,
      DEFAULT_OVERLAP_DAYS,
      1,
      MONARCH_TRANSACTION_MAX_BACKFILL_DAYS,
    );
    const pageSize = boundedInteger(settings.pageSize, DEFAULT_PAGE_SIZE, 1, 500);
    const now = new Date();
    const today = dateOnly(now);
    const stableTagRecoveryStart = subtractDays(
      today,
      MONARCH_TRANSACTION_MAX_BACKFILL_DAYS - 1,
    );
    const state = await finance.snapshots.readBasis(
      connectorId,
      stableTagRecoveryStart,
    );
    const needsStableTagBackfill = state.needsStableTagBackfill;
    const mode: SyncMode = context.full
      || !state?.lastSuccessfulWindowEnd
      || needsStableTagBackfill
      ? 'backfill'
      : 'incremental';
    const effectiveBackfillDays = needsStableTagBackfill
      ? MONARCH_TRANSACTION_MAX_BACKFILL_DAYS
      : backfillDays;
    const windowStart = mode === 'backfill'
      ? subtractDays(today, effectiveBackfillDays - 1)
      : subtractDays(state!.lastSuccessfulWindowEnd!, overlapDays);
    const windowEnd = today;
    const generationId = randomUUID();
    const attemptAt = now.toISOString();

    await finance.snapshots.start({
      connectorId,
      generationId,
      windowStart,
      windowEnd,
      mode,
      attemptAt,
    });

    let added = 0;
    let updated = 0;
    let cursor: string | undefined;
    let sourceAsOf: string | null = null;
    const seenCursors = new Set<string>();
    const attribution = new FinanceAttributionCoordinator(connectorId, {
      financeConfig: this.config,
      persistence: finance,
      generationId,
    });
    try {
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
        throwIfAborted(context.signal);
        const page = await this.client.getTransactionsPage({
          startDate: windowStart,
          endDate: windowEnd,
          limit: pageSize,
          cursor,
        }, context.signal);
        throwIfAborted(context.signal);
        const provenance = {
          ...page.provenance,
          fetchedAt: new Date(page.provenance.fetchedAt).toISOString(),
        };
        if (
          sourceAsOf === null
          || Date.parse(provenance.fetchedAt) < Date.parse(sourceAsOf)
        ) {
          sourceAsOf = provenance.fetchedAt;
        }
        const counts = await finance.snapshots.upsertPage({
          connectorId,
          generationId,
          transactions: page.transactions,
          provenance,
          observedAt: new Date().toISOString(),
        });
        added += counts.added;
        updated += counts.updated;
        await attribution.attributePage(
          page.transactions,
          provenance.fetchedAt,
          context.signal,
        );
        if (!page.page.nextCursor) break;
        if (seenCursors.has(page.page.nextCursor)) {
          throw new MonarchBridgeError('invalid_cursor', 'Monarch Bridge repeated a page cursor', false);
        }
        seenCursors.add(page.page.nextCursor);
        cursor = page.page.nextCursor;
        if (pageNumber === MAX_PAGES - 1) {
          throw new MonarchBridgeError('pagination_limit', 'Finance snapshot exceeded the page safety limit', false);
        }
      }

      throwIfAborted(context.signal);
      if (sourceAsOf === null) {
        throw new MonarchBridgeError(
          'invalid_contract',
          'Invalid Monarch Bridge transaction provenance',
          false,
        );
      }
      const completedAt = new Date().toISOString();
      const { removed } = await finance.snapshots.complete({
        connectorId,
        generationId,
        windowStart,
        windowEnd,
        projectionStartDate: stableTagRecoveryStart,
        sourceAsOf,
        completedAt,
        added,
        updated,
      });
      await attribution.finish(completedAt);
      return { itemsAdded: added, itemsUpdated: updated, itemsRemoved: removed };
    } catch (error) {
      const failure = errorDetails(error);
      const failedAt = new Date().toISOString();
      await finance.snapshots.fail({
        connectorId,
        generationId,
        failedAt,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      await attribution.finish(failedAt);
      throw error;
    }
  }
}

export async function updateFinanceCategory(
  config: ConnectorConfig,
  transactionId: string,
  categoryId: string,
  idempotencyKey: string = randomUUID(),
  signal?: AbortSignal,
  expectedTransactionVersion?: {
    sourceFingerprint: string;
    lastSeenAt: string;
    assignedKidId: string | null;
    confirmedCategory: string | null;
    manualDecidedAt: string | null;
    categoryName: string;
  },
): Promise<{ idempotencyKey: string; status: 'updated' }> {
  const now = new Date().toISOString();
  const web = (await getWorkerPersistenceRepositories()).finance.web;
  let claim;
  try {
    claim = await web.claimCategoryUpdate({
      connectorId: config.id,
      transactionId,
      categoryId,
      idempotencyKey,
      now,
      staleBefore: new Date(Date.now() - MUTATION_CLAIM_STALE_MS).toISOString(),
      expectedTransactionVersion,
    });
  } catch (error) {
    if (error instanceof FinanceWebPersistenceError) {
      throw new MonarchBridgeError(
        error.code,
        error.message,
        error.retryable,
        error.status,
      );
    }
    throw error;
  }
  if (claim.outcome === 'replayed') return { idempotencyKey, status: 'updated' };

  try {
    await new MonarchBridgeClient(config).updateCategory(
      claim.upstreamTransactionId,
      categoryId,
      signal,
    );
    const completedAt = new Date().toISOString();
    const completed = await web.completeCategoryUpdate({
      connectorId: config.id,
      transactionId,
      categoryId,
      idempotencyKey,
      claimToken: claim.claimToken,
      completedAt,
    });
    if (!completed) {
      throw new MonarchBridgeError(
        'mutation_claim_lost',
        'Category update claim was superseded',
        true,
        409,
      );
    }
    return { idempotencyKey, status: 'updated' };
  } catch (error) {
    const failure = errorDetails(error);
    await web.failCategoryUpdate({
      connectorId: config.id,
      idempotencyKey,
      claimToken: claim.claimToken,
      errorCode: failure.code,
      errorMessage: failure.message,
      failedAt: new Date().toISOString(),
    });
    throw error;
  }
}
