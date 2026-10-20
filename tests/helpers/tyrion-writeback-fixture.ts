import type { AttributionBatchItem } from '@/lib/connectors/monarch-money/attribution-contract';

export const writebackObservedAt = '2026-10-20T12:00:00.000Z';

export function tyrionWritebackFixture(
  sourceRef: string,
  stateVersion = 1,
  status: 'projected' | 'pending' | 'failed' | 'drift' = 'projected',
  kidId: string | null = 'kid-one',
  manualDecision = true,
) {
  const reasons: string[] = [];
  const attribution = {
    contractVersion: '2.1',
    sourceRef,
    status: kidId ? 'attributed' : 'unassigned',
    kidId,
    confidence: 'definite',
    method: 'manual',
    explanation: 'Confirmed by parent administrator',
    review: { status: 'resolved', reasons },
    provenance: {
      decisionSource: 'manual', policyVersion: 1, engineVersion: '2.1.0',
      ruleIds: [], evaluatedAt: writebackObservedAt,
    },
  };
  const projection = {
    sourceRef, decisionVersion: `state:${String(stateVersion).padStart(16, '0')}`, kidIds: kidId ? [kidId] : [],
    managedTagIds: kidId ? ['tag-one'] : [], status,
    errorCode: status === 'projected' ? null : 'tag_projection_unavailable',
    updatedAt: writebackObservedAt,
  };
  return {
    contractVersion: '2.1',
    record: {
      input: {
        contractVersion: '2.1', householdId: 'synthetic-household',
        source: { system: 'monarch-bridge', recordRef: sourceRef, observedAt: writebackObservedAt },
        transaction: {
          merchantName: 'Invented merchant', businessEntityName: null,
          statementDescriptors: [], locationEvidence: null, accountRef: 'account-one',
          occurredOn: '2026-10-20',
        },
        historicalAttributions: [],
        existingManualDecision: manualDecision ? {
          action: kidId ? 'assign-kid' : 'parent-expense', kidId,
          decidedAt: writebackObservedAt, actorId: 'mission-control-finance-manager',
          explanation: 'Confirmed by parent administrator',
        } : null,
      },
      attribution, stateVersion,
      exception: { status: 'resolved', reasons: [], deferredUntil: null, updatedAt: writebackObservedAt },
      lastAction: null,
    },
    projection,
  };
}

export function tyrionActionFixture(sourceRef: string, stateVersion = 2,
  status: 'projected' | 'pending' | 'failed' | 'drift' = 'projected',
  kidId: string | null = 'kid-one') {
  const record = tyrionWritebackFixture(sourceRef, stateVersion, status, kidId);
  return {
    contractVersion: '2.1', sourceRef, policyVersion: 1, engineVersion: '2.1.0',
    stateVersion, attribution: record.record.attribution, projection: record.projection,
    exception: record.record.exception, availableActions: [], assignableKidIds: ['kid-one'],
    authoritativeDeepLink: '/attribution', provenance: record.record.attribution.provenance,
    audit: null,
  };
}

export function writebackBatchItem(sourceRef: string): AttributionBatchItem {
  return {
    sourceRef, occurredOn: '2026-10-20', merchantName: 'Invented merchant',
    businessEntityName: null, statementDescriptors: [], locationEvidence: null,
    accountRef: 'account-one', observedAt: writebackObservedAt, existingManualDecision: null,
  };
}

export function writebackJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}
