import 'server-only';

import { randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import {
  FINANCE_INSIGHT_ITEM_LIMITS,
  transactionSourceFactSchema,
  type TransactionSourceFactV1,
} from '@/lib/finance-insights/contract';
import type { ConnectorConfig, DomainSyncContext } from '@/types';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
  type MonarchTransaction,
} from './client';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from './constants';

export const FINANCE_INSIGHT_HISTORY_MONTHS = 37;
export const FINANCE_INSIGHT_HISTORY_MAX_SOURCE_AGE_MS = 48 * 60 * 60 * 1_000;
const PAGE_SIZE = 500;
const MAX_PAGES_PER_WINDOW = 1_000;

export type FinanceInsightHistoryWindow = {
  index: number;
  start: string;
  end: string;
};

type WindowProof = FinanceInsightHistoryWindow & {
  sourceAsOf: string;
  itemCount: number;
  digest: string;
};

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseCalendarDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || dateOnly(parsed) !== value) {
    throw new Error('invalid_calendar_date');
  }
  return parsed;
}

export function buildFinanceInsightHistoryWindows(
  coverageEnd: string,
): FinanceInsightHistoryWindow[] {
  const end = parseCalendarDate(coverageEnd);
  const firstMonth = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() - (FINANCE_INSIGHT_HISTORY_MONTHS - 1),
    1,
  ));
  return Array.from({ length: FINANCE_INSIGHT_HISTORY_MONTHS }, (_, index) => {
    const start = new Date(Date.UTC(
      firstMonth.getUTCFullYear(),
      firstMonth.getUTCMonth() + index,
      1,
    ));
    const next = new Date(Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + 1,
      1,
    ));
    const monthEnd = new Date(next.getTime() - 24 * 60 * 60 * 1_000);
    return {
      index,
      start: dateOnly(start),
      end: dateOnly(monthEnd > end ? end : monthEnd),
    };
  });
}

function normalizedName(value: string, maximum: number): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'Unknown merchant').slice(0, maximum);
}

function compareSourceRefs(
  left: TransactionSourceFactV1,
  right: TransactionSourceFactV1,
): number {
  return left.sourceRef < right.sourceRef ? -1 : left.sourceRef > right.sourceRef ? 1 : 0;
}

function amountMinor(value: number): number {
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.000001) {
    throw new MonarchBridgeError(
      'invalid_contract',
      'Monarch Bridge transaction amount precision is invalid',
      false,
    );
  }
  return rounded;
}

function transactionFact(transaction: MonarchTransaction): TransactionSourceFactV1 {
  return transactionSourceFactSchema.parse({
    sourceRef: transaction.id,
    occurredOn: transaction.date,
    amountMinor: amountMinor(transaction.amount),
    merchantName: normalizedName(transaction.merchant.name, 160),
    categoryRef: transaction.category?.id ?? null,
    accountRef: transaction.account.id,
    isPending: transaction.isPending,
    recurringRef: null,
    tagRefs: [...new Set(transaction.tagReferences.map((tag) => tag.id))].sort(),
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled');
  }
}

function failureCode(error: unknown): string {
  if (error instanceof MonarchBridgeError) {
    return `insight_history_${error.code.replace(/[^a-z0-9_]/g, '_').slice(0, 80)}`;
  }
  if (error instanceof Error && /cancel/i.test(error.message)) {
    return 'insight_history_cancelled';
  }
  return 'insight_history_sync_failed';
}

export function financeInsightHistoryGenerationRef(input: {
  connectorRef: string;
  sourceAsOf: string;
  itemCount: number;
  contentDigest: string;
  coverageStart: string;
  coverageEnd: string;
  windowCount: number;
  windowsDigest: string;
  bridgeContractVersion: string;
}): string {
  return `finance-insight-transactions-v1:${financeInsightDigestV1(input).replace('sha256:', '')}`;
}

export class FinanceInsightHistorySynchronizer {
  private readonly client: MonarchBridgeClient;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.client = new MonarchBridgeClient(config);
  }

  async sync(context: DomainSyncContext): Promise<{
    generationId: string;
    sourceAsOf: string;
    itemCount: number;
    coverageStart: string;
    coverageEnd: string;
  }> {
    const connectorId = this.config.id;
    const attemptId = randomUUID();
    const attemptAt = this.clock().toISOString();
    const coverageEnd = dateOnly(this.clock());
    const windows = buildFinanceInsightHistoryWindows(coverageEnd);
    const coverageStart = windows[0]!.start;
    sqlite.transaction(() => {
      sqlite.prepare(`
        INSERT INTO finance_insight_transaction_projection_state (
          connector_id, status, current_attempt_id, last_attempt_at,
          created_at, updated_at
        ) VALUES (?, 'running', ?, ?, ?, ?)
        ON CONFLICT(connector_id) DO UPDATE SET
          status = 'running',
          current_attempt_id = excluded.current_attempt_id,
          last_attempt_at = excluded.last_attempt_at,
          last_error_code = NULL,
          updated_at = excluded.updated_at
      `).run(connectorId, attemptId, attemptAt, attemptAt, attemptAt);
      sqlite.prepare(`
        DELETE FROM finance_insight_transaction_projection_facts
        WHERE connector_id = ?
          AND generation_id <> COALESCE((
            SELECT successful_generation_id
            FROM finance_insight_transaction_projection_state
            WHERE connector_id = ?
          ), '')
      `).run(connectorId, connectorId);
      sqlite.prepare(`
        DELETE FROM finance_insight_transaction_projection_windows
        WHERE connector_id = ?
          AND generation_id <> COALESCE((
            SELECT successful_generation_id
            FROM finance_insight_transaction_projection_state
            WHERE connector_id = ?
          ), '')
      `).run(connectorId, connectorId);
    }).immediate();

    try {
      const allFacts: TransactionSourceFactV1[] = [];
      const allSourceRefs = new Set<string>();
      const windowProofs: WindowProof[] = [];
      for (const window of windows) {
        let cursor: string | undefined;
        let expectedTotal: number | null = null;
        let sourceAsOf: string | null = null;
        const seenCursors = new Set<string>();
        const windowFacts: TransactionSourceFactV1[] = [];
        for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_WINDOW; pageNumber++) {
          throwIfAborted(context.signal);
          const page = await this.client.getTransactionsPage({
            startDate: window.start,
            endDate: window.end,
            limit: PAGE_SIZE,
            cursor,
          }, context.signal);
          throwIfAborted(context.signal);
          if (expectedTotal === null) {
            expectedTotal = page.total;
          } else if (expectedTotal !== page.total) {
            throw new MonarchBridgeError(
              'invalid_contract',
              'Monarch Bridge transaction total changed during pagination',
              false,
            );
          }
          const fetchedAt = new Date(page.provenance.fetchedAt).toISOString();
          if (sourceAsOf === null || Date.parse(fetchedAt) < Date.parse(sourceAsOf)) {
            sourceAsOf = fetchedAt;
          }
          const facts = page.transactions.map((transaction) => {
            if (transaction.date < window.start || transaction.date > window.end) {
              throw new MonarchBridgeError(
                'invalid_contract',
                'Monarch Bridge transaction is outside the requested window',
                false,
              );
            }
            const fact = transactionFact(transaction);
            if (allSourceRefs.has(fact.sourceRef)) {
              throw new MonarchBridgeError(
                'invalid_contract',
                'Monarch Bridge repeated a transaction across history windows',
                false,
              );
            }
            allSourceRefs.add(fact.sourceRef);
            return fact;
          });
          sqlite.transaction(() => {
            const insert = sqlite.prepare(`
              INSERT INTO finance_insight_transaction_projection_facts (
                connector_id, generation_id, source_ref, occurred_on, payload
              ) VALUES (?, ?, ?, ?, ?)
            `);
            for (const fact of facts) {
              insert.run(
                connectorId,
                attemptId,
                fact.sourceRef,
                fact.occurredOn,
                JSON.stringify(fact),
              );
            }
          }).immediate();
          windowFacts.push(...facts);
          allFacts.push(...facts);
          if (allFacts.length > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
            throw new MonarchBridgeError(
              'source_generation_too_large',
              'Finance insight transaction history exceeds the T1 ceiling',
              false,
            );
          }
          if (page.page.nextCursor === null) break;
          if (seenCursors.has(page.page.nextCursor)) {
            throw new MonarchBridgeError(
              'invalid_cursor',
              'Monarch Bridge repeated a history page cursor',
              false,
            );
          }
          seenCursors.add(page.page.nextCursor);
          cursor = page.page.nextCursor;
          if (pageNumber === MAX_PAGES_PER_WINDOW - 1) {
            throw new MonarchBridgeError(
              'pagination_limit',
              'Finance insight history exceeded the page safety limit',
              false,
            );
          }
        }
        if (sourceAsOf === null || expectedTotal === null || windowFacts.length !== expectedTotal) {
          throw new MonarchBridgeError(
            'incomplete_snapshot',
            'Monarch Bridge returned an incomplete history window',
            false,
          );
        }
        windowFacts.sort(compareSourceRefs);
        const proof: WindowProof = {
          ...window,
          sourceAsOf,
          itemCount: windowFacts.length,
          digest: financeInsightDigestV1(windowFacts as CanonicalJsonValue),
        };
        windowProofs.push(proof);
        sqlite.prepare(`
          INSERT INTO finance_insight_transaction_projection_windows (
            connector_id, generation_id, window_index, coverage_start,
            coverage_end, source_as_of, item_count, content_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          connectorId,
          attemptId,
          proof.index,
          proof.start,
          proof.end,
          proof.sourceAsOf,
          proof.itemCount,
          proof.digest,
        );
      }

      allFacts.sort(compareSourceRefs);
      const sourceAsOf = [...windowProofs]
        .sort((left, right) => Date.parse(left.sourceAsOf) - Date.parse(right.sourceAsOf))[0]!
        .sourceAsOf;
      const contentDigest = financeInsightDigestV1(allFacts as CanonicalJsonValue);
      const windowsDigest = financeInsightDigestV1(windowProofs as CanonicalJsonValue);
      const stableGenerationId = financeInsightHistoryGenerationRef({
        connectorRef: connectorId,
        sourceAsOf,
        itemCount: allFacts.length,
        contentDigest,
        coverageStart,
        coverageEnd,
        windowCount: windowProofs.length,
        windowsDigest,
        bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
      });
      const completedAt = this.clock().toISOString();
      const completedTime = Date.parse(completedAt);
      const windowTimes = windowProofs.map((window) => Date.parse(window.sourceAsOf));
      if (
        windowTimes.some((value) => !Number.isFinite(value) || value > completedTime)
        || completedTime - Math.min(...windowTimes) > FINANCE_INSIGHT_HISTORY_MAX_SOURCE_AGE_MS
        || Math.max(...windowTimes) - Math.min(...windowTimes)
          > FINANCE_INSIGHT_HISTORY_MAX_SOURCE_AGE_MS
      ) {
        throw new MonarchBridgeError(
          'stale_snapshot',
          'Finance insight history provenance is outside the freshness boundary',
          false,
        );
      }
      sqlite.transaction(() => {
        const stagedFacts = sqlite.prepare(`
          SELECT payload
          FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id = ?
          ORDER BY source_ref
        `).all(connectorId, attemptId) as Array<{ payload: string }>;
        const verifiedFacts = stagedFacts.map((row) => (
          transactionSourceFactSchema.parse(JSON.parse(row.payload))
        ));
        const stagedWindows = sqlite.prepare(`
          SELECT window_index AS "index", coverage_start AS start, coverage_end AS end,
                 source_as_of AS sourceAsOf, item_count AS itemCount,
                 content_digest AS digest
          FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id = ?
          ORDER BY window_index
        `).all(connectorId, attemptId) as WindowProof[];
        if (
          verifiedFacts.length !== allFacts.length
          || financeInsightDigestV1(verifiedFacts as CanonicalJsonValue) !== contentDigest
          || stagedWindows.length !== windows.length
          || financeInsightDigestV1(stagedWindows as CanonicalJsonValue) !== windowsDigest
        ) {
          throw new Error('finance_insight_history_changed_before_commit');
        }
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id = ?
        `).run(connectorId, stableGenerationId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id = ?
        `).run(connectorId, stableGenerationId);
        sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_facts
          SET generation_id = ?
          WHERE connector_id = ? AND generation_id = ?
        `).run(stableGenerationId, connectorId, attemptId);
        sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_windows
          SET generation_id = ?
          WHERE connector_id = ? AND generation_id = ?
        `).run(stableGenerationId, connectorId, attemptId);
        const promoted = sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_state
          SET status = 'succeeded', current_attempt_id = NULL,
              last_successful_at = ?, successful_generation_id = ?,
              source_as_of = ?, item_count = ?, content_digest = ?,
              coverage_start = ?, coverage_end = ?, window_count = ?,
              windows_digest = ?, bridge_contract_version = ?,
              last_error_code = NULL, updated_at = ?
          WHERE connector_id = ? AND current_attempt_id = ?
        `).run(
          completedAt,
          stableGenerationId,
          sourceAsOf,
          allFacts.length,
          contentDigest,
          coverageStart,
          coverageEnd,
          windowProofs.length,
          windowsDigest,
          MONARCH_BRIDGE_CONTRACT_VERSION,
          completedAt,
          connectorId,
          attemptId,
        );
        if (promoted.changes !== 1) {
          throw new Error('finance_insight_history_attempt_superseded');
        }
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id <> ?
        `).run(connectorId, stableGenerationId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id <> ?
        `).run(connectorId, stableGenerationId);
      }).immediate();
      return {
        generationId: stableGenerationId,
        sourceAsOf,
        itemCount: allFacts.length,
        coverageStart,
        coverageEnd,
      };
    } catch (error) {
      const failedAt = this.clock().toISOString();
      sqlite.transaction(() => {
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id = ?
        `).run(connectorId, attemptId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id = ?
        `).run(connectorId, attemptId);
        sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_state
          SET status = 'failed', current_attempt_id = NULL,
              last_error_code = ?, updated_at = ?
          WHERE connector_id = ? AND current_attempt_id = ?
        `).run(failureCode(error), failedAt, connectorId, attemptId);
      }).immediate();
      throw error;
    }
  }
}
