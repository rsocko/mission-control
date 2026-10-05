import 'server-only';

import { randomUUID } from 'node:crypto';
import { syncLogger } from '@/lib/logger';
import { getExternalAgentControlPersistence } from './persistence';
import { executeExternalAgentWorkerAction } from './service';
import type { TransportResolver } from './transports';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const ACTION_LEASE_MS = 2 * 60_000;
const MAX_RETRY_DELAY_MS = 60_000;

function configuredPollInterval(): number {
  const value = Number(process.env.MC_EXTERNAL_AGENT_ACTION_POLL_INTERVAL_MS);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_POLL_INTERVAL_MS;
}

export class ExternalAgentDispatchWorker {
  private readonly owner = `external-agent:${process.pid}:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cycle: Promise<void> | null = null;
  private running = false;

  constructor(
    private readonly options: {
      fetcher?: typeof fetch;
      transportResolver?: TransportResolver;
    } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.cycle;
  }

  wake(): void {
    if (!this.running || this.cycle) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  async drainOne(): Promise<boolean> {
    const persistence = await getExternalAgentControlPersistence();
    const nowDate = new Date();
    const action = await persistence.actions.claimNext({
      owner: this.owner,
      now: nowDate.toISOString(),
      leaseExpiresAt: new Date(nowDate.getTime() + ACTION_LEASE_MS).toISOString(),
    });
    if (!action) return false;
    try {
      await executeExternalAgentWorkerAction(
        action.dispatchId,
        action.action,
        this.options,
      );
      await persistence.actions.complete({
        id: action.id,
        owner: this.owner,
        now: new Date().toISOString(),
      });
    } catch (error) {
      const failedAt = new Date();
      const delay = Math.min(
        2 ** Math.min(action.attemptCount, 10) * 1_000,
        MAX_RETRY_DELAY_MS,
      );
      await persistence.actions.fail({
        id: action.id,
        owner: this.owner,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4_096),
        availableAt: new Date(failedAt.getTime() + delay).toISOString(),
        now: failedAt.toISOString(),
      });
      syncLogger.warn(
        { err: error, dispatchId: action.dispatchId, action: action.action },
        'External-agent worker action failed and was requeued',
      );
    }
    return true;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.cycle = this.runCycle().finally(() => {
        this.cycle = null;
        if (this.running) this.schedule(configuredPollInterval());
      });
    }, delay);
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    while (this.running && await this.drainOne()) {
      // Drain all durable intents before returning to the idle poll cadence.
    }
  }
}
