import {
  CopilotLifecycleError,
  type CopilotRunRecord,
  type CopilotRunStore,
} from './copilot-lifecycle-contracts';

export interface CopilotLifecycleClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemCopilotLifecycleClock: CopilotLifecycleClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CopilotLeaseManager {
  private readonly reservations = new Set<string>();
  private reservationLock: Promise<void> = Promise.resolve();
  private readonly idleTimers = new Map<string, unknown>();

  constructor(
    private readonly store: CopilotRunStore,
    private readonly maxConcurrentSessions: number,
    private readonly idleTimeoutMs: number,
    private readonly clock: CopilotLifecycleClock = systemCopilotLifecycleClock,
  ) {}

  async reserve(runId: string): Promise<void> {
    let unlock!: () => void;
    const previousLock = this.reservationLock;
    this.reservationLock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previousLock;
    try {
      if (this.reservations.has(runId)) {
        throw new CopilotLifecycleError('lifecycle_conflict');
      }
      const retainedSessions = (await this.store.list()).filter(
        (record) =>
          record.runId !== runId &&
          record.providerSessionId !== undefined &&
          record.state !== 'cleaned_up',
      ).length;
      if (
        retainedSessions + this.reservations.size >=
        this.maxConcurrentSessions
      ) {
        throw new CopilotLifecycleError('concurrency_saturated');
      }
      this.reservations.add(runId);
    } finally {
      unlock();
    }
  }

  release(runId: string): void {
    this.reservations.delete(runId);
  }

  scheduleIdleExpiration(
    runId: string,
    onExpire: () => void | Promise<void>,
  ): void {
    this.clearIdleExpiration(runId);
    const handle = this.clock.setTimeout(() => {
      this.idleTimers.delete(runId);
      void onExpire();
    }, this.idleTimeoutMs);
    this.idleTimers.set(runId, handle);
  }

  clearIdleExpiration(runId: string): void {
    const handle = this.idleTimers.get(runId);
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.idleTimers.delete(runId);
  }

  async expiredDisconnectedRuns(): Promise<CopilotRunRecord[]> {
    const cutoff = this.clock.now() - this.idleTimeoutMs;
    return (await this.store.list()).filter(
      (record) =>
        record.state === 'idle' &&
        record.connection === 'detached' &&
        record.providerSessionId !== undefined &&
        record.updatedAt <= cutoff,
    );
  }

  async expiredAttachedLeases(): Promise<CopilotRunRecord[]> {
    const timestamp = this.clock.now();
    return (await this.store.list()).filter(
      (record) =>
        (record.connection === 'attached' || record.state === 'resuming') &&
        record.leaseExpiresAt <= timestamp,
    );
  }
}
