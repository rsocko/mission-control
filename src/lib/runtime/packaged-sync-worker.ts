import type { CopilotClientOptions } from '@github/copilot-sdk';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CopilotLifecycleClient } from '@/lib/ai/copilot-lifecycle-contracts';
import type { AtomicWorkerComponent } from '@/lib/runtime/atomic-components';

export interface PackagedSyncWorkerDependencies {
  createCopilotClient?: (options: CopilotClientOptions) => CopilotLifecycleClient;
}

type ShutdownSignal = NodeJS.Signals | 'startup_failure';

export async function runPackagedSyncWorker(
  dependencies: PackagedSyncWorkerDependencies = {},
): Promise<void> {
  process.env.MC_PROCESS_ROLE = 'worker';
  const instanceFile = process.env.MC_WORKER_INSTANCE_FILE
    ?? join(tmpdir(), 'mission-control-worker-instance');
  rmSync(instanceFile, { force: true });
  const [{ syncLogger }, { waitForWebReadiness }] = await Promise.all([
    import('@/lib/logger'),
    import('@/lib/runtime/web-readiness'),
  ]);
  let databaseInitialized = false;
  let disposePrepared = async (): Promise<void> => {};
  let receivedSignal: NodeJS.Signals | null = null;
  const startupAbort = new AbortController();
  let lifecycle: { stop(): Promise<void> } | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let shutdownReason: ShutdownSignal = 'startup_failure';
  let removeSignalHandlers = () => {};
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });

  try {
    await waitForWebReadiness({
      onRetry: ({ attempt, maxAttempts, error }) => {
        syncLogger.warn(
          { err: error, attempt, maxAttempts },
          'Sync worker waiting for web database initialization',
        );
      },
    });
    const { initializeDatabaseWithRetry } = await import('@/db/startup');
    await initializeDatabaseWithRetry();
    databaseInitialized = true;

    const [
      { syncScheduler },
      { assertSupportedWorkerReplicaCount, SyncWorker },
      { startRuntimeTelemetry, stopRuntimeTelemetry },
      { triageSyncScheduler },
      { publicRuntimeRelease },
      { WorkerHealthSnapshotScheduler },
      { taskReminderScheduler },
      { financeConnectionRecoveryScheduler },
      { houstonMemoryRetentionScheduler },
      { getWorkerPersistenceRepositories },
      { EventOutboxDispatcher },
      { NotificationEnrichmentWorker },
      { createPackagedNotificationEnrichmentExecutor },
      { getDurableAiRunRepository, DurableAiRunWorker },
      { createPackagedDurableAiRuntime },
      semanticRuntime,
      {
        POSTGRES_PACKAGED_WORKFLOW_FAMILIES,
        composePostgresPackagedWorkflowCapability,
        PostgresWorkerProcessingLatch,
      },
      {
        assertAtomicWorkerComponentOrder,
        PACKAGED_SYNC_WORKER_COMPONENT_ORDER,
        startAtomicWorkerComponents,
      },
      {
        SEMANTIC_SOURCE_ENTITY_TYPES,
      },
    ] = await Promise.all([
      import('@/lib/sync'),
      import('@/lib/sync/worker'),
      import('@/lib/telemetry/runtime'),
      import('@/lib/triage/scheduler'),
      import('@/lib/runtime/release'),
      import('@/lib/telemetry/health-snapshot'),
      import('@/lib/push/task-reminder-scheduler'),
      import('@/lib/connectors/monarch-money/recovery-scheduler'),
      import('@/lib/houston-memory/retention'),
      import('@/lib/persistence/worker-runtime'),
      import('@/lib/events/dispatcher'),
      import('@/lib/notifications/enrichment/worker'),
      import('@/lib/notifications/enrichment/packaged-executor'),
      import('@/lib/ai/durable-runs'),
      import('@/lib/ai/durable-runs/packaged-worker'),
      process.env.MC_DATABASE_BACKEND === 'postgres'
        ? import('@/lib/semantic-index/packaged-worker-runtime')
        : import('@/lib/semantic-index/runtime'),
      import('@/lib/runtime/postgres-workflow-capability'),
      import('@/lib/runtime/atomic-components'),
      import('@/lib/semantic-index/source/contracts'),
    ]);

    const workerPersistence = await getWorkerPersistenceRepositories();
    const completeWorkerCompositionPresent = Boolean(
      workerPersistence.connectors
      && workerPersistence.syncRuns
      && workerPersistence.execution
      && workerPersistence.github
      && workerPersistence.connectorState
      && workerPersistence.notificationDelivery
      && workerPersistence.reminders
      && workerPersistence.triage
      && workerPersistence.planningSignals
      && workerPersistence.projectAutomation
      && workerPersistence.finance
      && workerPersistence.finance.recovery
      && workerPersistence.eventDelivery
      && workerPersistence.eventDelivery.outbox
      && workerPersistence.eventDelivery.subscriptions
      && workerPersistence.notificationEnrichment
    );
    if (!completeWorkerCompositionPresent) {
      throw new Error('Selected worker persistence composition is incomplete');
    }
    assertSupportedWorkerReplicaCount();

    const isPostgres = process.env.MC_DATABASE_BACKEND === 'postgres';
    const processingLatch = new PostgresWorkerProcessingLatch();
    const isParityActive = (workflow: string) =>
      !isPostgres
      || (
        POSTGRES_PACKAGED_WORKFLOW_FAMILIES.includes(
          workflow as (typeof POSTGRES_PACKAGED_WORKFLOW_FAMILIES)[number],
        )
        && processingLatch.isActive()
      );
    const worker = new SyncWorker(
      (connectorId, options) => syncScheduler.runSyncLocally(connectorId, options),
      { isEnabled: () => isParityActive('planning-signals') },
    );
    const eventOutboxDispatcher = new EventOutboxDispatcher({
      repositories: workerPersistence.eventDelivery,
      isEnabled: () => isParityActive('event-outbox'),
      scheduleWakeups: true,
    });
    const notificationEnrichmentWorker = new NotificationEnrichmentWorker({
      repository: workerPersistence.notificationEnrichment,
      isEnabled: () => isParityActive('notification-enrichment'),
      execute: isPostgres
        ? await createPackagedNotificationEnrichmentExecutor()
        : undefined,
    });

    let aiRunWorker: { start(): void; stop(): Promise<void>; wake(): void };
    let stopAiRunRuntime: () => Promise<void>;
    let durableExecutorRoutes: readonly string[] = [];
    if (isPostgres) {
      const durableRuntime = createPackagedDurableAiRuntime(
        await getDurableAiRunRepository(),
        syncLogger,
        () => isParityActive('durable-ai'),
        { createCopilotClient: dependencies.createCopilotClient },
      );
      aiRunWorker = durableRuntime.worker;
      stopAiRunRuntime = durableRuntime.stop;
      durableExecutorRoutes = durableRuntime.executorRoutes;
      disposePrepared = durableRuntime.stop;
    } else {
      aiRunWorker = new DurableAiRunWorker(
        await getDurableAiRunRepository(),
        new Map(),
        {
          reportError: (error, operation, runId) => {
            syncLogger.error(
              { err: error, operation, runId },
              'Durable AI worker operation failed',
            );
          },
        },
      );
      stopAiRunRuntime = () => aiRunWorker.stop();
    }

    let startSemantic: () => void | Promise<void>;
    let stopSemantic: () => Promise<void>;
    let wakeSemantic = () => {};
    if (isPostgres) {
      const postgresSemanticRuntime = semanticRuntime as typeof import(
        '@/lib/semantic-index/packaged-worker-runtime'
      );
      const composedSemantic =
        await postgresSemanticRuntime.createPackagedPostgresSemanticRuntime(
          () => isParityActive('semantic-search'),
        );
      startSemantic = () =>
        postgresSemanticRuntime.startPackagedPostgresSemanticWorker(
          composedSemantic,
        );
      stopSemantic =
        postgresSemanticRuntime.stopPackagedPostgresSemanticWorker;
      wakeSemantic = () => composedSemantic.worker.wake();
      const disposeDurable = disposePrepared;
      disposePrepared = async () => {
        const results = await Promise.allSettled([
          stopSemantic(),
          disposeDurable(),
        ]);
        const failures = results
          .filter((result): result is PromiseRejectedResult =>
            result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Prepared PostgreSQL workflow cleanup was incomplete',
          );
        }
      };
    } else {
      const sqliteSemanticRuntime = semanticRuntime as typeof import(
        '@/lib/semantic-index/runtime'
      );
      startSemantic = async () => {
        if (
          workerPersistence.execution.support
            .allowsLegacyWorkflow('semantic-search')
        ) {
          await sqliteSemanticRuntime.startSemanticIndexWorker();
        } else {
          syncLogger.warn(
            'Sync worker: semantic index worker is disabled for this persistence backend',
          );
        }
      };
      stopSemantic = sqliteSemanticRuntime.stopSemanticIndexWorker;
    }

    let telemetry: Awaited<ReturnType<typeof startRuntimeTelemetry>> | null = null;
    function requireStartedTelemetry(): Awaited<ReturnType<typeof startRuntimeTelemetry>> {
      if (!telemetry) throw new Error('Runtime telemetry did not start');
      return telemetry;
    }
    let healthSnapshotScheduler:
      InstanceType<typeof WorkerHealthSnapshotScheduler> | null = null;
    const components: AtomicWorkerComponent[] = [
      {
        name: 'runtime-telemetry',
        start: async () => {
          telemetry = await startRuntimeTelemetry('worker');
        },
        stop: () => stopRuntimeTelemetry(shutdownReason),
      },
      {
        name: 'sync-claim-worker',
        start: () => worker.start(),
        stop: () => worker.stop(),
      },
      {
        name: 'durable-ai',
        start: () => aiRunWorker.start(),
        stop: stopAiRunRuntime,
      },
      {
        name: 'task-reminders',
        start: async () => {
          await taskReminderScheduler.start();
          syncLogger.info('Sync worker: durable task reminder scheduler initialized');
        },
        stop: () => taskReminderScheduler.stop(),
      },
      {
        name: 'event-outbox',
        start: async () => {
          await eventOutboxDispatcher.start();
          syncLogger.info('Sync worker: durable event outbox dispatcher initialized');
        },
        stop: () => eventOutboxDispatcher.stop(),
      },
      {
        name: 'notification-enrichment',
        start: () => {
          notificationEnrichmentWorker.start();
          syncLogger.info(
            'Sync worker: durable notification enrichment worker initialized',
          );
        },
        stop: () => notificationEnrichmentWorker.stop(),
      },
      {
        name: 'sync-schedulers',
        start: async () => {
          await syncScheduler.scheduleAll();
          syncScheduler.startNightlyFullSync();
          const githubWorkerCompositionPresent = Boolean(
            workerPersistence.github?.identity
            && workerPersistence.github.writeFence
            && workerPersistence.github.dependencies
            && workerPersistence.github.hierarchy
            && workerPersistence.github.projects,
          );
          if (
            githubWorkerCompositionPresent
            && workerPersistence.execution.support
              .allowsLegacyWorkflow('dependency-reconciliation')
          ) {
            syncScheduler.startDependencyReconciliationResume();
            syncScheduler.startDependencyRelationshipPolling();
          } else {
            syncLogger.warn(
              { githubWorkerCompositionPresent },
              'Sync worker: dependency reconciliation resume and relationship polling are disabled',
            );
          }
          syncScheduler.startWatchdog();
        },
        stop: () => syncScheduler.stopAll(),
      },
      {
        name: 'finance-recovery',
        start: () => financeConnectionRecoveryScheduler.start(),
        stop: () => financeConnectionRecoveryScheduler.stop(),
      },
      {
        name: 'triage-scheduler',
        start: async () => {
          try {
            await triageSyncScheduler.initialize();
          } catch (error) {
            syncLogger.warn(
              { err: error },
              'Sync worker: triage auto-sync initialization failed',
            );
          }
        },
        stop: () => triageSyncScheduler.stopAll(),
      },
      {
        name: 'semantic-index',
        start: startSemantic,
        stop: stopSemantic,
      },
      {
        name: 'houston-memory-retention',
        start: () => houstonMemoryRetentionScheduler.start(),
        stop: () => houstonMemoryRetentionScheduler.stop(),
      },
      {
        name: 'worker-health-snapshots',
        start: () => {
          if (!telemetry) {
            throw new Error('Runtime telemetry is unavailable for worker health');
          }
          healthSnapshotScheduler = new WorkerHealthSnapshotScheduler(
            telemetry.instanceId,
            () => worker.hasPendingWork(),
          );
          healthSnapshotScheduler.start();
        },
        stop: () => healthSnapshotScheduler?.stop() ?? Promise.resolve(),
      },
    ];

    const capability = isPostgres
      ? composePostgresPackagedWorkflowCapability({
          persistence: workerPersistence,
          durableExecutorRoutes,
          semanticEntityTypes: SEMANTIC_SOURCE_ENTITY_TYPES,
          semanticIntentKinds: ['upsert', 'delete'],
          lifecycleStops: {
            'planning-signals': () => worker.stop(),
            'project-automation': () => worker.stop(),
            'event-outbox': () => eventOutboxDispatcher.stop(),
            'notification-enrichment': () => notificationEnrichmentWorker.stop(),
            'durable-ai': stopAiRunRuntime,
            'semantic-search': stopSemantic,
          },
        })
      : null;
    if (
      capability
      && capability.workflows.length !== POSTGRES_PACKAGED_WORKFLOW_FAMILIES.length
    ) {
      throw new Error('PostgreSQL packaged workflow capability is incomplete');
    }
    if (capability) {
      processingLatch.onActivate(() => worker.wake());
      processingLatch.onActivate(() => aiRunWorker.wake());
      processingLatch.onActivate(() => notificationEnrichmentWorker.wake());
      processingLatch.onActivate(() => {
        void eventOutboxDispatcher.drain();
      });
      processingLatch.onActivate(wakeSemantic);
      components.push({
        name: 'postgres-workflow-capability',
        start: () => processingLatch.activate(capability),
        stop: () => processingLatch.deactivate(capability),
      });
      assertAtomicWorkerComponentOrder(
        components,
        PACKAGED_SYNC_WORKER_COMPONENT_ORDER,
      );
    }

    const shutdown = (signal: NodeJS.Signals): Promise<void> => {
      receivedSignal = signal;
      shutdownReason = signal;
      startupAbort.abort(new Error(`Worker received ${signal}`));
      rmSync(instanceFile, { force: true });
      shutdownPromise ??= (async () => {
        await startupSettled;
        syncLogger.info({ signal }, 'Sync worker shutting down');
        const failures: unknown[] = [];
        try {
          if (lifecycle) await lifecycle.stop();
          else await disposePrepared();
        } catch (error) {
          failures.push(error);
        }
        try {
          const { shutdownRuntimeDatabase } = await import('@/db/runtime');
          await shutdownRuntimeDatabase();
          databaseInitialized = false;
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Sync worker shutdown failed');
        }
      })();
      return shutdownPromise;
    };
    const onSigterm = () => {
      void shutdown('SIGTERM').then(
        () => process.exit(0),
        (error) => {
          syncLogger.error({ err: error, signal: 'SIGTERM' }, 'Sync worker shutdown failed');
          process.exit(1);
        },
      );
    };
    const onSigint = () => {
      void shutdown('SIGINT').then(
        () => process.exit(0),
        (error) => {
          syncLogger.error({ err: error, signal: 'SIGINT' }, 'Sync worker shutdown failed');
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    removeSignalHandlers = () => {
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    };

    syncLogger.info(
      { runtimeRelease: publicRuntimeRelease(), role: 'worker' },
      'Sync worker starting',
    );
    lifecycle = await startAtomicWorkerComponents(
      components,
      startupAbort.signal,
    );
    startupAbort.signal.throwIfAborted();
    const startedTelemetry = requireStartedTelemetry();
    writeFileSync(instanceFile, startedTelemetry.instanceId, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const { wakeNotificationDeliveryDispatcher } = await import(
      '@/lib/notifications/dispatcher-wake'
    );
    wakeNotificationDeliveryDispatcher();
    syncLogger.info(
      {
        semanticWorker: true,
        postgresWorkflowParity: capability?.workflows ?? null,
      },
      'Sync worker ready',
    );
    settleStartup();
    if (receivedSignal) await shutdown(receivedSignal);
  } catch (startupError) {
    rmSync(instanceFile, { force: true });
    settleStartup();
    if (receivedSignal && shutdownPromise) {
      await shutdownPromise;
      return;
    }
    removeSignalHandlers();
    const failures: unknown[] = [startupError];
    if (lifecycle) {
      try {
        await lifecycle.stop();
      } catch (error) {
        failures.push(error);
      }
    } else {
      try {
        await disposePrepared();
      } catch (error) {
        failures.push(error);
      }
    }
    if (databaseInitialized) {
      try {
        const { shutdownRuntimeDatabase } = await import('@/db/runtime');
        await shutdownRuntimeDatabase();
      } catch (error) {
        failures.push(error);
      }
    }
    throw failures.length === 1
      ? startupError
      : new AggregateError(
          failures,
          'Sync worker startup and cleanup failed',
        );
  }
}
