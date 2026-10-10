import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: mocks.runtime,
}));

import {
  getFinanceAttributionPolicyReadiness,
  previewFinanceAttributionPolicy,
  updateFinanceAttributionAttentionPolicy,
  updateFinanceAttributionPolicySelection,
} from '@/lib/connectors/monarch-money/attribution-readiness';

const sourceOne = 'source-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sourceTwo = 'source-v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const accountOne = 'bridge-account-1';

function runtime(options: {
  truncated?: boolean;
  historyError?: string | null;
  itemCount?: number;
  pinnedPolicyVersion?: number;
} = {}) {
  const readAttributionAccountSummary = vi.fn().mockResolvedValue({
    total: 1,
    active: 1,
    accounts: [{
      accountRef: `account-v1:${'b'.repeat(64)}`,
      displayName: 'Household checking',
      active: true,
    }],
  });
  const items = Array.from({ length: options.itemCount ?? 2 }, (_, index) => (
    index === 0
      ? {
        sourceRef: sourceOne,
        occurredOn: '2026-08-11',
        merchantName: 'Invented market',
        accountRef: accountOne,
        observedAt: '2026-08-12T12:00:00.000Z',
        existingManualDecision: {
          action: 'assign-kid',
          kidId: 'kid-one',
          decidedAt: '2026-08-12T11:30:00.000Z',
        },
      }
      : {
        sourceRef: index === 1 ? sourceTwo : `source-${index}`,
        occurredOn: '2026-08-12',
        merchantName: 'Invented shop',
        accountRef: accountOne,
        observedAt: '2026-08-12T12:00:00.000Z',
        existingManualDecision: null,
      }
  ));
  const readAttributionPreview = vi.fn().mockResolvedValue({
    items,
    total: options.truncated ? 5_001 : items.length,
    truncated: options.truncated ?? false,
  });
  const readState = vi.fn().mockResolvedValue({
    status: options.historyError ? 'failed' : 'succeeded',
    generationId: options.historyError ? null : 'generation-1',
    lastSuccessfulAt: options.historyError ? null : '2026-08-12T12:00:00.000Z',
    sourceAsOf: options.historyError ? null : '2026-08-12T11:00:00.000Z',
    itemCount: options.historyError ? null : 2,
    contentDigest: null,
    coverageStart: options.historyError ? null : '2023-08-01',
    coverageEnd: options.historyError ? null : '2026-08-31',
    windowCount: options.historyError ? null : 37,
    windowsDigest: null,
    bridgeContractVersion: options.historyError ? null : '1.0',
    lastErrorCode: options.historyError ?? null,
    updatedAt: '2026-08-12T12:00:00.000Z',
  });
  const readLatestPlan = vi.fn().mockResolvedValue({
    id: 'private-plan-id',
    connectorId: 'finance-connector',
    idempotencyKey: 'private-operator-key',
    horizonMonths: 37,
    coverageStart: '2023-08-01',
    coverageEnd: '2026-08-31',
    currency: 'USD',
    bridgeContractVersion: '1.0',
    windowCount: 4,
    nextWindowOrdinal: 2,
    status: 'running',
    lastErrorCode: 'finance_insight_backfill_provider_failed',
    completedAt: null,
    createdAt: '2026-08-12T11:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
  });
  const patchSettingsState = vi.fn().mockResolvedValue({
    settings: {},
    state: {},
  });
  return {
    repositories: {
      connectors: {
        get: vi.fn().mockResolvedValue({
          id: 'finance-connector',
          type: 'finance-manager',
          enabled: false,
          credentials: { identityNamespace: 'a'.repeat(64) },
          settings: options.pinnedPolicyVersion
            ? {
                tyrionAttributionPolicy: {
                  pinnedPolicyVersion: options.pinnedPolicyVersion,
                },
              }
            : {},
        }),
        patchSettingsState,
      },
      finance: {
        operator: {
          readAttributionAccountSummary,
          readAttributionPreview,
        },
        insights: {
          projection: { readState },
          backfill: { readLatestPlan },
        },
      },
    },
    readAttributionAccountSummary,
    readAttributionPreview,
    readState,
    readLatestPlan,
    patchSettingsState,
  };
}

function result(
  sourceRef: string,
  input: {
    status: 'attributed' | 'unassigned';
    method: 'account-default' | 'unassigned';
    reviewStatus: 'not-required' | 'pending';
    reasons: string[];
  },
) {
  return {
    contractVersion: '2.0',
    sourceRef,
    status: input.status,
    kidId: input.status === 'attributed' ? 'kid-one' : null,
    confidence: input.status === 'attributed' ? 'definite' : 'none',
    method: input.method,
    explanation: input.status === 'attributed'
      ? 'Matched a configured account rule'
      : 'No attribution rule matched',
    reviewStatus: input.reviewStatus,
    reasons: input.reasons,
    decisionSource: input.status === 'attributed' ? 'automated' : 'fallback',
    policyVersion: 2,
    engineVersion: '2.0.0',
    evaluatedAt: '2026-08-12T12:00:01.000Z',
  };
}

beforeEach(() => {
  vi.stubEnv('FINANCE_MANAGER_API_TOKEN', 'invented-service-token');
  vi.stubEnv('TYRION_OPERATIONS_URL', 'https://tyrion.example');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
    contractVersion: '2.0',
    engineVersion: '2.0.0',
    policyVersion: 2,
    policyUpdatedAt: '2026-10-09T12:00:00.000Z',
    householdCurrency: 'USD',
  })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Tyrion attribution policy readiness', () => {
  it('returns only aggregate account readiness and stable projection diagnostics', async () => {
    const setup = runtime({ historyError: 'insight_history_incomplete_snapshot' });
    mocks.runtime.mockResolvedValue(setup.repositories);

    const readiness = await getFinanceAttributionPolicyReadiness('finance-connector');

    expect(readiness).toMatchObject({
      policySelection: { mode: 'follow-current', pinnedPolicyVersion: null },
      activePolicyVersion: 2,
      policyUpdatedAt: '2026-10-09T12:00:00.000Z',
      policyDiscoveryError: null,
    });
    expect(readiness.accountSummary).toEqual({
      total: 1,
      active: 1,
      accounts: [{
        accountRef: `account-v1:${'b'.repeat(64)}`,
        displayName: 'Household checking',
        active: true,
      }],
    });
    expect(readiness.historyProjection?.lastErrorCode)
      .toBe('insight_history_incomplete_snapshot');
    expect(readiness.historyBackfill).toEqual({
      status: 'running',
      completedWindows: 2,
      totalWindows: 4,
      horizonMonths: 37,
      coverageStart: '2023-08-01',
      coverageEnd: '2026-08-31',
      lastErrorCode: 'finance_insight_backfill_provider_failed',
      completedAt: null,
      updatedAt: '2026-08-12T12:00:00.000Z',
    });
    expect(JSON.stringify(readiness)).not.toContain('identityNamespace');
    expect(JSON.stringify(readiness)).not.toContain('invented-service-token');
    expect(JSON.stringify(readiness)).not.toContain(accountOne);
    expect(JSON.stringify(readiness)).not.toContain('private-plan-id');
    expect(JSON.stringify(readiness)).not.toContain('private-operator-key');
    expect(setup.readAttributionPreview).not.toHaveBeenCalled();
  });

  it('fails closed when Tyrion policy discovery is unavailable', async () => {
    const setup = runtime();
    mocks.runtime.mockResolvedValue(setup.repositories);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      {
        error: {
          code: 'policy_unavailable',
          message: 'No active policy is available',
        },
      },
      { status: 503 },
    )));

    await expect(getFinanceAttributionPolicyReadiness('finance-connector'))
      .rejects.toMatchObject({
        code: 'policy_unavailable',
        status: 503,
      });
  });

  it('aggregates Tyrion results without invoking a persistence mutation', async () => {
    const setup = runtime();
    mocks.runtime.mockResolvedValue(setup.repositories);
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      if (init?.method === 'GET') {
        return Response.json({
          contractVersion: '2.0',
          engineVersion: '2.0.0',
          policyVersion: 2,
          policyUpdatedAt: '2026-10-09T12:00:00.000Z',
          householdCurrency: 'USD',
        });
      }
      const request = JSON.parse(String(init?.body)) as {
        items: Array<{ sourceRef: string; accountRef: string; existingManualDecision: unknown }>;
      };
      expect(request.items.every((item) => item.accountRef === accountOne)).toBe(true);
      expect(request.items[0]?.existingManualDecision).toEqual({
        action: 'assign-kid',
        kidId: 'kid-one',
        decidedAt: '2026-08-12T11:30:00.000Z',
      });
      return Response.json({
        contractVersion: '2.0',
        policyVersion: 2,
        engineVersion: '2.0.0',
        results: request.items.map((item) => item.sourceRef === sourceOne
          ? {
              ...result(item.sourceRef, {
                status: 'attributed',
                method: 'account-default',
                reviewStatus: 'not-required',
                reasons: [],
              }),
              method: 'manual',
              decisionSource: 'manual',
              explanation: 'Preserved the existing manual decision',
            }
          : result(item.sourceRef, {
              status: 'attributed',
              method: 'account-default',
              reviewStatus: 'not-required',
              reasons: [],
            })),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const preview = await previewFinanceAttributionPolicy('finance-connector');

    expect(preview).toMatchObject({
      policyVersion: 2,
      engineVersion: '2.0.0',
      totalTransactions: 2,
      evaluated: 2,
      truncated: false,
      complete: true,
      ready: true,
      counts: {
        status: { attributed: 2 },
        reason: {},
        method: { 'account-default': 1, manual: 1 },
        reviewStatus: { 'not-required': 2 },
      },
    });
    expect(setup.readAttributionPreview).toHaveBeenCalledWith({
      connectorId: 'finance-connector',
      limit: 5_000,
    });
    expect(setup.readAttributionAccountSummary).not.toHaveBeenCalled();
    expect(setup.readState).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
  });

  it('never reports readiness when the bounded projection is truncated', async () => {
    const setup = runtime({ truncated: true });
    mocks.runtime.mockResolvedValue(setup.repositories);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      if (init?.method === 'GET') {
        return Response.json({
          contractVersion: '2.0',
          engineVersion: '2.0.0',
          policyVersion: 2,
          policyUpdatedAt: '2026-10-09T12:00:00.000Z',
          householdCurrency: 'USD',
        });
      }
      const request = JSON.parse(String(init?.body)) as {
        items: Array<{ sourceRef: string }>;
      };
      return Response.json({
        contractVersion: '2.0',
        policyVersion: 2,
        engineVersion: '2.0.0',
        results: request.items.map((item) => result(item.sourceRef, {
          status: 'attributed',
          method: 'account-default',
          reviewStatus: 'not-required',
          reasons: [],
        })),
      });
    }));

    const preview = await previewFinanceAttributionPolicy('finance-connector');

    expect(preview.complete).toBe(false);
    expect(preview.ready).toBe(false);
    expect(preview.truncated).toBe(true);
  });

  it('accepts an explicit no-match review backlog without hiding blocking review', async () => {
    const setup = runtime();
    mocks.runtime.mockResolvedValue(setup.repositories);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      if (init?.method === 'GET') {
        return Response.json({
          contractVersion: '2.0',
          engineVersion: '2.0.0',
          policyVersion: 2,
          policyUpdatedAt: '2026-10-09T12:00:00.000Z',
          householdCurrency: 'USD',
        });
      }
      const request = JSON.parse(String(init?.body)) as {
        items: Array<{ sourceRef: string }>;
      };
      return Response.json({
        contractVersion: '2.0',
        policyVersion: 2,
        engineVersion: '2.0.0',
        results: request.items.map((item) => result(item.sourceRef, {
          status: 'unassigned',
          method: 'unassigned',
          reviewStatus: 'pending',
          reasons: ['no-match'],
        })),
      });
    }));

    await expect(previewFinanceAttributionPolicy('finance-connector')).resolves.toMatchObject({
      complete: true,
      ready: true,
      acceptedRuleBasedReviewBacklog: 2,
      blockingReviewRequired: 0,
      counts: {
        reason: { 'no-match': 2 },
        reviewStatus: { pending: 2 },
      },
    });
  });

  it('resolves follow-current once and holds that exact policy across every preview batch', async () => {
    const setup = runtime({ itemCount: 101 });
    mocks.runtime.mockResolvedValue(setup.repositories);
    const requestVersions: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      if (init?.method === 'GET') {
        return Response.json({
          contractVersion: '2.0',
          engineVersion: '2.0.0',
          policyVersion: 3,
          policyUpdatedAt: '2026-10-09T12:00:00.000Z',
          householdCurrency: 'USD',
        });
      }
      const request = JSON.parse(String(init?.body)) as {
        expectedPolicyVersion: number;
        items: Array<{ sourceRef: string }>;
      };
      requestVersions.push(request.expectedPolicyVersion);
      return Response.json({
        contractVersion: '2.0',
        policyVersion: 3,
        engineVersion: '2.0.0',
        results: request.items.map((item) => result(item.sourceRef, {
          status: 'attributed',
          method: 'account-default',
          reviewStatus: 'not-required',
          reasons: [],
        })).map((item) => ({ ...item, policyVersion: 3 })),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewFinanceAttributionPolicy('finance-connector')).resolves.toMatchObject({
      evaluated: 101,
      policyVersion: 3,
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
    expect(requestVersions).toEqual([3, 3]);
  });

  it('fails closed instead of mixing policy revisions when Tyrion changes mid-preview', async () => {
    const setup = runtime({ itemCount: 101 });
    mocks.runtime.mockResolvedValue(setup.repositories);
    let batch = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      if (init?.method === 'GET') {
        return Response.json({
          contractVersion: '2.0',
          engineVersion: '2.0.0',
          policyVersion: 3,
          policyUpdatedAt: '2026-10-09T12:00:00.000Z',
          householdCurrency: 'USD',
        });
      }
      batch += 1;
      const request = JSON.parse(String(init?.body)) as {
        expectedPolicyVersion: number;
        items: Array<{ sourceRef: string }>;
      };
      const policyVersion = batch === 1 ? 3 : 4;
      return Response.json({
        contractVersion: '2.0',
        policyVersion,
        engineVersion: '2.0.0',
        results: request.items.map((item) => ({
          ...result(item.sourceRef, {
            status: 'attributed',
            method: 'account-default',
            reviewStatus: 'not-required',
            reasons: [],
          }),
          policyVersion,
        })),
      });
    }));

    await expect(previewFinanceAttributionPolicy('finance-connector'))
      .rejects.toMatchObject({ code: 'policy_conflict' });
    expect(batch).toBe(2);
  });

  it('uses an optional connector pin without policy discovery', async () => {
    const setup = runtime({ pinnedPolicyVersion: 3 });
    mocks.runtime.mockResolvedValue(setup.repositories);
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      expect(init?.method).toBe('POST');
      const request = JSON.parse(String(init?.body)) as {
        expectedPolicyVersion: number;
        items: Array<{ sourceRef: string }>;
      };
      expect(request.expectedPolicyVersion).toBe(3);
      return Response.json({
        contractVersion: '2.0',
        policyVersion: 3,
        engineVersion: '2.0.0',
        results: request.items.map((item) => ({
          ...result(item.sourceRef, {
            status: 'attributed',
            method: 'account-default',
            reviewStatus: 'not-required',
            reasons: [],
          }),
          policyVersion: 3,
        })),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewFinanceAttributionPolicy('finance-connector'))
      .resolves.toMatchObject({ policyVersion: 3 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('persists and clears the optional pin through connector settings state', async () => {
    const setup = runtime();
    mocks.runtime.mockResolvedValue(setup.repositories);

    await updateFinanceAttributionPolicySelection('finance-connector', 3);
    await updateFinanceAttributionPolicySelection('finance-connector', null);

    expect(setup.patchSettingsState).toHaveBeenNthCalledWith(
      1,
      'finance-connector',
      'tyrionAttributionPolicy',
      { pinnedPolicyVersion: 3 },
    );
    expect(setup.patchSettingsState).toHaveBeenNthCalledWith(
      2,
      'finance-connector',
      'tyrionAttributionPolicy',
      { pinnedPolicyVersion: undefined },
    );
  });

  it('persists validated connector defaults and account overrides', async () => {
    const setup = runtime();
    mocks.runtime.mockResolvedValue(setup.repositories);
    const accountRef = `account-v1:${'b'.repeat(64)}`;
    const policy = {
      pendingCountThreshold: 15,
      highAmountThresholdMinor: 30_000,
      accountOverrides: {
        [accountRef]: {
          pendingCountThreshold: null,
          highAmountThresholdMinor: 40_000,
        },
      },
    };

    await updateFinanceAttributionAttentionPolicy('finance-connector', policy);
    expect(setup.patchSettingsState).toHaveBeenCalledWith(
      'finance-connector',
      'attributionAttention',
      policy,
    );
  });
});
