import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { ConnectorConfig, SyncResult } from '@/types';
import { syncLogger } from '@/lib/logger';
import {
  getActiveSyncJobConnectorIds,
  getSyncSchedules,
  isDurableSyncMode,
  markSyncScheduleEnqueued,
  registerSyncSchedule,
  unregisterSyncSchedule,
} from './job-queue';
import type { SyncRequestOptions } from './queue';
import { isConnectorSyncQuarantined } from './control-state';

interface ScheduledJob {
  connectorId: string;
  task: ScheduledTask;
  intervalMinutes: number;
}

const STAGGER_DELAY_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 20 * 60 * 1000;

export class SyncCronScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private nightlyFullSyncTask: ScheduledTask | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly requestSync: (
      connectorId: string,
      options?: SyncRequestOptions,
    ) => Promise<SyncResult>,
    private readonly getLastResult: (connectorId: string) => SyncResult | undefined,
    private readonly getInlineActiveSyncs: () => string[],
  ) {}

  schedule(config: ConnectorConfig, staggerIndex = 0): void {
    if (isConnectorSyncQuarantined(config.id)) {
      this.unschedule(config.id);
      return;
    }
    if (isDurableSyncMode()) {
      if (!config.enabled || config.syncMode === 'manual') {
        unregisterSyncSchedule(config.id);
        return;
      }
      if (config.syncMode === 'poll' && config.pollIntervalMinutes) {
        registerSyncSchedule(config.id, config.pollIntervalMinutes);
      }
      return;
    }

    this.unschedule(config.id);
    if (!config.enabled || config.syncMode === 'manual') return;

    if (config.syncMode === 'poll' && config.pollIntervalMinutes) {
      registerSyncSchedule(config.id, config.pollIntervalMinutes);
      const staggerMs = staggerIndex * STAGGER_DELAY_MS;
      const task = cron.schedule(this.intervalToCron(config.pollIntervalMinutes), () => {
        markSyncScheduleEnqueued(config.id);
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

  unschedule(connectorId: string): void {
    const job = this.jobs.get(connectorId);
    if (job) {
      job.task.stop();
      this.jobs.delete(connectorId);
    }
    unregisterSyncSchedule(connectorId);
  }

  async reconcileScheduleFromDb(connectorId: string): Promise<void> {
    const [row] = await db.select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, connectorId))
      .limit(1);
    if (!row || row.deletedAt) {
      this.unschedule(connectorId);
      return;
    }
    this.schedule(this.configFromRow(row));
  }

  async scheduleAll(): Promise<void> {
    try {
      const rows = await db.select().from(connectorConfigs)
        .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)));
      let scheduled = 0;
      for (const row of rows) {
        if (this.jobs.has(row.id)) continue;
        try {
          this.schedule(this.configFromRow(row), scheduled);
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
        const rows = await db.select({ id: connectorConfigs.id })
          .from(connectorConfigs)
          .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)));
        for (const row of rows) {
          if (isConnectorSyncQuarantined(row.id)) continue;
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
        const rows = await db.select().from(connectorConfigs)
          .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)));
        const pollConnectors = rows.filter((row) => (row.syncMode || 'poll') === 'poll');
        if (!isDurableSyncMode() && pollConnectors.length > 0 && this.jobs.size === 0) {
          syncLogger.warn(
            { expected: pollConnectors.length, actual: this.jobs.size },
            'Watchdog: no cron jobs found, re-scheduling all connectors',
          );
          await this.scheduleAll();
        }

        const activeConnectorIds = new Set(
          isDurableSyncMode()
            ? getActiveSyncJobConnectorIds()
            : this.getInlineActiveSyncs(),
        );
        for (const row of pollConnectors) {
          if (isConnectorSyncQuarantined(row.id)) continue;
          if (activeConnectorIds.has(row.id)) continue;
          const lastResult = this.getLastResult(row.id);
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

  getStatus(): Array<{
    connectorId: string;
    intervalMinutes: number;
    isRunning: boolean;
    lastResult?: SyncResult;
  }> {
    const activeConnectorIds = new Set(
      isDurableSyncMode()
        ? getActiveSyncJobConnectorIds()
        : this.getInlineActiveSyncs(),
    );
    const schedules = isDurableSyncMode()
      ? getSyncSchedules()
      : Array.from(this.jobs.values());
    return schedules.map((job) => ({
      connectorId: job.connectorId,
      intervalMinutes: job.intervalMinutes,
      isRunning: activeConnectorIds.has(job.connectorId),
      lastResult: this.getLastResult(job.connectorId),
    }));
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

  private configFromRow(row: typeof connectorConfigs.$inferSelect): ConnectorConfig {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled ?? true,
      syncMode: (row.syncMode as ConnectorConfig['syncMode']) || 'poll',
      pollIntervalMinutes: row.pollIntervalMinutes ?? 5,
      capabilities: (typeof row.capabilities === 'string'
        ? JSON.parse(row.capabilities)
        : row.capabilities) as ConnectorConfig['capabilities'],
      credentials: (typeof row.credentials === 'string'
        ? JSON.parse(row.credentials)
        : row.credentials) || {},
      settings: (typeof row.settings === 'string'
        ? JSON.parse(row.settings)
        : row.settings) || {},
      syncedLists: (typeof row.syncedLists === 'string'
        ? JSON.parse(row.syncedLists)
        : row.syncedLists) || [],
    };
  }

  private intervalToCron(minutes: number): string {
    if (minutes <= 1) return '* * * * *';
    if (minutes < 60) return `*/${minutes} * * * *`;
    const hours = Math.floor(minutes / 60);
    return `0 */${hours} * * *`;
  }
}
