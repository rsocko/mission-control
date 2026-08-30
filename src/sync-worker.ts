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

  const [
    { syncScheduler },
    { assertSupportedWorkerReplicaCount, SyncWorker },
    { startRuntimeTelemetry, stopRuntimeTelemetry },
    { triageSyncScheduler },
    { publicRuntimeRelease },
    { DurableAiRunStore, DurableAiRunWorker },
    { WorkerHealthSnapshotScheduler },
    { taskReminderScheduler },
    { financeConnectionRecoveryScheduler },
    { startSemanticIndexWorker, stopSemanticIndexWorker },
    { houstonMemoryRetentionScheduler },
  ] = await Promise.all([
    import('@/lib/sync'),
    import('@/lib/sync/worker'),
    import('@/lib/telemetry/runtime'),
    import('@/lib/triage/scheduler'),
    import('@/lib/runtime/release'),
    import('@/lib/ai/durable-runs'),
    import('@/lib/telemetry/health-snapshot'),
    import('@/lib/push/task-reminder-scheduler'),
    import('@/lib/connectors/monarch-money/recovery-scheduler'),
    import('@/lib/semantic-index/runtime'),
    import('@/lib/houston-memory/retention'),
  ]);

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
  const aiRunWorker = new DurableAiRunWorker(
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
  const healthSnapshotScheduler = new WorkerHealthSnapshotScheduler(
    telemetry.instanceId,
    () => worker.hasPendingWork(),
  );
  worker.start();
  aiRunWorker.start();
  await taskReminderScheduler.start();
  syncLogger.info('Sync worker: durable task reminder scheduler initialized');

  await syncScheduler.scheduleAll();
  syncScheduler.startNightlyFullSync();
  const { getWorkerPersistenceRepositories } = await import('@/lib/persistence/worker-runtime');
  const workerPersistence = await getWorkerPersistenceRepositories();
  if (workerPersistence.execution.support.allowsLegacyWorkflow('dependency-reconciliation')) {
    syncScheduler.startDependencyReconciliationResume();
    syncScheduler.startDependencyRelationshipPolling();
  }
  syncScheduler.startWatchdog();
  await financeConnectionRecoveryScheduler.start();

  try {
    await triageSyncScheduler.initialize();
    syncLogger.info('Sync worker: triage auto-sync scheduler initialized');
  } catch (error) {
    syncLogger.warn({ err: error }, 'Sync worker: triage auto-sync initialization failed');
  }

  // The semantic index worker parks itself when semantic search is disabled or
  // no embedding provider is configured, and `startSemanticIndexWorker` never
  // throws, so it can never keep the sync worker from coming up.
  const semanticIndexWorker = await startSemanticIndexWorker();
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
      healthSnapshotScheduler.stop();
      taskReminderScheduler.stop();
      financeConnectionRecoveryScheduler.stop();
      houstonMemoryRetentionScheduler.stop();
      await Promise.all([
        syncScheduler.stopAll(),
        worker.stop(),
        aiRunWorker.stop(),
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
