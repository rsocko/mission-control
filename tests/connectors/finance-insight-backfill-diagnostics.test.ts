import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceInsightBackfillWindowProof } from '@/db/persistence/finance-insights';
import { financeInsightDigestV1 } from '@/lib/finance-insights/canonical';
import type { ConnectorConfig } from '@/types';

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  bridgePage: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  default: { error: mocks.logError },
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: mocks.runtime,
}));

vi.mock('@/lib/connectors/monarch-money/client', () => ({
  getPersistedFinanceManagerServiceToken: (
    config: Pick<ConnectorConfig, 'credentials'>,
  ) => String(config.credentials?.serviceToken ?? ''),
  MonarchBridgeError: class MonarchBridgeError extends Error {
    constructor(
      readonly code: string,
      readonly status?: number,
    ) {
      super(code);
    }
  },
  MonarchBridgeClient: class {
    getTransactionsPage = mocks.bridgePage;
  },
}));

import {
  runFinanceInsightTransactionProjectionRepair,
} from '@/lib/connectors/monarch-money/transaction-backfill';

const config: ConnectorConfig = {
  id: 'diagnostic-connector',
  type: 'finance-manager',
  name: 'Diagnostic connector',
  enabled: false,
  syncMode: 'poll',
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: false,
    tags: true,
    tagWriteBack: false,
    notificationOnly: true,
  },
  credentials: { serviceToken: 'private-service-token' },
  settings: {
    bridgeUrl: 'http://localhost:8100',
    maxRetries: 0,
  },
  syncedLists: [],
};

function plan() {
  return {
    id: 'private-plan-id',
    connectorId: config.id,
    idempotencyKey: 'diagnostic-repair-key',
    horizonMonths: 1,
    coverageStart: '2024-02-01',
    coverageEnd: '2024-02-29',
    currency: 'USD',
    bridgeContractVersion: 'bridge-v1',
    windowCount: 1,
    nextWindowOrdinal: 0,
    status: 'running' as const,
    lastErrorCode: null,
    completedAt: null,
    createdAt: '2024-02-29T12:00:00.000Z',
    updatedAt: '2024-02-29T12:00:00.000Z',
  };
}

function repositories(overrides: {
  configuration?: () => void;
  identity?: () => Promise<void>;
  createPlan?: () => Promise<ReturnType<typeof plan>>;
  loadWindowProofs?: () => Promise<FinanceInsightBackfillWindowProof[]>;
  assertDeliveryDisabled?: () => Promise<void>;
  recordPlanFailure?: (planId: string, code: string) => Promise<void>;
  promoteCompletedPlan?: () => Promise<{ promoted: boolean }>;
  upsertTransactionPage?: () => Promise<{ added: number; updated: number }>;
} = {}) {
  return {
    execution: {
      support: {
        assertConfigSupported: overrides.configuration ?? vi.fn(),
      },
    },
    finance: {
      identity: {
        ensureNamespace: overrides.identity ?? vi.fn().mockResolvedValue(undefined),
      },
      insights: {
        backfill: {
          createPlan: overrides.createPlan ?? vi.fn().mockResolvedValue(plan()),
          loadWindowProofs: overrides.loadWindowProofs ?? vi.fn().mockResolvedValue([]),
          assertDeliveryDisabled:
            overrides.assertDeliveryDisabled ?? vi.fn().mockResolvedValue(undefined),
          findPriorWindowTransactionDate: vi.fn().mockResolvedValue(null),
          upsertTransactionPage:
            overrides.upsertTransactionPage
            ?? vi.fn().mockResolvedValue({ added: 1, updated: 0 }),
          recordWindowCapture: vi.fn().mockResolvedValue({ itemCount: 1 }),
          recordPlanFailure:
            overrides.recordPlanFailure ?? vi.fn().mockResolvedValue(undefined),
          promoteCompletedPlan:
            overrides.promoteCompletedPlan ?? vi.fn().mockResolvedValue({ promoted: true }),
        },
        projection: {
          readOperationalProjectionFacts: vi.fn().mockResolvedValue({ transaction: [] }),
        },
      },
    },
  };
}

function request() {
  return {
    config,
    idempotencyKey: 'diagnostic-repair-key',
    horizonMonths: 1,
    maxWindows: 1,
    clock: () => new Date('2024-02-29T12:05:00.000Z'),
    assertSafe: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    contractVersion: '2.0',
    engineVersion: '2.0.0',
    policyVersion: 1,
    policyUpdatedAt: '2024-02-29T12:00:00.000Z',
    householdCurrency: 'USD',
  })));
  mocks.bridgePage.mockRejectedValue(new Error('raw provider diagnostic detail'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Finance insight backfill diagnostics', () => {
  it.each([
    [
      'configuration',
      () => repositories({
        configuration: () => {
          throw new Error('raw configuration diagnostic detail');
        },
      }),
      'finance_insight_backfill_configuration_failed',
    ],
    [
      'identity',
      () => repositories({
        identity: vi.fn().mockRejectedValue(new Error('raw identity diagnostic detail')),
      }),
      'finance_insight_backfill_identity_failed',
    ],
    [
      'plan',
      () => repositories({
        createPlan: vi.fn().mockRejectedValue(new Error('raw plan diagnostic detail')),
      }),
      'finance_insight_backfill_plan_failed',
    ],
  ])('maps an unknown %s failure without leaking details', async (stage, create, code) => {
    mocks.runtime.mockResolvedValue(create());

    await expect(runFinanceInsightTransactionProjectionRepair(request()))
      .rejects.toMatchObject({ code, status: 500 });
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({ stage, code }),
      'Finance insight backfill stage failed',
    );
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('raw ');
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(config.id);
  });

  it('preserves the primary proof failure if recording that failure also fails', async () => {
    const recordPlanFailure = vi.fn()
      .mockRejectedValue(new Error('raw failure-recording diagnostic detail'));
    mocks.runtime.mockResolvedValue(repositories({
      loadWindowProofs: vi.fn().mockRejectedValue(new Error('raw proof diagnostic detail')),
      recordPlanFailure,
    }));

    await expect(runFinanceInsightTransactionProjectionRepair(request()))
      .rejects.toMatchObject({
        code: 'finance_insight_backfill_proof_failed',
        status: 500,
      });
    expect(recordPlanFailure).toHaveBeenCalledWith(
      'private-plan-id',
      'finance_insight_backfill_proof_failed',
      expect.any(String),
    );
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'failure-recording',
        code: 'finance_insight_backfill_failure_recording_failed',
        primaryCode: 'finance_insight_backfill_proof_failed',
      }),
      'Finance insight backfill failure recording failed',
    );
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('raw ');
  });

  it.each([
    [
      'provider',
      repositories(),
      'finance_insight_backfill_provider_failed',
    ],
    [
      'persistence',
      repositories({
        assertDeliveryDisabled: vi.fn()
          .mockRejectedValue(new Error('raw persistence diagnostic detail')),
      }),
      'finance_insight_backfill_persistence_failed',
    ],
  ])('records an unknown %s failure on the resumable plan', async (_stage, repo, code) => {
    mocks.runtime.mockResolvedValue(repo);

    await expect(runFinanceInsightTransactionProjectionRepair(request()))
      .rejects.toMatchObject({ code, status: 500 });
    expect(repo.finance.insights.backfill.recordPlanFailure).toHaveBeenCalledWith(
      'private-plan-id',
      code,
      expect.any(String),
    );
  });

  it('maps and records an unknown page persistence failure', async () => {
    mocks.bridgePage.mockResolvedValue({
      contractVersion: '1.0',
      provenance: { provider: 'live', fetchedAt: '2024-02-29T12:00:00.000Z' },
      transactions: [{
        id: 'private-transaction-id',
        date: '2024-02-15',
        amount: -10,
        merchant: { name: 'Private merchant', logoUrl: null },
        category: null,
        account: { id: 'private-account-id', displayName: 'Private account', mask: null },
        isPending: false,
        isRecurring: false,
        notes: null,
        tags: [],
        tagReferences: [],
      }],
      total: 1,
      page: { limit: 500, nextCursor: null },
    });
    const repo = repositories({
      upsertTransactionPage: vi.fn()
        .mockRejectedValue(new Error('raw SQL diagnostic detail')),
    });
    mocks.runtime.mockResolvedValue(repo);

    await expect(runFinanceInsightTransactionProjectionRepair(request()))
      .rejects.toMatchObject({
        code: 'finance_insight_backfill_persistence_failed',
        status: 500,
      });
    expect(repo.finance.insights.backfill.recordPlanFailure).toHaveBeenCalledWith(
      'private-plan-id',
      'finance_insight_backfill_persistence_failed',
      expect.any(String),
    );
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('raw SQL');
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('private-transaction-id');
  });

  it('maps and records an unknown promotion failure on an already captured plan', async () => {
    const windows = [
      { ordinal: 0, start: '2021-02-01', end: '2022-01-31' },
      { ordinal: 1, start: '2022-02-01', end: '2023-01-31' },
      { ordinal: 2, start: '2023-02-01', end: '2024-01-31' },
      { ordinal: 3, start: '2024-02-01', end: '2024-02-29' },
    ];
    const completedPlan = {
      ...plan(),
      horizonMonths: 37,
      coverageStart: windows[0]!.start,
      windowCount: windows.length,
      nextWindowOrdinal: windows.length,
      status: 'completed' as const,
      completedAt: '2024-02-29T12:04:00.000Z',
    };
    const repo = repositories({
      createPlan: vi.fn().mockResolvedValue(completedPlan),
      loadWindowProofs: vi.fn().mockResolvedValue(windows.map((window) => ({
        windowOrdinal: window.ordinal,
        generationRef: `window-${window.ordinal}`,
        windowStart: window.start,
        windowEnd: window.end,
        sourceAsOf: '2024-02-29T12:00:00.000Z',
        itemCount: 0,
        contentDigest: financeInsightDigestV1([]),
        currency: 'USD',
        bridgeContractVersion: 'bridge-v1',
      }))),
      promoteCompletedPlan: vi.fn()
        .mockRejectedValue(new Error('raw promotion diagnostic detail')),
    });
    mocks.runtime.mockResolvedValue(repo);

    await expect(runFinanceInsightTransactionProjectionRepair({
      ...request(),
      horizonMonths: 37,
      maxWindows: 4,
    })).rejects.toMatchObject({
      code: 'finance_insight_backfill_promotion_failed',
      status: 500,
    });
    expect(repo.finance.insights.backfill.recordPlanFailure).toHaveBeenCalledWith(
      'private-plan-id',
      'finance_insight_backfill_promotion_failed',
      expect.any(String),
    );
  });
});
