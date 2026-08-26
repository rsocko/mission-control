/**
 * Next.js instrumentation hook — runs once on server startup.
 * Ensures the sync scheduler is initialized reliably, with retry logic
 * in case the database isn't ready immediately.
 */
export async function register() {
  // Only run in the Node.js runtime — the Edge runtime (used by middleware)
  // cannot load Node built-ins like node:crypto or better-sqlite3.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { syncLogger } = await import('@/lib/logger');
  const {
    configureRuntimeLifecycle,
    markRuntimeReady,
  } = await import('@/lib/runtime/lifecycle');
  const { terminateFailedStartup } = await import('@/lib/runtime/startup');
  configureRuntimeLifecycle('web');
  try {
    const { initializeDatabaseWithRetry } = await import('@/db/startup');
    await initializeDatabaseWithRetry();
  } catch (error) {
    syncLogger.error(
      { err: error },
      'Instrumentation: database startup failed; terminating for container recovery',
    );
    terminateFailedStartup(error);
  }
  const { isPublicDemoMode } = await import('@/lib/public-demo');
  if (isPublicDemoMode()) {
    try {
      const { initializePublicDemoData } = await import('@/lib/public-demo-runtime');
      await initializePublicDemoData();
    } catch (error) {
      syncLogger.error(
        { err: error },
        'Instrumentation: public demo initialization failed; terminating for container recovery',
      );
      terminateFailedStartup(error);
    }
    const { startRuntimeTelemetry } = await import('@/lib/telemetry/runtime');
    await startRuntimeTelemetry('web');
    markRuntimeReady();
    syncLogger.info('Instrumentation: public demo database reset and seeded');
    return;
  }

  const { startRuntimeTelemetry } = await import('@/lib/telemetry/runtime');
  await startRuntimeTelemetry('web');
  const {
    pushNotificationScheduler,
    scheduledSummariesEnabled,
  } = await import('@/lib/push/scheduler');
  const { wakeNotificationWritebackDispatcher } = await import(
    '@/lib/notifications/notification-writeback'
  );
  wakeNotificationWritebackDispatcher();
  const durableSyncMode = process.env.MC_SYNC_EXECUTION_MODE === 'worker';

  if (durableSyncMode) {
    syncLogger.info('Instrumentation: connector schedulers delegated to sync worker');
  } else {
    const { syncScheduler } = await import('@/lib/sync');
    const { triageSyncScheduler } = await import('@/lib/triage/scheduler');

    // The scheduleAll() at module level may have already fired,
    // but it's idempotent (skips connectors that already have jobs).
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 5_000;
    let initialized = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await syncScheduler.scheduleAll();
        syncLogger.info(
          { attempt, scheduledJobs: (await syncScheduler.getStatus()).length },
          'Instrumentation: sync scheduler initialized'
        );
        initialized = true;
        break;
      } catch (err) {
        syncLogger.warn(
          { err, attempt, maxRetries: MAX_RETRIES },
          attempt < MAX_RETRIES
            ? 'Instrumentation: scheduleAll failed, retrying'
            : 'Instrumentation: scheduleAll failed on final startup attempt'
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    if (!initialized) {
      syncLogger.error(
        { attempts: MAX_RETRIES },
        'Instrumentation: sync scheduler unavailable after startup retries',
      );
    }

    syncScheduler.startWatchdog();
    const { financeConnectionRecoveryScheduler } = await import(
      '@/lib/connectors/monarch-money/recovery-scheduler'
    );
    await financeConnectionRecoveryScheduler.start();

    try {
      await triageSyncScheduler.initialize();
      syncLogger.info('Instrumentation: triage auto-sync scheduler initialized');
    } catch (err) {
      syncLogger.warn({ err }, 'Instrumentation: triage auto-sync init failed (non-fatal)');
    }
  }

  // Initialize push notification scheduler (morning, triage nudge, carry-forward)
  try {
    if (scheduledSummariesEnabled()) {
      await pushNotificationScheduler.start();
    }
    syncLogger.info(
      { jobs: pushNotificationScheduler.getStatus().length },
      'Instrumentation: push notification scheduler initialized',
    );
  } catch (err) {
    syncLogger.warn({ err }, 'Instrumentation: push notification scheduler init failed (non-fatal)');
  }
  if (!durableSyncMode) {
    try {
      const { taskReminderScheduler } = await import('@/lib/push/task-reminder-scheduler');
      await taskReminderScheduler.start();
      syncLogger.info('Instrumentation: inline task reminder scheduler initialized');
    } catch (err) {
      syncLogger.warn({ err }, 'Instrumentation: task reminder scheduler init failed (non-fatal)');
    }
  }
  markRuntimeReady();
}
