import { describe, expect, it } from 'vitest';
import {
  compareFinanceAttentionMyDayCandidates,
  compareFinanceAttentionSignalsForRouting,
  financeAttentionAttributionSignal,
  financeAttentionMyDayCandidateRank,
  financeAttentionRequiresTaskPromotion,
  financeAttentionSourceId,
  financeAttentionTaskId,
  financeAttentionWriteBackSignal,
  isHumanReviewableAttributionReason,
  selectFinanceAttentionRoute,
  type FinanceAttentionSignal,
} from '@/db/persistence/finance-attention';

const now = new Date('2026-08-11T12:00:00.000Z');

function iso(hoursAgo: number): string {
  return new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function signal(overrides: Partial<FinanceAttentionSignal> = {}): FinanceAttentionSignal {
  return {
    connectorId: 'finance-contract',
    signalKind: 'attributionReviewRequired',
    sourceRef: 'exception-one',
    sourceLifecycle: 'open',
    conditionSince: iso(2),
    sourceAsOf: iso(2),
    activityKey: 'activity-one',
    actionable: true,
    settlementReason: null,
    ...overrides,
  };
}

describe('finance attention contract — pure decision helpers', () => {
  it('derives stable, distinct identifiers for the same signal shape', () => {
    const base = signal();
    expect(financeAttentionSourceId(base)).toBe(financeAttentionSourceId(base));
    expect(financeAttentionSourceId(base)).not.toBe(financeAttentionTaskId(base));
    expect(financeAttentionSourceId(base)).not.toBe(
      financeAttentionSourceId({ ...base, sourceRef: 'exception-two' }),
    );
    expect(financeAttentionSourceId(base)).toMatch(/^finance-attention:[a-f0-9]{64}$/);
    expect(financeAttentionTaskId(base)).toMatch(/^finance-task-[a-f0-9]{32}$/);
  });

  it('routes every matrix outcome deterministically and matches the sort ranking', () => {
    const fresh = signal();
    const escalated = signal({ conditionSince: iso(25), sourceAsOf: iso(1) });
    const writeBackFresh = signal({
      signalKind: 'writeBackFailed',
      conditionSince: iso(0.25),
      sourceAsOf: iso(0.25),
    });
    const notActionable = signal({ actionable: false });
    const settled = signal({ sourceLifecycle: 'resolved' });
    const staleAttribution = signal({ sourceAsOf: iso(73), conditionSince: iso(73) });
    const staleWriteBack = signal({
      signalKind: 'writeBackFailed',
      sourceAsOf: iso(2),
      conditionSince: iso(2),
    });

    expect(selectFinanceAttentionRoute(fresh, now)).toBe('actionableNotification');
    expect(selectFinanceAttentionRoute(escalated, now)).toBe('task');
    expect(selectFinanceAttentionRoute(writeBackFresh, now)).toBe('task');
    expect(selectFinanceAttentionRoute(notActionable, now)).toBe('statusOnly');
    expect(selectFinanceAttentionRoute(settled, now)).toBe('settled');
    expect(selectFinanceAttentionRoute(staleAttribution, now)).toBe('stale');
    expect(selectFinanceAttentionRoute(staleWriteBack, now)).toBe('stale');

    // Exhausted write-backs sort before aging attribution promotions, which
    // sort before everything else, independent of import order.
    const ordered = [fresh, writeBackFresh, escalated]
      .sort((left, right) => compareFinanceAttentionSignalsForRouting(left, right, now));
    expect(ordered).toEqual([writeBackFresh, escalated, fresh]);
  });

  it('allowlists only the documented human-reviewable attribution reasons', () => {
    for (const reason of [
      'attribution_ambiguous',
      'account-rule-conflict',
      'historical-attribution-tie',
      'low-confidence',
      'manual_decision_conflict',
      'merchant-rule-conflict',
      'no-match',
      'review-required',
    ]) {
      expect(isHumanReviewableAttributionReason(reason), reason).toBe(true);
    }
    for (const reason of [
      'attribution_not_configured',
      'attribution_service_unavailable',
      'policy-version-mismatch',
      'engine-unavailable',
    ]) {
      expect(isHumanReviewableAttributionReason(reason), reason).toBe(false);
    }
  });

  it('derives signals from attribution and write-back rows identically to source status', () => {
    const attributionOpen = financeAttentionAttributionSignal('finance-contract', {
      id: 'exception-one',
      status: 'open',
      reviewState: 'pending',
      reasonCode: 'attribution_ambiguous',
      retryable: 0,
      sourceFingerprint: 'fp-1',
      policyVersion: 1,
      firstObservedAt: iso(2),
      lastObservedAt: iso(1),
      resolvedAt: null,
      updatedAt: iso(1),
    });
    expect(attributionOpen).toMatchObject({
      sourceLifecycle: 'open',
      actionable: true,
      settlementReason: null,
    });

    const attributionDismissed = financeAttentionAttributionSignal('finance-contract', {
      id: 'exception-two',
      status: 'dismissed',
      reviewState: 'resolved',
      reasonCode: 'attribution_ambiguous',
      retryable: 0,
      sourceFingerprint: 'fp-2',
      policyVersion: 1,
      firstObservedAt: iso(2),
      lastObservedAt: iso(1),
      resolvedAt: iso(1),
      updatedAt: iso(1),
    });
    expect(attributionDismissed).toMatchObject({
      sourceLifecycle: 'superseded',
      actionable: false,
      settlementReason: 'source_superseded',
    });

    const writeBackExhausted = financeAttentionWriteBackSignal('finance-contract', {
      id: 'audit-one',
      status: 'failed',
      attemptCount: 3,
      createdAt: iso(1),
      updatedAt: iso(0.5),
      completedAt: null,
    });
    expect(writeBackExhausted).toMatchObject({ sourceLifecycle: 'open', actionable: true });

    const writeBackSucceeded = financeAttentionWriteBackSignal('finance-contract', {
      id: 'audit-two',
      status: 'succeeded',
      attemptCount: 1,
      createdAt: iso(1),
      updatedAt: iso(0.5),
      completedAt: iso(0.25),
    });
    expect(writeBackSucceeded).toMatchObject({
      sourceLifecycle: 'resolved',
      actionable: false,
      settlementReason: 'authoritative_state_verified',
    });
  });

  it('only requires re-claiming the daily promotion cap when resurfacing a settled task', () => {
    const openSignal = signal({ sourceLifecycle: 'open' });
    expect(financeAttentionRequiresTaskPromotion(undefined, openSignal)).toBe(true);
    expect(financeAttentionRequiresTaskPromotion(
      { status: 'todo', metadata: {} },
      openSignal,
    )).toBe(false);
    expect(financeAttentionRequiresTaskPromotion(
      { status: 'done', metadata: { financeAttention: { route: 'settled', sourceLifecycle: 'open' } } },
      openSignal,
    )).toBe(true);
    expect(financeAttentionRequiresTaskPromotion(
      { status: 'done', metadata: { financeAttention: { route: 'task', sourceLifecycle: 'open' } } },
      openSignal,
    )).toBe(false);
  });

  it('ranks and caps My Day candidates by due-soon, signal kind, and priority', () => {
    const today = '2026-08-11';
    const overdue = financeAttentionMyDayCandidateRank({
      id: 'task-overdue',
      status: 'todo',
      localDisposition: 'active',
      metadata: {},
      dueDate: '2026-08-01',
      priority: 'medium',
      createdAt: iso(10),
    }, today);
    const writeBack = financeAttentionMyDayCandidateRank({
      id: 'task-writeback',
      status: 'todo',
      localDisposition: 'active',
      metadata: { financeAttention: { signalKind: 'writeBackFailed' } },
      dueDate: null,
      priority: 'high',
      createdAt: iso(5),
    }, today);
    const noSignal = financeAttentionMyDayCandidateRank({
      id: 'task-none',
      status: 'todo',
      localDisposition: 'active',
      metadata: {},
      dueDate: null,
      priority: 'medium',
      createdAt: iso(5),
    }, today);
    const completed = financeAttentionMyDayCandidateRank({
      id: 'task-done',
      status: 'done',
      localDisposition: 'active',
      metadata: {},
      dueDate: '2026-08-01',
      priority: 'medium',
      createdAt: iso(5),
    }, today);

    expect(overdue?.policyRank).toBe(0);
    expect(writeBack?.policyRank).toBe(2);
    expect(noSignal).toBeNull();
    expect(completed).toBeNull();

    const ordered = [
      { task: { id: 'b' }, policyRank: 1, conditionSince: '2026-08-01T00:00:00.000Z' },
      { task: { id: 'a' }, policyRank: 1, conditionSince: '2026-08-01T00:00:00.000Z' },
      { task: { id: 'c' }, policyRank: 0, conditionSince: '2026-08-05T00:00:00.000Z' },
    ].sort(compareFinanceAttentionMyDayCandidates);
    expect(ordered.map((entry) => entry.task.id)).toEqual(['c', 'a', 'b']);
  });
});
