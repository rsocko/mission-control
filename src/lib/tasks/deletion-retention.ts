import 'server-only';

import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import logger from '@/lib/logger';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { withDatabaseOperation } from '@/lib/telemetry/database-operation-context';

export const TASK_DELETION_RETENTION_DAYS = 30;
const TASK_DELETION_RETENTION_SCHEDULE = '30 3 * * *';

export async function purgeExpiredDeletedTasks(now = new Date()): Promise<number> {
  const cutoff = new Date(
    now.getTime() - TASK_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const persistence = await getTaskCorePersistence();
  const purgedIds = await persistence.removals.purgeDeletedBefore(cutoff);
  if (purgedIds.length > 0) {
    logger.info({ purged: purgedIds.length }, 'Purged expired soft-deleted tasks');
  }
  return purgedIds.length;
}

export class TaskDeletionRetentionScheduler {
  private task: ScheduledTask | null = null;
  private activeRun: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly purge: typeof purgeExpiredDeletedTasks = purgeExpiredDeletedTasks,
  ) {}

  private runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.activeRun) return this.activeRun;
    const run = withDatabaseOperation(
      'task-deletion-retention',
      async () => {
        await this.purge();
      },
    );
    const active = run.finally(() => {
      if (this.activeRun === active) this.activeRun = null;
    });
    this.activeRun = active;
    return active;
  }

  async start(): Promise<void> {
    if (this.task) return;
    this.stopping = false;
    this.task = cron.schedule(TASK_DELETION_RETENTION_SCHEDULE, async () => {
      try {
        await this.runOnce();
      } catch (error) {
        logger.error({ err: error }, 'Task deletion retention run failed');
      }
    });
    this.task.start();
    try {
      await this.runOnce();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.task?.stop();
    this.task = null;
    await this.activeRun;
  }
}

export const taskDeletionRetentionScheduler = new TaskDeletionRetentionScheduler();
