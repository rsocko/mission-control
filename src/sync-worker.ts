import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MC_PROCESS_ROLE = 'worker';
const instanceFile = process.env.MC_WORKER_INSTANCE_FILE
  ?? join(tmpdir(), 'mission-control-worker-instance');
rmSync(instanceFile, { force: true });
export {};

async function main(): Promise<void> {
  const [{ syncLogger }, { waitForWebReadiness }] = await Promise.all([
    import('@/lib/logger'),
    import('@/lib/runtime/web-readiness'),
  ]);
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
  const { wakeNotificationDeliveryDispatcher } = await import(
    '@/lib/notifications/dispatcher-wake'
  );
  wakeNotificationDeliveryDispatcher();

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
  ]);

  const { getWorkerPersistenceRepositories } = await import('@/lib/persistence/worker-runtime');
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
    && workerPersistence.finance.recovery,
  );
  if (!completeWorkerCompositionPresent) {
    throw new Error('Selected worker persistence composition is incomplete');
  }

  assertSupportedWorkerReplicaCount();
  syncLogger.info(
    { runtimeRelease: publicRuntimeRelease(), role: 'worker' },
    'Sync worker starting',
  );
  const telemetry = await startRuntimeTelemetry('worker');
  writeFileSync(instanceFile, telemetry.instanceId, { encoding: 'utf8', mode: 0o600 });
  const worker = new SyncWorker((connectorId, options) =>
    syncScheduler.runSyncLocally(connectorId, options)
  );
  let aiRunWorker: { start(): void; stop(): Promise<void> } | null = null;
  if (process.env.MC_DATABASE_BACKEND !== 'postgres') {
    const { DurableAiRunStore, DurableAiRunWorker } = await import('@/lib/ai/durable-runs');
    aiRunWorker = new DurableAiRunWorker(
      new DurableAiRunStore(),
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
  } else {
    syncLogger.warn('Sync worker: legacy durable AI run worker is disabled on PostgreSQL');
  }
  const healthSnapshotScheduler = new WorkerHealthSnapshotScheduler(
    telemetry.instanceId,
    () => worker.hasPendingWork(),
  );
  worker.start();
  aiRunWorker?.start();
  await taskReminderScheduler.start();
  syncLogger.info('Sync worker: durable task reminder scheduler initialized');

  await syncScheduler.scheduleAll();
  syncScheduler.startNightlyFullSync();
  // The GitHub worker composition is registered atomically, so a present
  // `github` member means every Layer 3A surface (identity/write fence,
  // dependencies, hierarchy, projects) is available on the selected backend.
  // Only then may the dependency resume and relationship pollers start.
  const githubWorkerCompositionPresent = Boolean(
    workerPersistence.github?.identity
    && workerPersistence.github.writeFence
    && workerPersistence.github.dependencies
    && workerPersistence.github.hierarchy
    && workerPersistence.github.projects,
  );
  if (
    githubWorkerCompositionPresent
    && workerPersistence.execution.support.allowsLegacyWorkflow('dependency-reconciliation')
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
  await financeConnectionRecoveryScheduler.start();

  try {
    await triageSyncScheduler.initialize();
    syncLogger.info('Sync worker: triage auto-sync scheduler initialized');
  } catch (error) {
    syncLogger.warn({ err: error }, 'Sync worker: triage auto-sync initialization failed');
  }

  let semanticIndexWorker: Awaited<
    ReturnType<typeof import('@/lib/semantic-index/runtime')['startSemanticIndexWorker']>
  > = null;
  let stopSemanticIndexWorker = async (): Promise<void> => {};
  if (workerPersistence.execution.support.allowsLegacyWorkflow('semantic-search')) {
    const semanticRuntime = await import('@/lib/semantic-index/runtime');
    semanticIndexWorker = await semanticRuntime.startSemanticIndexWorker();
    stopSemanticIndexWorker = semanticRuntime.stopSemanticIndexWorker;
  } else {
    syncLogger.warn('Sync worker: semantic index worker is disabled for this persistence backend');
  }
  houstonMemoryRetentionScheduler.start();
  syncLogger.info(
    { started: semanticIndexWorker !== null },
    'Sync worker: semantic index worker initialization completed',
  );
  healthSnapshotScheduler.start();

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) return;
    shutdownPromise = (async () => {
      syncLogger.info({ signal }, 'Sync worker shutting down');
      await Promise.all([
        healthSnapshotScheduler.stop(),
        taskReminderScheduler.stop(),
        financeConnectionRecoveryScheduler.stop(),
        triageSyncScheduler.stopAll(),
        houstonMemoryRetentionScheduler.stop(),
        syncScheduler.stopAll(),
        worker.stop(),
        aiRunWorker?.stop() ?? Promise.resolve(),
        stopSemanticIndexWorker(),
      ]);
      await stopRuntimeTelemetry(signal);
      const { shutdownRuntimeDatabase } = await import('@/db/runtime');
      await shutdownRuntimeDatabase();
      rmSync(instanceFile, { force: true });
    })().then(
      () => process.exit(0),
      (error) => {
        syncLogger.error({ err: error, signal }, 'Sync worker shutdown failed');
        process.exit(1);
      },
    );
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void main().catch((error) => {
  rmSync(instanceFile, { force: true });
  console.error('Sync worker failed to start', error);
  process.exit(1);
});
