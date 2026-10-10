import { describe, expect, it } from 'vitest';
import {
  compareFinanceAttentionTransitionPrecedence,
  evaluateFinanceAttentionEnvelope,
  FinanceAttentionEnvelopeError,
  parseFinanceAttentionEnvelope,
  type FinanceAttentionEnvelope,
  type FinanceAttentionEnvelopeSignalKind,
} from '@/lib/finance/attention-policy';

const now = new Date('2026-10-09T20:00:00.000Z');

function at(hoursFromNow: number): string {
  return new Date(now.getTime() + hoursFromNow * 60 * 60 * 1_000).toISOString();
}

function envelope(
  signalKind: FinanceAttentionEnvelopeSignalKind,
  overrides: Partial<FinanceAttentionEnvelope> = {},
): FinanceAttentionEnvelope {
  const family = signalKind.startsWith('kidLimit')
    ? 'threshold'
    : signalKind.startsWith('attribution')
      ? 'attribution'
      : signalKind.startsWith('writeBack')
        ? 'writeBack'
        : signalKind.startsWith('reconciliation')
          ? 'reconciliation'
          : signalKind.startsWith('connector')
            ? 'connectorHealth'
            : signalKind === 'weeklyFinanceSummaryReady'
              ? 'summary'
              : 'anomaly';
  const dueAt = signalKind === 'reconciliationActionRequired' ? at(96) : null;
  const severity: FinanceAttentionEnvelope['severity'] =
    signalKind === 'kidLimitApproaching'
      || signalKind === 'attributionLikely'
      || signalKind === 'reconciliationInformational'
      || signalKind === 'connectorTransientFailure'
      || signalKind === 'weeklyFinanceSummaryReady'
      ? 'info'
      : signalKind === 'duplicateTransactionCandidate'
        || signalKind === 'writeBackFailed'
        || signalKind === 'connectorDegraded'
        ? 'high'
        : signalKind === 'reconciliationMismatch'
          || signalKind === 'connectorAuthenticationExpired'
          ? 'critical'
          : 'medium';
  return {
    contractVersion: '1.0',
    signalFamily: family,
    signalKind,
    signalId: 'signal-opaque',
    occurrenceId: 'occurrence-opaque',
    attentionKey: 'attention-opaque',
    revision: 1,
    sourceLifecycle: 'open',
    severity,
    episodeSince: at(-2),
    conditionSince: at(-2),
    sourceAsOf: at(-0.25),
    evaluatedAt: at(-0.2),
    freshness: 'fresh',
    provenance: {
      owningSystem: 'tyrion',
      producerVersion: 'policy-v1',
      sourceGeneration: 'generation-opaque',
      connectorRef: 'connector-opaque',
    },
    dueAt,
    capabilities: [],
    targets: [],
    settlementReason: null,
    ...overrides,
  };
}

function route(
  signalKind: FinanceAttentionEnvelopeSignalKind,
  overrides: Partial<FinanceAttentionEnvelope> = {},
) {
  return evaluateFinanceAttentionEnvelope({
    connectorId: 'connector-one',
    envelope: envelope(signalKind, overrides),
    decisionAt: now,
  });
}

describe('finance attention normative policy', () => {
  it.each([
    ['kidLimitApproaching', 'informationalNotification', {}],
    ['kidLimitExceeded', 'actionableNotification', {}],
    ['attributionLikely', 'statusOnly', {}],
    ['attributionReviewRequired', 'actionableNotification', {}],
    ['largeTransactionDetected', 'informationalNotification', {}],
    ['recurringAmountIncreaseDetected', 'informationalNotification', {}],
    ['varianceMoverVisible', 'statusOnly', {}],
    ['monthlyVarianceDigestReady', 'informationalNotification', {}],
    ['duplicateTransactionCandidate', 'actionableNotification', {}],
    ['writeBackRetrying', 'statusOnly', {}],
    ['writeBackFailed', 'task', {}],
    ['reconciliationInformational', 'statusOnly', {}],
    ['reconciliationActionRequired', 'actionableNotification', {}],
    ['reconciliationMismatch', 'task', {}],
    ['connectorTransientFailure', 'suppressed', {
      episodeSince: at(-0.1),
      conditionSince: at(-0.1),
      sourceAsOf: at(-0.05),
      evaluatedAt: at(-0.04),
    }],
    ['connectorDegraded', 'actionableNotification', {}],
    ['connectorAuthenticationExpired', 'actionableNotification', {}],
    ['weeklyFinanceSummaryReady', 'informationalNotification', {}],
  ] as const)('routes %s initially to %s', (signalKind, expected, overrides) => {
    expect(route(signalKind, overrides).route).toBe(expected);
  });

  it('uses inclusive escalation clocks and exact My Day eligibility', () => {
    expect(route('kidLimitExceeded', {
      episodeSince: at(-24),
      conditionSince: at(-24),
    })).toMatchObject({
      route: 'task',
      myDayEligible: true,
    });
    expect(route('attributionReviewRequired', {
      episodeSince: at(-24),
      conditionSince: at(-24),
    })).toMatchObject({
      route: 'task',
      myDayEligible: true,
    });
    expect(route('duplicateTransactionCandidate', {
      episodeSince: at(-24),
      conditionSince: at(-24),
    })).toMatchObject({
      route: 'task',
      myDayEligible: true,
    });
    expect(route('connectorTransientFailure', {
      episodeSince: at(-0.25),
      conditionSince: at(-0.25),
      sourceAsOf: at(-0.1),
      evaluatedAt: at(-0.05),
    })).toMatchObject({ route: 'suppressed', accepted: false });
    expect(route('connectorDegraded', {
      episodeSince: at(-4),
      conditionSince: at(-4),
    })).toMatchObject({
      route: 'task',
      myDayEligible: true,
    });
    expect(route('connectorAuthenticationExpired', {
      episodeSince: at(-4),
      conditionSince: at(-4),
    })).toMatchObject({
      route: 'task',
      myDayEligible: true,
    });
    expect(route('reconciliationActionRequired', {
      dueAt: at(72),
    })).toMatchObject({
      route: 'task',
      severity: 'high',
      myDayEligible: false,
    });
    expect(route('reconciliationActionRequired', {
      dueAt: at(0),
    })).toMatchObject({
      route: 'task',
      severity: 'high',
      myDayEligible: true,
    });
  });

  it('settles before freshness and refuses stale new attention or escalation', () => {
    expect(route('writeBackFailed', {
      sourceLifecycle: 'resolved',
      episodeSince: at(-48),
      conditionSince: at(-48),
      sourceAsOf: at(-48),
      evaluatedAt: at(-47),
      settlementReason: 'authoritative_state_verified',
    }).route).toBe('settled');
    expect(route('writeBackFailed', {
      freshness: 'partial',
      episodeSince: at(-24),
      conditionSince: at(-24),
    })).toMatchObject({
      route: 'stale',
      myDayEligible: false,
      authorizedCapabilities: [],
    });
    expect(route('largeTransactionDetected', {
      episodeSince: at(-49),
      conditionSince: at(-49),
      sourceAsOf: at(-48.01),
      evaluatedAt: at(-48),
    }).route).toBe('stale');
    expect(route('duplicateTransactionCandidate', {
      episodeSince: at(-25),
      conditionSince: at(-25),
      sourceAsOf: at(-24.01),
      evaluatedAt: at(-24),
    }).route).toBe('stale');
  });

  it('strictly rejects unknown fields, invalid combinations, and timestamp ordering', () => {
    expect(() => parseFinanceAttentionEnvelope({
      ...envelope('writeBackFailed'),
      unknown: true,
    })).toThrow(FinanceAttentionEnvelopeError);
    expect(() => parseFinanceAttentionEnvelope(envelope('writeBackFailed', {
      signalFamily: 'threshold',
    }))).toThrow('signal_family');
    expect(() => parseFinanceAttentionEnvelope(envelope('writeBackFailed', {
      capabilities: ['createFinanceTask'],
    }))).toThrow('unauthorized_capability');
    expect(() => parseFinanceAttentionEnvelope(envelope('writeBackFailed', {
      severity: 'medium',
    }))).toThrow('severity');
    expect(() => route('writeBackFailed', {
      sourceAsOf: at(1),
      evaluatedAt: at(-0.5),
    })).toThrow('timestamp_order');
  });

  it('derives stable logical, activity, and scheduled transition dedupe keys', () => {
    const aged = { episodeSince: at(-24), conditionSince: at(-24) };
    const first = route('kidLimitExceeded', { ...aged, revision: 3 });
    const replay = route('kidLimitExceeded', { ...aged, revision: 3 });
    const revision = route('kidLimitExceeded', { ...aged, revision: 4 });
    expect(replay).toMatchObject(first);
    expect(revision.logicalKey).toBe(first.logicalKey);
    expect(revision.activityKey).not.toBe(first.activityKey);
    expect(revision.transitionKey).toBe(first.transitionKey);
  });

  it('enforces cross-kind precedence without changing the logical key', () => {
    const retrying = envelope('writeBackRetrying');
    const failed = envelope('writeBackFailed', { revision: 2 });
    expect(compareFinanceAttentionTransitionPrecedence(failed, retrying)).toBeGreaterThan(0);
    expect(route('writeBackRetrying').logicalKey).toBe(route('writeBackFailed').logicalKey);
  });

  it.each([
    [
      envelope('kidLimitExceeded', { severity: 'high', revision: 2 }),
      envelope('kidLimitExceeded', { severity: 'medium' }),
    ],
    [envelope('writeBackFailed', { revision: 2 }), envelope('writeBackRetrying')],
    [
      envelope('connectorAuthenticationExpired', { revision: 3 }),
      envelope('connectorDegraded', { revision: 2 }),
    ],
    [
      envelope('reconciliationMismatch', { revision: 3 }),
      envelope('reconciliationActionRequired', { dueAt: at(72), severity: 'high', revision: 2 }),
    ],
  ])('orders every cross-kind transition group by normative precedence', (higher, lower) => {
    expect(compareFinanceAttentionTransitionPrecedence(higher, lower)).toBeGreaterThan(0);
    expect(compareFinanceAttentionTransitionPrecedence(lower, higher)).toBeLessThan(0);
  });

  it('omits external actions without an authorized typed target', () => {
    expect(route('recurringAmountIncreaseDetected', {
      capabilities: ['openFinanceInsight', 'openMonarch', 'openSourceDocument'],
      targets: [{
        type: 'internal',
        target: 'financeInsight',
        opaqueRef: 'insight-opaque',
      }],
    }).authorizedCapabilities).toEqual(['openFinanceInsight']);
    expect(route('recurringAmountIncreaseDetected', {
      capabilities: ['openFinanceInsight', 'openMonarch', 'openSourceDocument'],
      targets: [
        { type: 'internal', target: 'financeInsight', opaqueRef: 'insight-opaque' },
        { type: 'monarch', target: 'recurring', opaqueRef: 'recurring-opaque' },
        { type: 'sourceDocument', system: 'onedrive', opaqueRef: 'document-opaque' },
      ],
    }).authorizedCapabilities).toEqual([
      'openFinanceInsight',
      'openMonarch',
      'openSourceDocument',
    ]);
  });

  it('refuses lower-precedence replays and preserves an existing task primary record', () => {
    const failed = envelope('writeBackFailed', { revision: 2 });
    const retrying = envelope('writeBackRetrying', { revision: 3 });
    expect(evaluateFinanceAttentionEnvelope({
      connectorId: 'connector-one',
      envelope: retrying,
      decisionAt: now,
      current: { envelope: failed, hasOpenTask: true },
    })).toMatchObject({
      route: 'task',
      accepted: false,
    });
    expect(evaluateFinanceAttentionEnvelope({
      connectorId: 'connector-one',
      envelope: envelope('attributionReviewRequired'),
      decisionAt: now,
      current: {
        envelope: envelope('attributionReviewRequired'),
        hasOpenTask: true,
      },
    })).toMatchObject({
      route: 'task',
      accepted: true,
    });
  });

  it('deduplicates reconciliation promotion at the due-minus-72-hour boundary', () => {
    const first = route('reconciliationActionRequired', {
      dueAt: at(72),
    });
    const replay = route('reconciliationActionRequired', {
      dueAt: at(72),
      revision: 2,
    });
    expect(first.transitionKey).not.toBeNull();
    expect(replay.transitionKey).toBe(first.transitionKey);
  });

  it('keeps Finance insight rows notification-only or status-only', () => {
    for (const signalKind of [
      'largeTransactionDetected',
      'recurringAmountIncreaseDetected',
      'varianceMoverVisible',
      'monthlyVarianceDigestReady',
    ] as const) {
      const decision = route(signalKind, {
        episodeSince: at(-30 * 24),
        conditionSince: at(-30 * 24),
        sourceAsOf: at(-0.25),
      });
      expect(decision.route).not.toBe('task');
      expect(decision.myDayEligible).toBe(false);
    }
  });
});
