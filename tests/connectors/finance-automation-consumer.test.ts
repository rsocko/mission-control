import { describe, expect, it } from 'vitest';
import {
  financeAutomationDeliveryAckResultSchema,
  financeAutomationJobRequestTransportSchema,
  financeAutomationJobResultSchema,
  type FinanceAutomationSignal,
} from '@/lib/finance-insights/automation-contract';
import {
  automationApplicationSignals,
  deriveConsecutiveFailures,
  isCorrelatedAutomationResult,
  isCompleteAcknowledgment,
  toFinanceAutomationAttentionSignal,
} from '@/lib/finance-insights/automation-consumer';
import {
  financeAttentionNotificationInput,
  selectFinanceAttentionRoute,
} from '@/db/persistence/finance-attention';
import { financeNotificationCatalogKey } from '@/lib/notifications/push-policy/catalogs';

const signalId = `signal-v1_${'a'.repeat(43)}`;
const connectorRef = 'finance-automation-test';
const openedAt = '2026-10-09T12:00:00.000Z';
const sourceAsOf = '2026-10-09T12:30:00.000Z';
const deliveryKey = `finance-automation:${signalId}`;

function jobResult(signal = duplicateSignal()) {
  return {
    contractVersion: '1.0' as const,
    runId: `run-v1_${'b'.repeat(43)}`,
    jobKind: 'duplicateTransactions' as const,
    connectorRef,
    scheduledFor: '2026-10-09T12:30:00.000Z',
    status: 'completed' as const,
    skipReason: null,
    sourceAsOf,
    candidateCount: 1,
    exclusionSummary: {},
    signals: [signal],
    deliveries: [{
      deliveryKey,
      version: 2,
      signalId,
      target: 'notification' as const,
      action: 'update' as const,
      signal,
    }],
    replayed: false,
    completedAt: '2026-10-09T12:31:00.000Z',
  };
}

function duplicateSignal(
  overrides: Partial<FinanceAutomationSignal> = {},
): FinanceAutomationSignal {
  return {
    contractVersion: '1.0',
    signalId,
    kind: 'duplicateTransaction',
    connectorRef,
    state: 'open',
    severity: 'high',
    confidence: 'high',
    attention: 'actionable',
    reasonCodes: ['duplicate_exact_match'],
    relatedSourceRefs: ['transaction-one', 'transaction-two'],
    evidence: {
      kind: 'duplicateTransaction',
      sameAmount: true,
      sameMerchant: true,
      sameAccount: true,
      dateGapDays: 0,
      observedDates: ['2026-10-09', '2026-10-09'],
    },
    freshness: 'fresh',
    provenance: {
      connectorRef,
      providerClass: 'monarchBridgeNormalized',
      bridgeContractVersion: '1.0',
      sourceGeneration: 'generation-one',
      sourceAsOf,
      observedAt: sourceAsOf,
      evaluatedAt: '2026-10-09T12:31:00.000Z',
      detectorSetVersion: 'automation-detectors-v1',
      detectorVersion: 'duplicate-transaction-detector-v1',
      policyVersion: 1,
    },
    openedAt,
    updatedAt: '2026-10-09T12:31:00.000Z',
    settledAt: null,
    ...overrides,
  };
}

describe('finance automation consumer contracts', () => {
  it('strictly parses versioned job results and exact acknowledgement outcomes', () => {
    const signal = duplicateSignal();
    const result = financeAutomationJobResultSchema.parse(jobResult(signal));
    expect(result.deliveries[0]?.version).toBe(2);
    expect(financeAutomationDeliveryAckResultSchema.parse({
      contractVersion: '1.0',
      acknowledged: [`finance-automation:${signalId}`],
      conflicts: [],
    }).conflicts).toEqual([]);
    expect(() => financeAutomationJobResultSchema.parse({
      ...result,
      untrustedUrl: 'https://attacker.example',
    })).toThrow();
  });

  it('rejects unnormalized requests and response identity mismatches', () => {
    const request = {
      contractVersion: '1.0',
      jobKind: 'connectorHealth',
      connectorRef,
      scheduledFor: sourceAsOf,
      evaluatedAt: '2026-10-09T12:31:00.000Z',
      observation: {
        observedAt: sourceAsOf,
        state: 'connected',
        lastSuccessfulSyncAt: sourceAsOf,
        consecutiveFailures: 0,
        bridgeContractVersion: '1.0',
      },
      automationPolicy: {
        contractVersion: '1.0',
        policyVersion: 1,
        detectorSetVersion: 'automation-detectors-v1',
        duplicateTransactions: {
          enabled: true,
          matchWindowDays: 1,
          maxCandidates: 100,
          freshnessMaxAgeHours: 24,
        },
        connectorHealth: {
          enabled: true,
          staleAfterHours: 1,
          actionableAfterConsecutiveFailures: 3,
        },
      },
    };
    expect(financeAutomationJobRequestTransportSchema.parse(request).jobKind)
      .toBe('connectorHealth');
    expect(() => financeAutomationJobRequestTransportSchema.parse({
      ...request,
      unexpected: true,
    })).toThrow();
    expect(() => financeAutomationJobRequestTransportSchema.parse({
      ...request,
      observation: { ...request.observation, consecutiveFailures: 1 },
    })).toThrow();

    expect(() => financeAutomationJobResultSchema.parse({
      ...jobResult(),
      deliveries: [{
        ...jobResult().deliveries[0],
        signal: duplicateSignal({ connectorRef: 'another-connector' }),
      }],
    })).toThrow();
    expect(() => financeAutomationJobResultSchema.parse({
      ...jobResult(),
      deliveries: [{
        ...jobResult().deliveries[0],
        deliveryKey: `finance-automation:signal-v1_${'c'.repeat(43)}`,
      }],
    })).toThrow();
    expect(isCorrelatedAutomationResult(
      financeAutomationJobResultSchema.parse(jobResult()),
      {
        connectorRef,
        jobKind: 'duplicateTransactions',
        scheduledFor: sourceAsOf,
      },
    )).toBe(true);
    expect(isCorrelatedAutomationResult(
      financeAutomationJobResultSchema.parse(jobResult()),
      {
        connectorRef,
        jobKind: 'connectorHealth',
        scheduledFor: sourceAsOf,
      },
    )).toBe(false);
  });

  it('applies authoritative snapshots without duplicating overlapping signals', () => {
    const snapshot = duplicateSignal({
      state: 'settled',
      settledAt: '2026-10-09T12:30:30.000Z',
      reasonCodes: ['condition_recovered'],
    });
    const current = duplicateSignal({ updatedAt: '2026-10-09T12:32:00.000Z' });
    const application = automationApplicationSignals({
      ...jobResult(snapshot),
      signals: [current],
    });

    expect(application.deliveries[0]?.activityKey).toContain(':2:');
    expect(application.deliveries[0]?.settlementReason)
      .toBe('authoritative_state_verified');
    expect(application.current).toEqual([]);
    const escalation = automationApplicationSignals({
      ...jobResult(current),
      deliveries: [],
    });
    expect(escalation.current[0]?.activityKey).toContain(':0:');
    expect(escalation.current[0]?.settlementReason).toBeNull();
  });

  it('requires exact acknowledgement coverage', () => {
    expect(isCompleteAcknowledgment([deliveryKey], {
      acknowledged: [deliveryKey],
      conflicts: [],
    })).toBe(true);
    expect(isCompleteAcknowledgment([deliveryKey], {
      acknowledged: [],
      conflicts: [],
    })).toBe(false);
    expect(isCompleteAcknowledgment([deliveryKey], {
      acknowledged: [deliveryKey],
      conflicts: [deliveryKey],
    })).toBe(false);
    expect(isCompleteAcknowledgment([deliveryKey], {
      acknowledged: [`finance-automation:signal-v1_${'c'.repeat(43)}`],
      conflicts: [],
    })).toBe(false);
  });

  it('derives repeated failures from the durable outage episode', () => {
    expect(deriveConsecutiveFailures(
      '2026-10-09T12:00:00.000Z',
      new Date('2026-10-09T12:30:00.000Z'),
      { TYRION_FINANCE_AUTOMATION_INTERVAL_MINUTES: '15' },
    )).toBe(3);
    expect(deriveConsecutiveFailures(
      null,
      new Date('2026-10-09T12:30:00.000Z'),
      {},
    )).toBe(1);
  });

  it('routes informational duplicates as notifications and promotes actionable ones at 24h', () => {
    const informational = toFinanceAutomationAttentionSignal(duplicateSignal({
      attention: 'informational',
      severity: 'medium',
      confidence: 'medium',
      reasonCodes: ['duplicate_adjacent_date_match'],
    }), 1);
    const actionable = toFinanceAutomationAttentionSignal(duplicateSignal(), 3);

    expect(selectFinanceAttentionRoute(
      informational,
      new Date('2026-10-09T13:00:00.000Z'),
    )).toBe('informationalNotification');
    expect(selectFinanceAttentionRoute(
      actionable,
      new Date('2026-10-10T12:00:00.000Z'),
    )).toBe('task');
    expect(actionable.activityKey).toContain(':3:');

    const notification = financeAttentionNotificationInput(
      informational,
      new Date('2026-10-09T13:00:00.000Z'),
    );
    expect(notification.navigationTarget).toBe('/finance/review');
    expect(notification.isActionable).toBe(false);
    expect(JSON.stringify(notification.metadata)).not.toContain('transaction-one');
    expect(notification.metadata).toMatchObject({
      financeAttention: { signalFamily: 'anomaly' },
    });
    expect(financeNotificationCatalogKey(notification.templateKey))
      .toBe('finance_duplicate_transaction');
    expect(financeNotificationCatalogKey('finance-connector-health'))
      .toBe('finance_connector_degraded');
  });

  it('settles connector health only from Tyrion authoritative recovery', () => {
    const settled = toFinanceAutomationAttentionSignal({
      ...duplicateSignal(),
      kind: 'connectorHealth',
      state: 'settled',
      attention: 'informational',
      relatedSourceRefs: [],
      reasonCodes: ['condition_recovered'],
      evidence: {
        kind: 'connectorHealth',
        reportedState: 'connected',
        consecutiveFailures: 0,
        sourceAgeHours: 0,
      },
      settledAt: '2026-10-09T12:31:00.000Z',
      provenance: {
        ...duplicateSignal().provenance,
        sourceGeneration: null,
        detectorVersion: 'connector-health-detector-v1',
      },
    }, 4);

    expect(selectFinanceAttentionRoute(
      settled,
      new Date('2026-10-09T13:00:00.000Z'),
    )).toBe('settled');
    expect(settled.settlementReason).toBe('connector_recovered');
  });
});
