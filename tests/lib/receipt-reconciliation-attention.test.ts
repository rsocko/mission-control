import { describe, expect, it } from 'vitest';
import {
  receiptAttentionDeliveryCommitted,
  receiptAttentionSignal,
} from '@/lib/receipt-reconciliation/attention';
import {
  selectFinanceAttentionRoute,
  type FinanceAttentionRoutingResult,
} from '@/db/persistence/finance-attention';
import type { PaymentReviewItem } from '@/lib/receipt-reconciliation/contract';

function item(
  caseKind: PaymentReviewItem['caseKind'],
  reasonCodes: string[] = [],
): PaymentReviewItem {
  return {
    contractVersion: '1.0',
    id: `review_${caseKind}`,
    revision: 1,
    caseKind,
    state: 'open',
    active: true,
    attentionState: 'pending',
    sourceAsOf: '2026-10-10T12:00:00Z',
    summary: { reasonCodes },
    obligation: {
      id: 'obligation_opaque',
      status: 'open',
      revision: 1,
      expectedAmountMinor: null,
      currency: null,
      completionSuggested: false,
    },
    evidence: null,
    owlUrl: 'https://owl.example/#/action-queue',
    sourceActions: [],
  };
}

describe('receipt reconciliation attention policy', () => {
  const now = new Date('2026-10-10T12:01:00Z');
  const routingResult = (
    tasksCreated: number,
    tasksUpdated: number,
  ): FinanceAttentionRoutingResult => ({
    evaluated: 0,
    notificationsCreated: 0,
    notificationsUpdated: 0,
    tasksCreated,
    tasksUpdated,
    tasksSettled: 0,
    taskPromoted: 0,
    autoIncluded: 0,
    deferred: 0,
    settled: 0,
    stalePreserved: 0,
    statusOnly: 0,
    deliveriesReceived: 0,
    deliveriesApplied: 0,
    deliveriesReplayed: 0,
    deliveriesOutOfOrder: 0,
  });

  it('emits one informational route for unmatched-after-grace', () => {
    const signal = receiptAttentionSignal('connector', item('unmatched'))!;
    expect(signal.signalKind).toBe('receiptReconciliationUnmatched');
    expect(selectFinanceAttentionRoute(signal, now)).toBe('informationalNotification');
  });

  it('keeps ambiguity and conflict in review without task promotion', () => {
    for (const caseKind of ['ambiguous', 'conflict'] as const) {
      const signal = receiptAttentionSignal('connector', item(caseKind))!;
      expect(signal.signalKind).toBe('receiptReconciliationReview');
      expect(selectFinanceAttentionRoute(signal, now)).toBe('actionableNotification');
    }
  });

  it('promotes only durable work or exhausted repair to tasks', () => {
    const durable = receiptAttentionSignal('connector', item('partial_payment'))!;
    const repairing = receiptAttentionSignal('connector', item('projection_failed'))!;
    const exhausted = receiptAttentionSignal(
      'connector',
      item('projection_failed', ['projection_retry_exhausted']),
    )!;
    expect(selectFinanceAttentionRoute(durable, now)).toBe('task');
    expect(selectFinanceAttentionRoute(repairing, now)).toBe('statusOnly');
    expect(selectFinanceAttentionRoute(exhausted, now)).toBe('task');
  });

  it('suppresses normal and not-applicable states from user attention', () => {
    const signal = receiptAttentionSignal('connector', item('not_applicable'))!;
    expect(selectFinanceAttentionRoute(signal, now)).toBe('statusOnly');
  });

  it('acknowledges durable attention only after the whole bounded batch is projected', () => {
    const durable = receiptAttentionSignal('connector', item('partial_payment'))!;
    const informational = receiptAttentionSignal('connector', item('unmatched'))!;

    expect(receiptAttentionDeliveryCommitted(durable, routingResult(1, 0), 2)).toBe(false);
    expect(receiptAttentionDeliveryCommitted(durable, routingResult(1, 1), 2)).toBe(true);
    expect(receiptAttentionDeliveryCommitted(informational, routingResult(0, 0), 2)).toBe(true);
  });
});
