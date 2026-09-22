import 'server-only';

import { randomUUID } from 'node:crypto';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { FinanceInsightProjectionFenceError } from '@/db/persistence/finance-insights';
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
import {
  createFinanceIdentityNamespace,
  financeConnectorScopedReference,
} from './identity';

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

function transactionFact(
  identityNamespace: string,
  transaction: MonarchTransaction,
): TransactionSourceFactV1 {
  return transactionSourceFactSchema.parse({
    sourceRef: financeConnectorScopedReference(
      identityNamespace,
      'transaction',
      transaction.id,
    ),
    occurredOn: transaction.date,
    amountMinor: amountMinor(transaction.amount),
    merchantName: normalizedName(transaction.merchant.name, 160),
    categoryRef: transaction.category
      ? financeConnectorScopedReference(identityNamespace, 'category', transaction.category.id)
      : null,
    accountRef: financeConnectorScopedReference(
      identityNamespace,
      'account',
      transaction.account.id,
    ),
    isPending: transaction.isPending,
    recurringRef: null,
    tagRefs: [...new Set(transaction.tagReferences.map((tag) => (
      financeConnectorScopedReference(identityNamespace, 'tag', tag.id)
    )))].sort(),
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
    const { finance } = await getWorkerPersistenceRepositories();
    const attemptAt = this.clock().toISOString();
    const identityNamespace = await finance.identity.ensureNamespace({
      connectorId,
      candidate: createFinanceIdentityNamespace(),
      updatedAt: attemptAt,
    });
    const attemptId = randomUUID();
    const coverageEnd = dateOnly(this.clock());
    const windows = buildFinanceInsightHistoryWindows(coverageEnd);
    const coverageStart = windows[0]!.start;
    await finance.insights.projection.startAttempt({ connectorId, attemptId, attemptAt });

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
            const fact = transactionFact(identityNamespace, transaction);
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
          await finance.insights.projection.insertAttemptFacts({
            connectorId,
            attemptId,
            facts: facts.map((fact) => ({
              sourceRef: fact.sourceRef,
              occurredOn: fact.occurredOn,
              payload: fact,
            })),
          });
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
        await finance.insights.projection.insertAttemptWindowProof({
          connectorId,
          attemptId,
          proof: {
            index: proof.index,
            start: proof.start,
            end: proof.end,
            sourceAsOf: proof.sourceAsOf,
            itemCount: proof.itemCount,
            digest: proof.digest,
          },
        });
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
      try {
        await finance.insights.projection.promoteAttempt({
          connectorId,
          attemptId,
          generationId: stableGenerationId,
          completedAt,
          sourceAsOf,
          itemCount: allFacts.length,
          contentDigest,
          coverageStart,
          coverageEnd,
          windowCount: windowProofs.length,
          windowsDigest,
          bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
        });
      } catch (error) {
        if (error instanceof FinanceInsightProjectionFenceError) {
          throw new Error('finance_insight_history_attempt_superseded');
        }
        throw error;
      }
      return {
        generationId: stableGenerationId,
        sourceAsOf,
        itemCount: allFacts.length,
        coverageStart,
        coverageEnd,
      };
    } catch (error) {
      const failedAt = this.clock().toISOString();
      await finance.insights.projection.failAttempt({
        connectorId,
        attemptId,
        failedAt,
        errorCode: failureCode(error),
      });
      throw error;
    }
  }
}
