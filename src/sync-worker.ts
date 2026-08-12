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

  const [
    { syncScheduler },
    { assertSupportedWorkerReplicaCount, SyncWorker },
    { startRuntimeTelemetry, stopRuntimeTelemetry },
    { triageSyncScheduler },
    { publicRuntimeRelease },
    { DurableAiRunStore, DurableAiRunWorker },
  ] = await Promise.all([
    import('@/lib/sync'),
    import('@/lib/sync/worker'),
    import('@/lib/telemetry/runtime'),
    import('@/lib/triage/scheduler'),
    import('@/lib/runtime/release'),
    import('@/lib/ai/durable-runs'),
  ]);

  assertSupportedWorkerReplicaCount();
  syncLogger.info(
    { runtimeRelease: publicRuntimeRelease(), role: 'worker' },
    'Sync worker starting',
  );
  const { initializeDatabaseWithRetry } = await import('@/db/startup');
  const telemetry = await initializeDatabaseWithRetry({
    initialize: () => startRuntimeTelemetry('worker'),
  });
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
  worker.start();
  aiRunWorker.start();

  await syncScheduler.scheduleAll();
  syncScheduler.startNightlyFullSync();
  syncScheduler.startDependencyReconciliationResume();
  syncScheduler.startDependencyRelationshipPolling();
  syncScheduler.startWatchdog();

  try {
    await triageSyncScheduler.initialize();
    syncLogger.info('Sync worker: triage auto-sync scheduler initialized');
  } catch (error) {
    syncLogger.warn({ err: error }, 'Sync worker: triage auto-sync initialization failed');
  }

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) return;
    shutdownPromise = (async () => {
      syncLogger.info({ signal }, 'Sync worker shutting down');
      await Promise.all([
        syncScheduler.stopAll(),
        worker.stop(),
        aiRunWorker.stop(),
      ]);
      stopRuntimeTelemetry(signal);
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
