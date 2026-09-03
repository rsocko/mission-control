import 'server-only';

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { DurableAiRunRepository } from './repository';
import type {
  ClaimedDurableAiRun,
  DurableAiRun,
  DurableAiRunRouteOutcome,
  ProtectedProviderSession,
} from './types';

export interface DurableAiRunExecutionContext {
  run: ClaimedDurableAiRun;
  signal: AbortSignal;
  routingHeaders: Readonly<Record<string, string>>;
  emit(
    kind: string,
    payload?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<void>;
  setRouteOutcome(outcome: DurableAiRunRouteOutcome): void;
  getProviderSession(): Promise<ProtectedProviderSession | null>;
  setProviderSession(
    provider: string,
    reference: string,
    expiresAt?: Date,
  ): Promise<ProtectedProviderSession>;
  revokeProviderSession(): Promise<boolean>;
}

export interface DurableAiRunCleanupContext {
  run: ClaimedDurableAiRun;
  providerSession: ProtectedProviderSession | null;
  signal: AbortSignal;
}

export interface DurableAiRunExecutor {
  execute(
    context: DurableAiRunExecutionContext,
  ): Promise<DurableAiRunRouteOutcome | void>;
  cancel?(context: DurableAiRunExecutionContext): Promise<void>;
  cleanup?(context: DurableAiRunCleanupContext): Promise<void>;
}

export interface DurableAiRunWorkerOptions {
  ownerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  cleanupTimeoutMs?: number;
  pruneIntervalMs?: number;
  onTerminal?(run: DurableAiRun): void | Promise<void>;
  reportError?(error: unknown, operation: string, runId?: string): void;
  isEnabled?(): boolean;
}

class WorkerStoppingError extends Error {}
class RunTimedOutError extends Error {}
class RunCancelledError extends Error {}
class RunLeaseLostError extends Error {}
class CleanupTimedOutError extends Error {}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Durable AI run was aborted.'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function durableAiRunTraceHeaders(
  run: Pick<
    ClaimedDurableAiRun,
    'id' | 'correlationId' | 'traceparent' | 'tracestate'
  >,
): Record<string, string> {
  return {
    'x-mc-run-id': run.id,
    'x-mc-correlation-id': run.correlationId,
    ...(run.traceparent ? { traceparent: run.traceparent } : {}),
    ...(run.tracestate ? { tracestate: run.tracestate } : {}),
  };
}

export class DurableAiRunWorker {
  readonly ownerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly pruneIntervalMs: number;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private prunePromise: Promise<void> | null = null;
  private wakeWaiter: (() => void) | null = null;
  private active:
    | {
        run: ClaimedDurableAiRun;
        controller: AbortController;
        promise: Promise<void>;
      }
    | null = null;

  constructor(
    private readonly store: DurableAiRunRepository,
    private readonly executors: ReadonlyMap<string, DurableAiRunExecutor>,
    private readonly options: DurableAiRunWorkerOptions = {},
  ) {
    this.ownerId = options.ownerId
      ?? `${hostname()}:${process.pid}:ai:${randomUUID()}`;
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      Number.parseInt(process.env.MC_AI_RUN_WORKER_POLL_MS ?? '', 10) || 500,
    );
    this.leaseMs = positiveInteger(
      options.leaseMs,
      Number.parseInt(process.env.MC_AI_RUN_LEASE_MS ?? '', 10) || 120_000,
    );
    this.cleanupTimeoutMs = positiveInteger(
      options.cleanupTimeoutMs,
      Number.parseInt(process.env.MC_AI_RUN_CLEANUP_TIMEOUT_MS ?? '', 10)
        || 60_000,
    );
    this.pruneIntervalMs = positiveInteger(
      options.pruneIntervalMs,
      Number.parseInt(process.env.MC_AI_RUN_PRUNE_INTERVAL_MS ?? '', 10)
        || 6 * 60 * 60_000,
    );
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    if (this.isEnabled()) this.pruneExpired();
    this.pruneTimer = setInterval(
      () => {
        if (this.isEnabled()) this.pruneExpired();
      },
      this.pruneIntervalMs,
    );
    this.pruneTimer.unref();
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  async runOnce(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    await this.store.expireTimedOutQueuedRuns();
    if (!this.isEnabled()) return false;
    const routes = [...this.executors.keys()];
    await this.store.recoverExpiredRuns(new Date(), routes);
    if (!this.isEnabled()) return false;
    const cleanup = await this.store.claimCleanup(
      this.ownerId,
      routes,
      this.leaseMs,
    );
    if (cleanup) {
      const controller = new AbortController();
      const promise = this.executeCleanup(cleanup, controller);
      this.active = { run: cleanup, controller, promise };
      try {
        await promise;
      } finally {
        if (this.active?.run.id === cleanup.id) this.active = null;
      }
      return true;
    }
    if (!this.isEnabled()) return false;
    const run = await this.store.claimNextRun(this.ownerId, routes, this.leaseMs);
    if (!run) return false;
    const controller = new AbortController();
    const promise = this.executeRun(run, controller);
    this.active = { run, controller, promise };
    try {
      await promise;
    } finally {
      if (this.active?.run.id === run.id) this.active = null;
    }
    return true;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const processed = await this.runOnce();
        if (!processed) await this.delay(this.pollIntervalMs);
      } catch (error) {
        this.reportError(error, 'worker-loop');
        if (!this.stopping) await this.delay(this.pollIntervalMs);
      }
    }
  }

  private async executeRun(
    run: ClaimedDurableAiRun,
    controller: AbortController,
  ): Promise<void> {
    const executor = this.executors.get(run.executionRoute);
    if (!executor) {
      await this.store.failRun(
        run.id,
        this.ownerId,
        new Error(`No executor is registered for ${run.executionRoute}.`),
        { retryable: false, code: 'executor_unavailable' },
      );
      return;
    }

    let routeOutcome: DurableAiRunRouteOutcome = {};
    let cancelPromise: Promise<void> | null = null;
    let heartbeatPromise: Promise<void> | null = null;
    let executionClosed = false;
    const context: DurableAiRunExecutionContext = {
      run,
      signal: controller.signal,
      routingHeaders: durableAiRunTraceHeaders(run),
      emit: async (kind, payload = {}, idempotencyKey) => {
        if (executionClosed) {
          throw new Error(`Durable AI run ${run.id} execution is closed.`);
        }
        await this.store.appendEventForClaim(run.id, this.ownerId, run.attempt, {
          idempotencyKey: idempotencyKey
            ?? `executor:${run.attempt}:${randomUUID()}`,
          kind,
          payload,
          ...routeOutcome,
        });
      },
      setRouteOutcome: (outcome) => {
        if (executionClosed) {
          throw new Error(`Durable AI run ${run.id} execution is closed.`);
        }
        routeOutcome = { ...routeOutcome, ...outcome };
      },
      getProviderSession: () => this.store.getProviderSessionForClaim(
        run.id,
        this.ownerId,
        run.attempt,
      ),
      setProviderSession: async (provider, reference, expiresAt) => {
        if (executionClosed) {
          throw new Error(`Durable AI run ${run.id} execution is closed.`);
        }
        return this.store.setProviderSessionForClaim(
          run.id,
          this.ownerId,
          run.attempt,
          provider,
          reference,
          expiresAt ? { expiresAt } : {},
        );
      },
      revokeProviderSession: () => this.store.revokeProviderSessionForClaim(
        run.id,
        this.ownerId,
        run.attempt,
      ),
    };
    const propagateCancellation = () => {
      cancelPromise ??= executor.cancel?.(context) ?? Promise.resolve();
      return cancelPromise;
    };
    const awaitProviderCancellation = async () => {
      const graceMs = Math.max(25, Math.min(5_000, Math.floor(this.leaseMs / 3)));
      const completed = await Promise.race([
        propagateCancellation().then(() => true),
        this.delay(graceMs).then(() => false),
      ]);
      if (!completed) {
        this.reportError(
          new Error(`Provider cancellation for durable AI run ${run.id} timed out.`),
          'provider-cancel-timeout',
          run.id,
        );
      }
    };
    const timeoutMs = Math.max(0, Date.parse(run.timeoutAt) - Date.now());
    const timeout = setTimeout(() => {
      controller.abort(new RunTimedOutError('Durable AI run timed out.'));
    }, timeoutMs);
    timeout.unref();

    const heartbeat = setInterval(() => {
      if (heartbeatPromise || controller.signal.aborted) return;
      heartbeatPromise = (async () => {
        try {
          if (await this.store.isCancellationRequested(run.id, this.ownerId)) {
            controller.abort(new RunCancelledError('Durable AI run cancelled.'));
            return;
          }
          if (!(await this.store.renewLease(run.id, this.ownerId, this.leaseMs))) {
            controller.abort(new RunLeaseLostError('Durable AI run lease was lost.'));
          }
        } catch (error) {
          this.reportError(error, 'heartbeat', run.id);
          controller.abort(error instanceof Error ? error : new Error(String(error)));
        } finally {
          heartbeatPromise = null;
        }
      })();
    }, Math.max(25, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();

    try {
      const result = await raceWithAbort(executor.execute(context), controller.signal);
      if (result) routeOutcome = { ...routeOutcome, ...result };
      clearInterval(heartbeat);
      await heartbeatPromise;
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const completed = await this.store.completeRun(
        run.id,
        this.ownerId,
        routeOutcome,
      );
      await this.notifyTerminal(completed);
    } catch (error) {
      executionClosed = true;
      const reason = controller.signal.aborted
        ? controller.signal.reason
        : error;
      if (reason instanceof RunCancelledError) {
        try {
          await awaitProviderCancellation();
        } catch (cancelError) {
          this.reportError(cancelError, 'provider-cancel', run.id);
        }
        const cancelled = await this.store.cancelRun(run.id, this.ownerId);
        await this.notifyTerminal(cancelled);
      } else if (reason instanceof RunTimedOutError) {
        try {
          await awaitProviderCancellation();
        } catch (cancelError) {
          this.reportError(cancelError, 'provider-cancel-timeout', run.id);
        }
        const timedOut = await this.store.timeOutRun(run.id, this.ownerId);
        await this.notifyTerminal(timedOut);
      } else if (
        reason instanceof RunLeaseLostError
        || reason instanceof WorkerStoppingError
        || (
          reason instanceof Error
          && reason.message.endsWith('ownership was lost.')
        )
      ) {
        this.reportError(reason, 'lease-release', run.id);
      } else {
        const failed = await this.store.failRun(run.id, this.ownerId, reason, {
          outcome: routeOutcome,
        });
        if (failed.status === 'failed') await this.notifyTerminal(failed);
      }
    } finally {
      executionClosed = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }

  private async executeCleanup(
    run: ClaimedDurableAiRun,
    controller: AbortController,
  ): Promise<void> {
    const executor = this.executors.get(run.executionRoute);
    let heartbeatPromise: Promise<void> | null = null;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPromise) return;
      heartbeatPromise = (async () => {
        try {
          if (
            !(await this.store.renewCleanupLease(run.id, this.ownerId, this.leaseMs))
          ) {
            leaseLost = true;
            controller.abort(
              new RunLeaseLostError(`Durable AI run ${run.id} cleanup lease was lost.`),
            );
            this.reportError(
              new Error(`Durable AI run ${run.id} cleanup lease was lost.`),
              'cleanup-heartbeat',
              run.id,
            );
          }
        } catch (error) {
          this.reportError(error, 'cleanup-heartbeat', run.id);
          controller.abort(error instanceof Error ? error : new Error(String(error)));
        } finally {
          heartbeatPromise = null;
        }
      })();
    }, Math.max(25, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    const timeout = setTimeout(() => {
      controller.abort(
        new CleanupTimedOutError(`Durable AI run ${run.id} cleanup timed out.`),
      );
    }, this.cleanupTimeoutMs);
    timeout.unref();
    try {
      if (!executor?.cleanup) {
        throw new Error(
          `No provider cleanup handler is registered for ${run.executionRoute}.`,
        );
      }
      const providerSession = await this.store.getProviderSession(run.id);
      await raceWithAbort(
        executor.cleanup({
          run,
          providerSession,
          signal: controller.signal,
        }),
        controller.signal,
      );
      clearInterval(heartbeat);
      await heartbeatPromise;
      if (leaseLost) return;
      await this.store.finishCleanup(run.id, this.ownerId);
    } catch (error) {
      const reason = controller.signal.aborted
        ? controller.signal.reason
        : error;
      if (reason instanceof WorkerStoppingError || leaseLost) {
        this.reportError(reason, 'provider-cleanup-interrupted', run.id);
        return;
      }
      if (!leaseLost) {
        try {
          await this.store.finishCleanup(run.id, this.ownerId, reason);
        } catch (finishError) {
          this.reportError(finishError, 'provider-cleanup-finish', run.id);
        }
      }
      this.reportError(reason, 'provider-cleanup', run.id);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }

  async stop(graceMs = 30_000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.wake();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    await this.prunePromise;
    const active = this.active;
    if (active) {
      const completed = await Promise.race([
        active.promise.then(() => true),
        this.delay(positiveInteger(graceMs, 30_000)).then(() => false),
      ]);
      if (!completed) {
        active.controller.abort(
          new WorkerStoppingError('Durable AI worker shutdown grace expired.'),
        );
      }
    }
    if (this.loopPromise) await this.loopPromise;
  }

  getActiveRun(): DurableAiRun | null {
    return this.active?.run ?? null;
  }

  private async notifyTerminal(run: DurableAiRun): Promise<void> {
    if (!run.notifyOnCompletion || !this.options.onTerminal) return;
    try {
      await this.options.onTerminal(run);
    } catch (error) {
      this.reportError(error, 'completion-notification', run.id);
    }
  }

  private reportError(error: unknown, operation: string, runId?: string): void {
    this.options.reportError?.(error, operation, runId);
  }

  private isEnabled(): boolean {
    return this.options.isEnabled?.() ?? true;
  }

  private pruneExpired(): void {
    if (this.prunePromise) return;
    this.prunePromise = this.store.pruneExpired()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.reportError(error, 'retention');
      })
      .finally(() => {
        this.prunePromise = null;
      });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWaiter = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeWaiter = () => {
        clearTimeout(timer);
        this.wakeWaiter = null;
        resolve();
      };
    });
  }

  wake(): void {
    this.wakeWaiter?.();
  }
}
