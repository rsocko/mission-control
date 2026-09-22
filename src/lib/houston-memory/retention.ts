import { aiLogger } from '@/lib/logger';
import { deleteExpiredHoustonMemories } from './service';

const RETENTION_INTERVAL_MS = 15 * 60_000;

class HoustonMemoryRetentionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.run();
    this.timer = setInterval(() => void this.run(), RETENTION_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private run(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = deleteExpiredHoustonMemories()
      .then((deleted) => {
        if (deleted > 0) {
          aiLogger.info({
            event: 'houston_memory_retention_cleanup',
            deleted,
          }, 'Expired Houston memories deleted');
        }
      })
      .catch((error: unknown) => {
        aiLogger.warn({
          event: 'houston_memory_retention_cleanup_failed',
          err: error,
        }, 'Houston memory retention cleanup failed');
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}

export const houstonMemoryRetentionScheduler = new HoustonMemoryRetentionScheduler();
