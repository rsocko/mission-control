import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriagePersistenceRepositories } from '@/db/persistence/triage-repositories';
import type { ConnectorRuntimeRegistry } from '@/lib/connectors/registry-runtime';
import type { LegacySearchIndexingService } from '@/lib/search/indexing-service';
import type { KeywordSearchRepository } from '@/lib/search/repository';
import type { SyncJobRepository } from '@/lib/sync/job-repository';
import type { ConnectorOperationLeaseRepository } from '@/lib/sync/connector-operation-lease-repository';
import type { SyncControlStateRepository } from '@/lib/sync/control-state';
import type { ConnectorMaintenanceLockRepository } from '@/lib/sync/maintenance-lock';
import type { SyncOperatorControlRepository } from '@/lib/sync/operator-control';
import type { RuntimeHealthPersistence } from '@/lib/telemetry/database-health-runtime';
import type { RuntimeTelemetryPersistence } from '@/lib/telemetry/runtime-persistence';
import type { StoredHealthSnapshot } from '@/lib/telemetry/health-snapshot-store';
import {
  resetModulesPreservingProcessRuntimeRegistries,
  resetProcessRuntimeRegistries,
} from '../helpers/process-runtime-registries';

afterEach(() => {
  resetProcessRuntimeRegistries();
  resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
});

describe('process-wide runtime registries', () => {
  it('shares lifecycle fencing across isolated module evaluations', async () => {
    const firstLifecycle = await import('@/lib/persistence/composition-lifecycle');
    firstLifecycle.blockPersistenceComposition();

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondLifecycle = await import('@/lib/persistence/composition-lifecycle');

    expect(() => secondLifecycle.assertPersistenceCompositionAccessAllowed())
      .toThrow('Persistence composition is unavailable');
    expect(() => secondLifecycle.assertPersistenceCompositionPublicationAllowed())
      .toThrow('Persistence composition publication is blocked');
  });

  it('shares triage registration across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/triage/persistence');
    const selected = { marker: 'triage' } as unknown as TriagePersistenceRepositories;
    firstRuntime.registerTriagePersistenceRepositories(selected);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondRuntime = await import('@/lib/triage/persistence');

    expect(secondRuntime.getTriagePersistenceRepositories()).toBe(selected);
    secondRuntime.clearTriagePersistenceRepositories(selected);
  });

  it('shares AI control-plane registrations across isolated module evaluations', async () => {
    const firstDurable = await import('@/lib/ai/durable-runs/runtime');
    const firstSource = await import('@/lib/semantic-index/source/facade');
    const durableRepository = { marker: 'durable' };
    const sourcePort = { marker: 'source' };
    firstDurable.registerDurableAiRunRepository(durableRepository as never);
    firstSource.registerSemanticSourcePort(sourcePort as never);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondDurable = await import('@/lib/ai/durable-runs/runtime');
    const secondSource = await import('@/lib/semantic-index/source/facade');

    expect(() => secondDurable.registerDurableAiRunRepository(
      durableRepository as never,
    )).not.toThrow();
    expect(() => secondSource.registerSemanticSourcePort(sourcePort as never))
      .not.toThrow();
    await expect(secondDurable.getDurableAiRunRepository())
      .resolves.toBe(durableRepository);
    await expect(secondSource.getSemanticSourcePort()).resolves.toBe(sourcePort);
    firstDurable.clearDurableAiRunRepository(durableRepository as never);
    firstSource.clearSemanticSourcePort(sourcePort as never);
  });

  it('shares connector registration across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/connectors/registry-runtime');
    const selected: ConnectorRuntimeRegistry = {
      createConnector: vi.fn(),
      replaceConnector: vi.fn(),
      getConnector: vi.fn(),
      getAllConnectors: vi.fn(() => []),
    };
    firstRuntime.registerConnectorRegistry(selected);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondRuntime = await import('@/lib/connectors/registry-runtime');

    expect(secondRuntime.getConnectorRegistry()).toBe(selected);
  });

  it('shares search, enrichment, and publication services across module evaluations', async () => {
    const firstSearch = await import('@/lib/search/keyword-runtime');
    const firstEnrichment = await import(
      '@/lib/notifications/enrichment/ai-enrichment-service'
    );
    const firstPublication = await import('@/lib/semantic-index/publication-service');
    const keywordRepository: KeywordSearchRepository = {
      rebuild: vi.fn(),
      indexTask: vi.fn(),
      removeTask: vi.fn(),
      indexNotification: vi.fn(),
      removeNotification: vi.fn(),
      warmUp: vi.fn(),
      search: vi.fn(),
    };
    const enrich = vi.fn(async () => null);
    const upsert = vi.fn(async () => undefined);
    firstSearch.registerKeywordSearchRepository(keywordRepository);
    firstEnrichment.registerAIEnrichmentService({ enrich });
    firstPublication.registerSemanticPublicationService({
      upsert,
      delete: vi.fn(async () => undefined),
    });

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondSearch = await import('@/lib/search/keyword-runtime');
    const secondEnrichment = await import(
      '@/lib/notifications/enrichment/ai-enrichment-service'
    );
    const secondPublication = await import('@/lib/semantic-index/publication-service');

    expect(secondSearch.getKeywordSearchRepository()).toBe(keywordRepository);
    await secondEnrichment.enrichWithAI({
      notificationId: 'notification-1',
      title: 'Notification',
      body: null,
      connectorType: 'local',
      category: 'tasks',
      metadata: {},
      presentation: {},
    });
    await secondPublication.publishSemanticEntityUpsert('task', 'task-1');
    expect(enrich).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith('task', 'task-1');
  });

  it('shares mode route services across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/settings/mode-route-services');
    const demoService = {
      resetDemoDatabase: vi.fn(async () => undefined),
      clearDatabase: vi.fn(async () => undefined),
      clearTriageSampleData: vi.fn(async () => 0),
    };
    const timezoneRepository = {
      applyTimezoneRecompute: vi.fn(async () => ({ invalidCount: 0 })),
    };
    firstRuntime.registerDemoSeedCommandService(demoService);
    firstRuntime.registerRelativeReminderTimezoneRepository(timezoneRepository);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondRuntime = await import('@/lib/settings/mode-route-services');

    expect(secondRuntime.getDemoSeedCommandService()).toBe(demoService);
    expect(secondRuntime.getRelativeReminderTimezoneRepository()).toBe(timezoneRepository);
  });

  it('shares the cross-account task move service across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/tasks/cross-account-route-service');
    const service = {
      execute: vi.fn(async () => ({ status: 200, body: { success: true } })),
    };
    firstRuntime.registerCrossAccountTaskMoveService(service);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondRuntime = await import('@/lib/tasks/cross-account-route-service');

    expect(secondRuntime.getCrossAccountTaskMoveService()).toBe(service);
  });

  it('shares runtime observability compositions across isolated module evaluations', async () => {
    const firstHealth = await import('@/lib/telemetry/database-health-runtime');
    const firstTelemetry = await import('@/lib/telemetry/runtime-persistence');
    const health: RuntimeHealthPersistence = {
      databaseHealthProbe: {
        inspect: vi.fn(async () => ({
          connected: true,
          severity: 'healthy',
          message: 'Connected',
          backend: { kind: 'test' },
        })),
        hasSeedMarker: vi.fn(async () => true),
      },
      createHealthSnapshotStore: <TSummary>() => ({
        write: vi.fn(async () => undefined),
        read: vi.fn(async (): Promise<StoredHealthSnapshot<TSummary> | null> => null),
      }),
    };
    const telemetry: RuntimeTelemetryPersistence = {
      getDatabaseTelemetry: () => undefined,
      registerInstance: vi.fn(async () => undefined),
      persist: vi.fn(async () => undefined),
      recordStop: vi.fn(async () => undefined),
      maintainHistory: vi.fn(async () => undefined),
      getCurrent: vi.fn(async () => []),
      getHistory: vi.fn(async () => []),
      getAlertHistory: vi.fn(async () => []),
      getInstances: vi.fn(async () => []),
    };
    firstHealth.registerRuntimeHealthPersistence(health);
    firstTelemetry.registerRuntimeTelemetryPersistence(telemetry);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondHealth = await import('@/lib/telemetry/database-health-runtime');
    const secondTelemetry = await import('@/lib/telemetry/runtime-persistence');

    expect(secondHealth.getRuntimeHealthPersistence()).toBe(health);
    expect(secondTelemetry.getRuntimeTelemetryPersistence()).toBe(telemetry);
    secondHealth.clearRuntimeHealthPersistence(health);
    secondTelemetry.clearRuntimeTelemetryPersistence(telemetry);
  });

  it('resolves health snapshot stores from the active composition on every call', async () => {
    const healthRuntime = await import('@/lib/telemetry/database-health-runtime');
    const firstRead = vi.fn(async () => null);
    const secondRead = vi.fn(async () => null);
    const createHealth = (read: typeof firstRead): RuntimeHealthPersistence => ({
      databaseHealthProbe: {
        inspect: vi.fn(),
        hasSeedMarker: vi.fn(),
      },
      createHealthSnapshotStore: () => ({
        write: vi.fn(async () => undefined),
        read,
      }),
    });
    const first = createHealth(firstRead);
    const second = createHealth(secondRead);
    const store = healthRuntime.createHealthSnapshotStore();

    healthRuntime.registerRuntimeHealthPersistence(first);
    await store.read();
    healthRuntime.clearRuntimeHealthPersistence(first);
    healthRuntime.registerRuntimeHealthPersistence(second);
    await store.read();

    expect(firstRead).toHaveBeenCalledOnce();
    expect(secondRead).toHaveBeenCalledOnce();
    healthRuntime.clearRuntimeHealthPersistence(second);
  });

  it('shares legacy search indexing across isolated module evaluations', async () => {
    const firstIndexing = await import('@/lib/search/indexing-service');
    const indexingService = {
      warmUp: vi.fn(),
      indexTask: vi.fn(),
      removeTask: vi.fn(),
      indexAlert: vi.fn(),
    } satisfies LegacySearchIndexingService;
    firstIndexing.registerLegacySearchIndexingService(indexingService);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondIndexing = await import('@/lib/search/indexing-service');

    expect(secondIndexing.getLegacySearchIndexingService()).toBe(indexingService);
  });

  it('shares L03b sync registries and preserves newer state from stale cleanup', async () => {
    const firstJobs = await import('@/lib/sync/job-runtime');
    const firstLeases = await import('@/lib/sync/connector-lock-runtime');
    const firstControl = await import('@/lib/sync/control-state');
    const firstMaintenance = await import('@/lib/sync/maintenance-lock');
    const firstOperator = await import('@/lib/sync/operator-control');
    const staleJobs = {} as SyncJobRepository;
    const jobs = {} as SyncJobRepository;
    const leases = {} as ConnectorOperationLeaseRepository;
    const control = {} as SyncControlStateRepository;
    const maintenance = {} as ConnectorMaintenanceLockRepository;
    const getStatus = vi.fn(async () => ({ marker: 'operator' }));
    const operator = { getStatus } as unknown as SyncOperatorControlRepository;
    firstJobs.registerSyncJobRepository(staleJobs);
    firstJobs.clearSyncJobRepository(staleJobs);
    firstJobs.registerSyncJobRepository(jobs);
    firstLeases.registerConnectorOperationLeaseRepository(leases);
    firstControl.registerSyncControlStateRepository(control);
    firstMaintenance.registerConnectorMaintenanceLockRepository(maintenance);
    firstOperator.registerSyncOperatorControlRepository(operator);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondJobs = await import('@/lib/sync/job-runtime');
    const secondLeases = await import('@/lib/sync/connector-lock-runtime');
    const secondControl = await import('@/lib/sync/control-state');
    const secondMaintenance = await import('@/lib/sync/maintenance-lock');
    const secondOperator = await import('@/lib/sync/operator-control');
    secondJobs.clearSyncJobRepository(staleJobs);

    expect(await secondJobs.getSyncJobRepository()).toBe(jobs);
    expect(await secondLeases.getConnectorOperationLeaseRepository()).toBe(leases);
    expect(await secondControl.getSyncControlStateRepository()).toBe(control);
    expect(await secondMaintenance.getConnectorMaintenanceLockRepository()).toBe(maintenance);
    await secondOperator.getFinanceSyncControlStatus('connector-1');
    expect(getStatus).toHaveBeenCalledWith('connector-1');
  });
});
