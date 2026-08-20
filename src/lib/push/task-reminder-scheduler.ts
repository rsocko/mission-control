import 'server-only';

import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { runDueTaskReminders, type TaskReminderRunResult } from './task-reminders';
import logger from '@/lib/logger';

export class TaskReminderScheduler {
  private task: ScheduledTask | null = null;
  private activeRun: Promise<void> | null = null;
  private lastRun: string | null = null;
  private lastResult: TaskReminderRunResult | null = null;
  private lastError: string | null = null;

  private runOnce(): Promise<void> {
    if (this.activeRun) return this.activeRun;
    const run = (async () => {
      try {
        this.lastResult = await runDueTaskReminders();
        this.lastRun = new Date().toISOString();
        this.lastError = null;
      } catch (error) {
        this.lastRun = new Date().toISOString();
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    })();
    const active = run.finally(() => {
      if (this.activeRun === active) this.activeRun = null;
    });
    this.activeRun = active;
    return active;
  }

  async start(): Promise<void> {
    if (this.task) return;
    this.task = cron.schedule('* * * * *', async () => {
      try {
        await this.runOnce();
      } catch (error) {
        logger.error({ err: error }, 'Task reminder scheduler run failed');
      }
    });
    this.task.start();
    try {
      await this.runOnce();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  isRunning(): boolean {
    return this.task !== null;
  }

  getStatus() {
    return {
      running: this.isRunning(),
      schedule: '* * * * *',
      lastRun: this.lastRun,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }
}

export const taskReminderScheduler = new TaskReminderScheduler();
