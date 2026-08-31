import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';
import type { ConnectorConfig, SyncResult } from '@/types';
import { syncLogger } from '@/lib/logger';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  getSyncJobRepository,
  isDurableSyncMode,
} from './job-queue';
import type { SyncRequestOptions } from './queue';
import { isConnectorSyncQuarantinedAsync } from './control-state';

interface ScheduledJob {
  connectorId: string;
  task: ScheduledTask;
  intervalMinutes: number;
}

const STAGGER_DELAY_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 20 * 60 * 1000;

async function fetchConnectorConfig(connectorId: string): Promise<ConnectorConfig | null> {
  return (await getWorkerPersistenceRepositories()).connectors.get(connectorId);
}

async function listEnabledConnectorConfigs(): Promise<ConnectorConfig[]> {
  return (await getWorkerPersistenceRepositories()).connectors.listEnabled();
}

export class SyncCronScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private nightlyFullSyncTask: ScheduledTask | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly requestSync: (
      connectorId: string,
      options?: SyncRequestOptions,
    ) => Promise<SyncResult>,
    private readonly getLastResult: (connectorId: string) => Promise<SyncResult | undefined>,
    private readonly getInlineActiveSyncs: () => Promise<string[]>,
  ) {}

  async schedule(config: ConnectorConfig, staggerIndex = 0): Promise<void> {
    if (await isConnectorSyncQuarantinedAsync(config.id)) {
      await this.unschedule(config.id);
      return;
    }
    const repository = await getSyncJobRepository();
    if (isDurableSyncMode()) {
      if (!config.enabled || config.syncMode === 'manual') {
        await repository.unregisterSchedule(config.id);
        return;
      }
      if (config.syncMode === 'poll' && config.pollIntervalMinutes) {
        await repository.registerSchedule(config.id, config.pollIntervalMinutes);
      }
      return;
    }

    await this.unschedule(config.id);
    if (!config.enabled || config.syncMode === 'manual') return;

    if (config.syncMode === 'poll' && config.pollIntervalMinutes) {
      await repository.registerSchedule(config.id, config.pollIntervalMinutes);
      const staggerMs = staggerIndex * STAGGER_DELAY_MS;
      const task = cron.schedule(this.intervalToCron(config.pollIntervalMinutes), () => {
        void repository.markScheduleEnqueued(config.id);
        if (staggerMs > 0) {
          setTimeout(() => {
            void this.requestSync(config.id, { source: 'schedule' });
          }, staggerMs);
        } else {
          void this.requestSync(config.id, { source: 'schedule' });
        }
      });
      this.jobs.set(config.id, {
        connectorId: config.id,
        task,
        intervalMinutes: config.pollIntervalMinutes,
      });
      task.start();
    }
  }

  async unschedule(connectorId: string): Promise<void> {
    const job = this.jobs.get(connectorId);
    if (job) {
      job.task.stop();
      this.jobs.delete(connectorId);
    }
    await (await getSyncJobRepository()).unregisterSchedule(connectorId);
  }

  async reconcileScheduleFromDb(connectorId: string): Promise<void> {
    const config = await fetchConnectorConfig(connectorId);
    if (!config) {
      await this.unschedule(connectorId);
      return;
    }
    await this.schedule(config);
  }

  async scheduleAll(): Promise<void> {
    try {
      const rows = await listEnabledConnectorConfigs();
      let scheduled = 0;
      for (const row of rows) {
        if (this.jobs.has(row.id)) continue;
        try {
          await this.schedule(row, scheduled);
          scheduled++;
        } catch (connectorErr) {
          syncLogger.error(
            { err: connectorErr, connectorId: row.id },
            'Failed to schedule individual connector',
          );
        }
      }
      syncLogger.info(
        { scheduled, alreadyScheduled: this.jobs.size - scheduled, total: rows.length },
        'Scheduled all connectors from DB',
      );
    } catch (err) {
      syncLogger.error({ err }, 'Failed to schedule connectors from DB');
      throw err;
    }
  }

  startNightlyFullSync(): void {
    if (this.nightlyFullSyncTask) return;
    this.nightlyFullSyncTask = cron.schedule('0 3 * * *', async () => {
      syncLogger.info('Nightly full sync starting');
      try {
        const rows = await listEnabledConnectorConfigs();
        for (const row of rows) {
          if (await isConnectorSyncQuarantinedAsync(row.id)) continue;
          try {
            await this.requestSync(row.id, { full: true, source: 'nightly' });
          } catch (err) {
            syncLogger.error(
              { err, connectorId: row.id },
              'Nightly full sync failed for connector',
            );
          }
        }
        syncLogger.info({ connectorCount: rows.length }, 'Nightly full sync complete');
      } catch (err) {
        syncLogger.error({ err }, 'Nightly full sync failed');
      }
    });
    this.nightlyFullSyncTask.start();
    syncLogger.info('Nightly full sync scheduled for 3:00 AM');
  }

  startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(async () => {
      try {
        const rows = await listEnabledConnectorConfigs();
        const pollConnectors = rows.filter((row) => (row.syncMode || 'poll') === 'poll');
        if (!isDurableSyncMode() && pollConnectors.length > 0 && this.jobs.size === 0) {
          syncLogger.warn(
            { expected: pollConnectors.length, actual: this.jobs.size },
            'Watchdog: no cron jobs found, re-scheduling all connectors',
          );
          await this.scheduleAll();
        }

        const activeConnectorIds = new Set(await this.getInlineActiveSyncs());
        for (const row of pollConnectors) {
          if (await isConnectorSyncQuarantinedAsync(row.id)) continue;
          if (activeConnectorIds.has(row.id)) continue;
          const lastResult = await this.getLastResult(row.id);
          if (!lastResult) continue;
          const elapsed = Date.now() - new Date(lastResult.syncedAt).getTime();
          const expectedInterval = (row.pollIntervalMinutes ?? 5) * 60 * 1000;
          const threshold = Math.max(expectedInterval * 3, STALE_THRESHOLD_MS);
          if (elapsed > threshold) {
            syncLogger.warn(
              { connectorId: row.id, elapsedMs: elapsed, thresholdMs: threshold },
              'Watchdog: connector sync is stale, triggering immediate sync',
            );
            void this.requestSync(row.id, { source: 'watchdog' }).catch((err) => {
              syncLogger.error(
                { err, connectorId: row.id },
                'Watchdog: triggered sync failed',
              );
            });
          }
        }
      } catch (err) {
        syncLogger.error({ err }, 'Watchdog: check failed');
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  async getStatus(): Promise<Array<{
    connectorId: string;
    intervalMinutes: number;
    isRunning: boolean;
    lastResult?: SyncResult;
  }>> {
    const repository = await getSyncJobRepository();
    const activeConnectorIds = new Set(
      isDurableSyncMode()
        ? await repository.getActiveConnectorIds()
        : await this.getInlineActiveSyncs(),
    );
    const schedules = isDurableSyncMode()
      ? await repository.getSchedules()
      : Array.from(this.jobs.values());
    return Promise.all(schedules.map(async (job) => ({
      connectorId: job.connectorId,
      intervalMinutes: job.intervalMinutes,
      isRunning: activeConnectorIds.has(job.connectorId),
      lastResult: await this.getLastResult(job.connectorId),
    })));
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.task.stop();
    this.jobs.clear();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.nightlyFullSyncTask) {
      this.nightlyFullSyncTask.stop();
      this.nightlyFullSyncTask = null;
    }
  }

  private intervalToCron(minutes: number): string {
    if (minutes <= 1) return '* * * * *';
    if (minutes < 60) return `*/${minutes} * * * *`;
    const hours = Math.floor(minutes / 60);
    return `0 */${hours} * * *`;
  }
}
