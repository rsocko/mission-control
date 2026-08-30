import { aiLogger } from '@/lib/logger';
import { deleteExpiredHoustonMemories } from './service';

const RETENTION_INTERVAL_MS = 15 * 60_000;

class HoustonMemoryRetentionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), RETENTION_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private run(): Promise<void> {
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
