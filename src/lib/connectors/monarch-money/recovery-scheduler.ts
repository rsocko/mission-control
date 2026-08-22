import 'server-only';

import logger from '@/lib/logger';
import { probeAllFinanceConnections } from './connection-recovery';

const MONITOR_INTERVAL_MS = 5 * 60 * 1_000;

export class FinanceConnectionRecoveryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  async start(): Promise<void> {
    if (this.timer) return;
    await this.run();
    this.timer = setInterval(() => void this.run(), MONITOR_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await probeAllFinanceConnections();
    } catch (error) {
      logger.error({ err: error }, 'Finance connection recovery monitor failed');
    } finally {
      this.running = false;
    }
  }
}

export const financeConnectionRecoveryScheduler = new FinanceConnectionRecoveryScheduler();
