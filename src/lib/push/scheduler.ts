/**
 * Push Notification Scheduler
 *
 * Manages cron jobs for push notification triggers using node-cron.
 * Follows the same pattern as FinanceNotificationScheduler and TriageSyncScheduler.
 *
 * Jobs are dynamically scheduled based on user preferences (morningHour,
 * carryForwardHour). The scheduler can be stopped/restarted and re-reads
 * preferences on each restart to pick up changes.
 *
 * All cron schedules run in the user's configured timezone so that
 * "8 AM" means 8 AM local time even when the server runs in UTC.
 *
 * Refs: #1539, #1540, #1541, #1542
 */
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { getPreferences } from '@/lib/notifications/quiet-hours';
import { getTimezone } from '@/lib/mode';
import logger from '@/lib/logger';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';
import { getNotificationPushPersistence } from './notification-push-service';

export const SCHEDULED_SUMMARIES_SETTING_KEY = 'scheduled_summaries_enabled';

export async function scheduledSummariesEnabled(): Promise<boolean> {
  return (await getNotificationPushPersistence()).getScheduledSummariesEnabled();
}

export interface ScheduledPushHandlers {
  triggerMorningNotification(): Promise<boolean>;
  triggerTriageNudge(): Promise<boolean>;
  triggerCarryForwardReminder(): Promise<boolean>;
}

interface PushSchedulerRuntime {
  handlers: ScheduledPushHandlers | null;
  scheduler: PushNotificationScheduler | null;
}

const REGISTRY_KEY = 'mission-control.push-notification-scheduler';
const REGISTRY_SCHEMA_VERSION = 1;

function runtime(): PushSchedulerRuntime {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    handlers: null,
    scheduler: null,
  }));
}

export function registerScheduledPushHandlers(handlers: ScheduledPushHandlers): void {
  const state = runtime();
  if (state.handlers) return;
  state.handlers = handlers;
}

function requireScheduledPushHandlers(): ScheduledPushHandlers {
  const handlers = runtime().handlers;
  if (!handlers) {
    throw new Error('Push notification scheduler handlers have not been registered');
  }
  return handlers;
}

interface PushJob {
  name: string;
  task: ScheduledTask;
  schedule: string;
  lastRun?: string;
  lastResult?: 'sent' | 'skipped' | 'error';
  lastError?: string;
}

/**
 * PushNotificationScheduler manages three cron jobs:
 * - Morning "Start My Day" — runs at the configured morningHour
 * - Triage nudge — runs every 2 hours during daytime (9 AM – 7 PM)
 * - Carry-forward reminder — runs at the configured carryForwardHour
 *
 * Each trigger checks its enabled flag; the central notification service
 * applies shared DND, quiet-hours, policy, dedupe, and rate-limit gates.
 */
export class PushNotificationScheduler {
  private jobs = new Map<string, PushJob>();
  private running = false;
  /** Serializes start/stop/restart to prevent concurrent lifecycle races. */
  private lifecycleLock: Promise<void> = Promise.resolve();

  /** Start all push notification cron jobs based on current preferences. */
  async start(): Promise<void> {
    await this.runLocked(() => this._start());
  }

  /** Stop all cron jobs. */
  async stop(): Promise<void> {
    await this.runLocked(() => this._stop());
  }

  /** Restart with fresh preferences (call after settings change). */
  async restart(): Promise<void> {
    await this.runLocked(async () => {
      if (!this.running) return;
      await this._restartRunning();
    });
  }

  async startAndPersist(): Promise<void> {
    await this.runLocked(async () => {
      if (this.running) {
        await this.persistEnabled(true);
        return;
      }
      requireScheduledPushHandlers();
      await this._start();
      try {
        await this.persistEnabled(true);
      } catch (error) {
        this._stop();
        await this.compensateFailedEnable(error);
      }
    });
  }

  async stopAndPersist(): Promise<void> {
    await this.runLocked(async () => {
      await this.persistEnabled(false);
      this._stop();
    });
  }

  async restartAndPersist(): Promise<void> {
    await this.runLocked(async () => {
      requireScheduledPushHandlers();
      if (this.running) {
        await this.persistEnabled(true);
        await this._restartRunning();
        return;
      }
      await this._start();
      try {
        await this.persistEnabled(true);
      } catch (error) {
        this._stop();
        await this.compensateFailedEnable(error);
      }
    });
  }

  private runLocked(operation: () => void | Promise<void>): Promise<void> {
    const result = this.lifecycleLock.then(operation, operation);
    this.lifecycleLock = result.catch(() => undefined);
    return result;
  }

  private async persistEnabled(enabled: boolean): Promise<void> {
    const persistence = await getNotificationPushPersistence();
    await persistence.setScheduledSummariesEnabled(enabled, new Date().toISOString());
  }

  private async compensateFailedEnable(error: unknown): Promise<never> {
    try {
      await this.persistEnabled(false);
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        'Push notification scheduler enablement and compensation both failed',
      );
    }
    throw error;
  }

  private async _restartRunning(): Promise<void> {
    const previousJobs = this.jobs;
    for (const job of previousJobs.values()) {
      job.task.stop();
    }
    this.jobs = new Map();
    this.running = false;

    try {
      await this._start();
    } catch (error) {
      this._stop();
      this.jobs = previousJobs;
      for (const job of previousJobs.values()) {
        job.task.start();
      }
      this.running = true;
      throw error;
    }
  }

  private async _start(): Promise<void> {
    if (this.running) return;
    const handlers = requireScheduledPushHandlers();
    const prefs = await getPreferences();
    const tz = getTimezone();

    try {
      // Morning notification — runs daily at the configured hour
      const morningCron = `0 ${prefs.morningHour} * * *`;
      this.registerJob('morning', morningCron, tz, async () => {
        return await handlers.triggerMorningNotification();
      });

      // Triage nudge — runs every 2 hours (9 AM – 7 PM)
      // The trigger itself checks the threshold and deduplication
      this.registerJob('triage-nudge', '0 9,11,13,15,17,19 * * *', tz, async () => {
        return await handlers.triggerTriageNudge();
      });

      // Carry-forward reminder — runs daily at the configured hour
      const carryForwardCron = `0 ${prefs.carryForwardHour} * * *`;
      this.registerJob('carry-forward', carryForwardCron, tz, async () => {
        return await handlers.triggerCarryForwardReminder();
      });

      this.running = true;
      logger.info(
        { morningHour: prefs.morningHour, carryForwardHour: prefs.carryForwardHour, timezone: tz },
        'Push notification scheduler started',
      );
    } catch (error) {
      this._stop();
      throw error;
    }
  }

  private _stop(): void {
    for (const job of this.jobs.values()) {
      job.task.stop();
    }
    this.jobs.clear();
    this.running = false;
    logger.info('Push notification scheduler stopped');
  }

  /** Get status of all scheduled jobs. */
  getStatus(): Array<{
    name: string;
    schedule: string;
    lastRun?: string;
    lastResult?: string;
    lastError?: string;
  }> {
    return Array.from(this.jobs.values()).map(job => ({
      name: job.name,
      schedule: job.schedule,
      lastRun: job.lastRun,
      lastResult: job.lastResult,
      lastError: job.lastError,
    }));
  }

  isRunning(): boolean {
    return this.running;
  }

  private registerJob(
    name: string,
    schedule: string,
    timezone: string,
    handler: () => Promise<boolean>,
  ): void {
    // Destroy any leftover task with the same name (defensive)
    const existing = this.jobs.get(name);
    if (existing) {
      existing.task.stop();
    }

    const task = cron.schedule(schedule, async () => {
      const job = this.jobs.get(name);
      if (!job) return;

      try {
        const sent = await scheduledSummariesEnabled() && await handler();
        job.lastRun = new Date().toISOString();
        job.lastResult = sent ? 'sent' : 'skipped';
        job.lastError = undefined;
      } catch (err) {
        job.lastRun = new Date().toISOString();
        job.lastResult = 'error';
        job.lastError = 'Push notification job failed';
        logger.error(
          { errorName: err instanceof Error ? err.name : 'UnknownError', jobName: name },
          'Push notification job failed',
        );
      }
    }, { timezone });

    this.jobs.set(name, { name, task, schedule });
    task.start();
  }
}

const schedulerRuntime = runtime();
schedulerRuntime.scheduler ??= new PushNotificationScheduler();
export const pushNotificationScheduler = schedulerRuntime.scheduler;

export async function _resetPushNotificationSchedulerForTests(): Promise<void> {
  const state = runtime();
  await state.scheduler?.stop();
  state.handlers = null;
}
