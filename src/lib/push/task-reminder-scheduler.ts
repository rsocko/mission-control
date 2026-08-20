import 'server-only';

import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { runDueTaskReminders, type TaskReminderRunResult } from './task-reminders';
import logger from '@/lib/logger';

export class TaskReminderScheduler {
  private task: ScheduledTask | null = null;
  private lastRun: string | null = null;
  private lastResult: TaskReminderRunResult | null = null;
  private lastError: string | null = null;

  async start(): Promise<void> {
    if (this.task) return;
    this.task = cron.schedule('* * * * *', async () => {
      try {
        this.lastResult = await runDueTaskReminders();
        this.lastRun = new Date().toISOString();
        this.lastError = null;
      } catch (error) {
        this.lastRun = new Date().toISOString();
        this.lastError = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, 'Task reminder scheduler run failed');
      }
    });
    this.task.start();
    try {
      this.lastResult = await runDueTaskReminders();
      this.lastRun = new Date().toISOString();
      this.lastError = null;
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
