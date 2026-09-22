import 'server-only';

import logger from '@/lib/logger';
import { withDatabaseOperation } from '@/lib/telemetry/database-operation-context';

const MONITOR_INTERVAL_MS = 5 * 60 * 1_000;

export class FinanceConnectionRecoveryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;
  private stopping = false;

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopping = false;
    await this.run();
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => void this.run(), MONITOR_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeRun;
  }

  private run(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.activeRun) return this.activeRun;
    const run = (async () => {
      try {
        const { probeAllFinanceConnections } = await import('./connection-recovery');
        await withDatabaseOperation(
          'worker-finance-recovery',
          () => probeAllFinanceConnections(),
        );
      } catch (error) {
        logger.error({ err: error }, 'Finance connection recovery monitor failed');
      }
    })();
    const active = run.finally(() => {
      if (this.activeRun === active) this.activeRun = null;
    });
    this.activeRun = active;
    return active;
  }
}

export const financeConnectionRecoveryScheduler = new FinanceConnectionRecoveryScheduler();
