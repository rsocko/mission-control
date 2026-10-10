import 'server-only';

import {
  financeAttentionSourceId,
  type FinanceAttentionRoutingResult,
  type FinanceAttentionSignal,
} from '@/db/persistence/finance-attention';
import logger from '@/lib/logger';
import { reconcileFinanceAttention } from '@/lib/finance/attention-routing';
import type { PaymentReviewItem } from './contract';
import {
  OwlReceiptReconciliationAdapter,
  ReceiptReconciliationAdapterError,
} from './server-adapter';

const REVIEW_KINDS = new Set<PaymentReviewItem['caseKind']>([
  'ambiguous',
  'conflict',
  'stale',
]);
const DURABLE_KINDS = new Set<PaymentReviewItem['caseKind']>([
  'partial_payment',
  'double_payment',
]);
const REPAIR_KINDS = new Set<PaymentReviewItem['caseKind']>([
  'source_unavailable',
  'projection_failed',
]);
const EXHAUSTED_REASONS = new Set([
  'repair_exhausted',
  'retry_exhausted',
  'projection_retry_exhausted',
  'source_retry_exhausted',
]);

function sourceTimestamp(item: PaymentReviewItem): string | null {
  return item.sourceAsOf ?? item.evidence?.sourceAsOf ?? null;
}

export function receiptAttentionSignal(
  connectorId: string,
  item: PaymentReviewItem,
): FinanceAttentionSignal | null {
  const sourceAsOf = sourceTimestamp(item);
  if (!sourceAsOf) return null;
  const reasons = new Set([
    ...(item.summary.reasonCodes ?? []),
    ...(item.evidence?.reasonCodes ?? []),
  ]);
  const repairExhausted = REPAIR_KINDS.has(item.caseKind)
    && [...reasons].some((reason) => EXHAUSTED_REASONS.has(reason));
  const durable = DURABLE_KINDS.has(item.caseKind) || repairExhausted;
  const reviewable = REVIEW_KINDS.has(item.caseKind);
  const unmatched = item.caseKind === 'unmatched';
  const signalKind = durable
    ? 'receiptReconciliationDurable' as const
    : unmatched
      ? 'receiptReconciliationUnmatched' as const
      : 'receiptReconciliationReview' as const;
  const open = item.active && item.state !== 'resolved';
  return {
    connectorId,
    signalKind,
    sourceRef: item.id,
    sourceLifecycle: open ? 'open' : 'resolved',
    conditionSince: sourceAsOf,
    sourceAsOf,
    activityKey: `owl-receipt:${item.id}:${item.revision}:${item.state}:${item.attentionState}`,
    actionable: open && (durable || reviewable),
    attention: open && unmatched
      ? 'informational'
      : open && reviewable
        ? 'actionable'
        : undefined,
    freshness: item.caseKind === 'stale' ? 'stale' : 'fresh',
    details: {
      reviewId: item.id,
      revision: item.revision,
      caseKind: item.caseKind,
      attentionState: item.attentionState,
      evidenceSource: item.evidence?.sourceSystem ?? null,
      reasonCodes: [...reasons].slice(0, 20),
      repairExhausted,
    },
    settlementReason: open ? null : 'authoritative_state_verified',
  };
}

export function receiptAttentionDeliveryCommitted(
  signal: FinanceAttentionSignal,
  result: FinanceAttentionRoutingResult,
  durableSignalCount: number,
): boolean {
  return signal.signalKind !== 'receiptReconciliationDurable'
    || result.tasksCreated + result.tasksUpdated >= durableSignalCount;
}

export async function reconcileReceiptReconciliationAttention(input: {
  connectorId: string;
  now?: Date;
  adapter?: OwlReceiptReconciliationAdapter;
}): Promise<FinanceAttentionRoutingResult | null> {
  const adapter = input.adapter ?? new OwlReceiptReconciliationAdapter();
  const page = await adapter.listForAttention(0);
  if (page.state === 'unavailable') return null;
  const signals = page.items.flatMap((item) => {
    const signal = receiptAttentionSignal(input.connectorId, item);
    return signal ? [signal] : [];
  });
  const result = await reconcileFinanceAttention({
    connectorId: input.connectorId,
    now: input.now,
    sourceSignals: signals,
  });
  const durableSignalCount = signals.filter(
    (signal) => signal.signalKind === 'receiptReconciliationDurable',
  ).length;

  const deliverable = page.items.filter((item) => (
    item.active
    && item.attentionState === 'pending'
    && signals.some((signal) => (
      signal.sourceRef === item.id
      && receiptAttentionDeliveryCommitted(signal, result, durableSignalCount)
      && (signal.actionable || signal.attention === 'informational')
    ))
  ));
  for (const item of deliverable) {
    const signal = signals.find((candidate) => candidate.sourceRef === item.id)!;
    try {
      await adapter.deliverAttention(
        item.id,
        item.revision,
        financeAttentionSourceId(signal),
      );
    } catch (error) {
      logger.warn(
        {
          code: error instanceof ReceiptReconciliationAdapterError
            ? error.code
            : 'owl_attention_delivery_failed',
          reviewId: item.id,
        },
        'Receipt reconciliation attention was committed locally but OWL acknowledgement will retry',
      );
    }
  }
  return result;
}
