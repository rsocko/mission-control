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
import { triggerMorningNotification, triggerTriageNudge, triggerCarryForwardReminder } from './triggers';
import { getPreferences } from '@/lib/notifications/quiet-hours';
import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications';
import { getTimezone } from '@/lib/mode';
import logger from '@/lib/logger';

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
    await (this.lifecycleLock = this.lifecycleLock.then(() => this._start()));
  }

  /** Stop all cron jobs. */
  async stop(): Promise<void> {
    await (this.lifecycleLock = this.lifecycleLock.then(() => this._stop()));
  }

  /** Restart with fresh preferences (call after settings change). */
  async restart(): Promise<void> {
    await (this.lifecycleLock = this.lifecycleLock.then(async () => {
      this._stop();
      await this._start();
    }));
  }

  private async _start(): Promise<void> {
    if (this.running) return;

    const prefs = await getPreferences();
    const tz = getTimezone();
    wakeNotificationDeliveryDispatcher();

    // Morning notification — runs daily at the configured hour
    const morningCron = `0 ${prefs.morningHour} * * *`;
    this.registerJob('morning', morningCron, tz, async () => {
      return await triggerMorningNotification();
    });

    // Triage nudge — runs every 2 hours (9 AM – 7 PM)
    // The trigger itself checks the threshold and deduplication
    this.registerJob('triage-nudge', '0 9,11,13,15,17,19 * * *', tz, async () => {
      return await triggerTriageNudge();
    });

    // Carry-forward reminder — runs daily at the configured hour
    const carryForwardCron = `0 ${prefs.carryForwardHour} * * *`;
    this.registerJob('carry-forward', carryForwardCron, tz, async () => {
      return await triggerCarryForwardReminder();
    });

    this.running = true;
    logger.info(
      { morningHour: prefs.morningHour, carryForwardHour: prefs.carryForwardHour, timezone: tz },
      'Push notification scheduler started',
    );
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
        const sent = await handler();
        job.lastRun = new Date().toISOString();
        job.lastResult = sent ? 'sent' : 'skipped';
        job.lastError = undefined;
      } catch (err) {
        job.lastRun = new Date().toISOString();
        job.lastResult = 'error';
        job.lastError = err instanceof Error ? err.message : String(err);
        logger.error({ err, jobName: name }, 'Push notification job failed');
      }
    }, { timezone });

    this.jobs.set(name, { name, task, schedule });
    task.start();
  }
}

// Singleton
export const pushNotificationScheduler = new PushNotificationScheduler();
