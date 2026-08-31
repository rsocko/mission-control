import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  ConnectorConfig,
  DomainSyncContext,
  DomainSyncResult,
} from '@/types';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
  type MonarchTransaction,
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

function localTransactionId(connectorId: string, upstreamId: string): string {
  return `finance:${connectorId}:${upstreamId}`;
}

function fingerprint(transaction: MonarchTransaction): string {
  return createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
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

export function upsertFinanceTransactionPage(
  connectorId: string,
  generationId: string,
  transactions: MonarchTransaction[],
  provenance: { provider: 'demo' | 'live'; fetchedAt: string },
  now: string,
): { added: number; updated: number } {
  const find = sqlite.prepare(`
    SELECT id, source_fingerprint AS sourceFingerprint
    FROM finance_transactions
    WHERE connector_instance_id = ? AND upstream_transaction_id = ?
  `);
  const insert = sqlite.prepare(`
    INSERT INTO finance_transactions (
      id, connector_instance_id, upstream_transaction_id, date, amount,
      merchant_name, merchant_logo_url, category_id, original_category,
      confirmed_category, account_id, account_name, card_last4,
      assigned_kid_id, kid_assignment_method, triage_status, flag_reason,
      is_pending, is_recurring, notes, tags, tag_references, lifecycle_status, deleted_at,
      provenance_provider, provenance_fetched_at, source_fingerprint, source_url,
      last_seen_generation_id, first_seen_at, last_seen_at, synced_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?,
      NULL, NULL, 'pending', NULL, ?, ?, ?, ?, ?, 'active', NULL,
      ?, ?, ?, NULL, ?, ?, ?, ?
    )
  `);
  const update = sqlite.prepare(`
    UPDATE finance_transactions
    SET date = ?, amount = ?, merchant_name = ?, merchant_logo_url = ?,
        category_id = ?, original_category = ?, account_id = ?, account_name = ?,
        card_last4 = ?, is_pending = ?, is_recurring = ?, notes = ?, tags = ?,
        tag_references = ?,
        lifecycle_status = 'active', deleted_at = NULL, provenance_provider = ?,
        provenance_fetched_at = ?, source_fingerprint = ?,
        last_seen_generation_id = ?, last_seen_at = ?, synced_at = ?
    WHERE connector_instance_id = ? AND upstream_transaction_id = ?
  `);

  return sqlite.transaction(() => {
    let added = 0;
    let updated = 0;
    for (const transaction of transactions) {
      const hash = fingerprint(transaction);
      const existing = find.get(connectorId, transaction.id) as
        | { id: string; sourceFingerprint: string }
        | undefined;
      const values = [
        transaction.date,
        transaction.amount,
        transaction.merchant.name,
        transaction.merchant.logoUrl,
        transaction.category?.id ?? null,
        transaction.category?.name ?? null,
        transaction.account.id,
        transaction.account.displayName,
        transaction.account.mask,
        transaction.isPending ? 1 : 0,
        transaction.isRecurring ? 1 : 0,
        transaction.notes,
        JSON.stringify(transaction.tags),
        JSON.stringify(transaction.tagReferences.map((tag) => tag.id)),
      ] as const;
      if (!existing) {
        insert.run(
          localTransactionId(connectorId, transaction.id),
          connectorId,
          transaction.id,
          ...values,
          provenance.provider,
          provenance.fetchedAt,
          hash,
          generationId,
          now,
          now,
          now,
        );
        added++;
      } else {
        update.run(
          ...values,
          provenance.provider,
          provenance.fetchedAt,
          hash,
          generationId,
          now,
          now,
          connectorId,
          transaction.id,
        );
        if (existing.sourceFingerprint !== hash) updated++;
      }
    }
    return { added, updated };
  }).immediate();
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
  const transaction = sqlite.prepare(`
    SELECT id, upstream_transaction_id AS upstreamTransactionId
    FROM finance_transactions
    WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
  `).get(transactionId, config.id) as
    | { id: string; upstreamTransactionId: string }
    | undefined;
  if (!transaction) {
    throw new MonarchBridgeError('transaction_not_found', 'Finance transaction was not found', false, 404);
  }

  const now = new Date().toISOString();
  const claim = sqlite.transaction(() => {
    const existing = sqlite.prepare(`
      SELECT transaction_id AS transactionId, requested_value AS requestedValue,
             status, updated_at AS updatedAt
      FROM finance_mutation_audit
      WHERE connector_id = ? AND idempotency_key = ?
    `).get(config.id, idempotencyKey) as
      | {
          transactionId: string;
          requestedValue: string;
          status: 'pending' | 'processing' | 'succeeded' | 'failed';
          updatedAt: string;
        }
      | undefined;
    if (existing && (
      existing.transactionId !== transactionId
      || existing.requestedValue !== categoryId
    )) {
      return 'conflict' as const;
    }
    if (existing?.status === 'succeeded') return 'succeeded' as const;
    if (expectedTransactionVersion) {
      const current = sqlite.prepare(`
        SELECT source_fingerprint AS sourceFingerprint,
               last_seen_at AS lastSeenAt, assigned_kid_id AS assignedKidId,
               confirmed_category AS confirmedCategory,
               manual_decided_at AS manualDecidedAt
        FROM finance_transactions
        WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
      `).get(transactionId, config.id) as {
        sourceFingerprint: string;
        lastSeenAt: string;
        assignedKidId: string | null;
        confirmedCategory: string | null;
        manualDecidedAt: string | null;
      } | undefined;
      if (
        !current
        || current.sourceFingerprint !== expectedTransactionVersion.sourceFingerprint
        || current.lastSeenAt !== expectedTransactionVersion.lastSeenAt
        || current.assignedKidId !== expectedTransactionVersion.assignedKidId
        || current.confirmedCategory !== expectedTransactionVersion.confirmedCategory
        || current.manualDecidedAt !== expectedTransactionVersion.manualDecidedAt
      ) {
        return 'transaction-conflict' as const;
      }
      const currentCategory = sqlite.prepare(`
        SELECT name FROM finance_categories
        WHERE connector_id = ? AND upstream_category_id = ?
          AND is_active = 1 AND source_is_active = 1
      `).get(config.id, categoryId) as { name: string } | undefined;
      if (
        !currentCategory
        || currentCategory.name !== expectedTransactionVersion.categoryName
      ) {
        return 'category-conflict' as const;
      }
    }
    const otherProcessingMutation = sqlite.prepare(`
      SELECT 1
      FROM finance_mutation_audit
      WHERE connector_id = ? AND transaction_id = ?
        AND status = 'processing' AND idempotency_key <> ?
      LIMIT 1
    `).get(config.id, transactionId, idempotencyKey);
    if (otherProcessingMutation) return 'processing' as const;
    if (
      existing?.status === 'processing'
      && Date.parse(existing.updatedAt) > Date.now() - MUTATION_CLAIM_STALE_MS
    ) {
      return 'processing' as const;
    }
    if (existing) {
      sqlite.prepare(`
        UPDATE finance_mutation_audit
        SET status = 'processing', attempt_count = attempt_count + 1,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE connector_id = ? AND idempotency_key = ?
      `).run(now, config.id, idempotencyKey);
    } else {
      sqlite.prepare(`
        INSERT INTO finance_mutation_audit (
          id, idempotency_key, connector_id, transaction_id,
          upstream_transaction_id, operation, requested_value, status,
          attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'category_update', ?, 'processing', 1, ?, ?)
      `).run(
        randomUUID(),
        idempotencyKey,
        config.id,
        transactionId,
        transaction.upstreamTransactionId,
        categoryId,
        now,
        now,
      );
    }
    return 'claimed' as const;
  }).immediate();
  if (claim === 'succeeded') return { idempotencyKey, status: 'updated' };
  if (claim === 'conflict') {
    throw new MonarchBridgeError('idempotency_conflict', 'Idempotency key was already used', false, 409);
  }
  if (claim === 'transaction-conflict') {
    throw new MonarchBridgeError('transaction_conflict', 'Finance transaction changed after approval', false, 409);
  }
  if (claim === 'category-conflict') {
    throw new MonarchBridgeError('category_conflict', 'Finance category changed after approval', false, 409);
  }
  if (claim === 'processing') {
    throw new MonarchBridgeError('mutation_in_progress', 'Category update is already in progress', true, 409);
  }

  try {
    await new MonarchBridgeClient(config).updateCategory(
      transaction.upstreamTransactionId,
      categoryId,
      signal,
    );
    const completedAt = new Date().toISOString();
    sqlite.transaction(() => {
      sqlite.prepare(`
        UPDATE finance_transactions
        SET confirmed_category = ?, triage_status = 'confirmed'
        WHERE id = ? AND connector_instance_id = ?
      `).run(categoryId, transactionId, config.id);
      sqlite.prepare(`
        UPDATE finance_mutation_audit
        SET status = 'succeeded', completed_at = ?, updated_at = ?,
            last_error_code = NULL, last_error_message = NULL
        WHERE connector_id = ? AND idempotency_key = ?
      `).run(completedAt, completedAt, config.id, idempotencyKey);
    }).immediate();
    return { idempotencyKey, status: 'updated' };
  } catch (error) {
    const failure = errorDetails(error);
    sqlite.prepare(`
      UPDATE finance_mutation_audit
      SET status = 'failed', last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE connector_id = ? AND idempotency_key = ?
    `).run(
      failure.code,
      failure.message,
      new Date().toISOString(),
      config.id,
      idempotencyKey,
    );
    throw error;
  }
}
