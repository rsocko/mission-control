import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatcherSupported: false,
  reconcile: vi.fn(async () => ({
    summary: {
      evaluated: 1,
      notificationsCreated: 1,
      taskPromoted: 0,
      autoIncluded: 0,
      deferred: 0,
      settled: 0,
      stalePreserved: 0,
    },
    hasPendingDelivery: true,
  })),
  runLifecycle: vi.fn(async () => ({
    results: [],
    hasPendingDelivery: true,
  })),
  wake: vi.fn(),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    finance: {
      attention: {
        routing: { reconcile: mocks.reconcile },
      },
      insights: {
        connectors: {
          resolveSingleEnabledConnectorId: async () => 'synthetic-finance',
        },
        notifications: {
          isDeliveryEnabled: async () => true,
          runLifecycle: mocks.runLifecycle,
        },
      },
    },
    execution: {
      support: {
        allowsLegacyWorkflow: (workflow: string) =>
          workflow === 'notification-dispatcher' && mocks.dispatcherSupported,
      },
    },
  }),
}));

vi.mock('@/lib/notifications/dispatcher-wake', () => ({
  wakeNotificationDeliveryDispatcher: mocks.wake,
}));

describe('finance notification dispatcher support boundary', () => {
  beforeEach(() => {
    mocks.dispatcherSupported = false;
    mocks.reconcile.mockClear();
    mocks.runLifecycle.mockClear();
    mocks.wake.mockClear();
  });

  it('persists attention while leaving the PostgreSQL dispatcher disabled', async () => {
    const { reconcileFinanceAttention } = await import('@/lib/finance/attention-routing');

    await expect(reconcileFinanceAttention({
      connectorId: 'synthetic-finance',
    })).resolves.toMatchObject({
      evaluated: 1,
      notificationsCreated: 1,
    });
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it('preserves the SQLite dispatcher wake when that workflow is supported', async () => {
    mocks.dispatcherSupported = true;
    const { reconcileFinanceAttention } = await import('@/lib/finance/attention-routing');

    await reconcileFinanceAttention({ connectorId: 'synthetic-finance' });

    expect(mocks.wake).toHaveBeenCalledOnce();
  });

  it('persists insight notifications without waking the PostgreSQL dispatcher', async () => {
    const { ingestFinanceInsightNotifications } = await import(
      '@/lib/finance-insights/notification-ingestion'
    );

    await expect(ingestFinanceInsightNotifications({
      connectorId: 'synthetic-finance',
      items: [],
    })).resolves.toEqual([]);
    expect(mocks.runLifecycle).toHaveBeenCalledOnce();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it('preserves the SQLite insight-notification wake when the dispatcher is supported', async () => {
    mocks.dispatcherSupported = true;
    const { ingestFinanceInsightNotifications } = await import(
      '@/lib/finance-insights/notification-ingestion'
    );

    await ingestFinanceInsightNotifications({
      connectorId: 'synthetic-finance',
      items: [],
    });

    expect(mocks.wake).toHaveBeenCalledOnce();
  });
});
