/**
 * The durable semantic index worker.
 *
 * One loop, three duties, all bounded:
 *
 * - drain the intent queue (bounded batch, bounded concurrency, leases
 *   heartbeated for as long as the work runs);
 * - execute one slice of a claimed run (backfill/reconcile/cleanup); and
 * - periodic maintenance: recover leases abandoned by a crashed worker, and
 *   schedule the next backfill/reconcile/cleanup.
 *
 * Operational rules this worker holds itself to:
 *
 * - **It never blocks its host.** `start()` returns immediately; every cycle is
 *   scheduled on a timer and every unit of work has a wall-clock budget.
 * - **It is safe when the feature is off.** With semantic search disabled or no
 *   provider configured, the worker parks: no database reads, no provider
 *   calls, no identity creation.
 * - **It never logs content.** Titles, bodies, keywords, query text, embeddings,
 *   and provider payloads never reach a log line. Ids, counts, statuses, and
 *   durations do.
 * - **A stale worker yields.** Every mutation is guarded by the lease owner, so
 *   a worker whose lease was recovered elsewhere records nothing.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { semanticIndexLogger } from '@/lib/logger';
import type {
  SemanticIndexIdentity,
  SemanticIndexRepository,
  SemanticIntent,
  SemanticRun,
  SemanticRunKind,
} from './contracts';
import { SemanticIndexService, type SemanticIntentOutcome } from './service';
import {
  runIdempotencyKey,
  runSlice,
  type SemanticRunDependencies,
  type SemanticRunSliceResult,
} from './runs';
import type { SemanticSourceEntityType, SemanticSourcePort } from './source/contracts';
import type { SemanticEmbeddingProvider } from './embedding-provider';
import type { SemanticWorkerConfig } from './worker-config';

export interface SemanticIndexWorkerOptions {
  repository: SemanticIndexRepository;
  source: SemanticSourcePort;
  embeddings: SemanticEmbeddingProvider;
  service: SemanticIndexService;
  config: SemanticWorkerConfig;
  /** Explicit feature gate supplied by the composition root. */
  isEnabled: () => boolean;
  /** Re-reads corpus gates each cycle so settings changes take effect without a restart. */
  enabledEntityTypes?: () => readonly SemanticSourceEntityType[];
  owner?: string;
  now?: () => string;
  /** Injected for tests so a cycle can be driven without real timers. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Explicit packaged-test hook invoked only after a durable run checkpoint. */
  onRunCheckpointed?: (run: SemanticRun, result: SemanticRunSliceResult) => void;
}

export interface SemanticWorkerCycleReport {
  status: 'disabled' | 'unavailable' | 'idle' | 'worked';
  reason?: string;
  intentsClaimed: number;
  intentsSucceeded: number;
  intentsRetried: number;
  intentsFailed: number;
  intentsDenied: number;
  runsExecuted: number;
  leasesRecovered: number;
  identityId?: string;
}

const EMPTY_REPORT: SemanticWorkerCycleReport = {
  status: 'idle',
  intentsClaimed: 0,
  intentsSucceeded: 0,
  intentsRetried: 0,
  intentsFailed: 0,
  intentsDenied: 0,
  runsExecuted: 0,
  leasesRecovered: 0,
};

function defaultOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * Timers are unref'd: the index worker must never be the reason its host
 * process stays alive.
 */
function defaultSetTimer(callback: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return timer;
}

/**
 * Populate before reconciling, reconcile before collecting garbage. A newly
 * provisioned identity must not spend its first cycles cleaning an empty index.
 */
const RUN_PRIORITY: readonly SemanticRunKind[] = ['backfill', 'reconcile', 'cleanup'];

/** Buckets a timestamp so scheduled runs get one stable idempotency key each. */
function windowKey(nowMs: number, intervalMs: number): string {
  return String(Math.floor(nowMs / Math.max(1, intervalMs)));
}

export class SemanticIndexWorker {
  private readonly repository: SemanticIndexRepository;
  private readonly source: SemanticSourcePort;
  private readonly embeddings: SemanticEmbeddingProvider;
  private readonly service: SemanticIndexService;
  private readonly config: SemanticWorkerConfig;
  private readonly isEnabled: () => boolean;
  private readonly enabledEntityTypes: () => readonly SemanticSourceEntityType[];
  private readonly now: () => string;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly onRunCheckpointed?: (
    run: SemanticRun,
    result: SemanticRunSliceResult,
  ) => void;

  readonly owner: string;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<SemanticWorkerCycleReport> | null = null;
  private shutdown: AbortController | null = null;
  private lastMaintenanceMs = 0;
  private lastReport: SemanticWorkerCycleReport = EMPTY_REPORT;
  private wakeAfterCycle = false;

  constructor(options: SemanticIndexWorkerOptions) {
    this.repository = options.repository;
    this.source = options.source;
    this.embeddings = options.embeddings;
    this.service = options.service;
    this.config = options.config;
    this.isEnabled = options.isEnabled;
    this.enabledEntityTypes = options.enabledEntityTypes ?? (() => this.config.entityTypes);
    this.now = options.now ?? (() => new Date().toISOString());
    this.owner = options.owner ?? defaultOwner();
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.onRunCheckpointed = options.onRunCheckpointed;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastCycle(): SemanticWorkerCycleReport {
    return this.lastReport;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.shutdown = new AbortController();
    semanticIndexLogger.info({
      event: 'semantic_worker_started',
      owner: this.owner,
      batchSize: this.config.batchSize,
      concurrency: this.config.concurrency,
      pollIntervalMs: this.config.pollIntervalMs,
    }, 'Semantic index worker started');
    this.schedule(0);
  }

  /**
   * Stops the loop. In-flight work is asked to abort and then given the
   * configured grace period to record its outcome; after that the process is
   * free to exit and lease recovery will requeue whatever was left running.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.shutdown?.abort();
    const inFlight = this.cycle;
    if (inFlight) {
      await Promise.race([
        inFlight.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = this.setTimer(resolve, this.config.shutdownGraceMs);
          void inFlight.catch(() => undefined).finally(() => this.clearTimer(timer));
        }),
      ]);
    }
    this.shutdown = null;
    semanticIndexLogger.info({
      event: 'semantic_worker_stopped',
      owner: this.owner,
    }, 'Semantic index worker stopped');
  }

  wake(): void {
    if (!this.running) return;
    if (this.cycle) {
      this.wakeAfterCycle = true;
      return;
    }
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.cycle) return;
    const cycle = this.runCycle();
    this.cycle = cycle;
    let report: SemanticWorkerCycleReport = EMPTY_REPORT;
    try {
      report = await cycle;
    } catch (error) {
      semanticIndexLogger.error({
        event: 'semantic_worker_cycle_failed',
        owner: this.owner,
        err: error,
      }, 'Semantic index worker cycle failed');
    } finally {
      this.cycle = null;
    }
    this.lastReport = report;
    const busy = report.status === 'worked'
      && report.intentsClaimed >= this.config.batchSize;
    const delayMs = this.wakeAfterCycle
      ? 0
      : busy
        ? this.config.busyIntervalMs
        : this.config.pollIntervalMs;
    this.wakeAfterCycle = false;
    this.schedule(delayMs);
  }

  /**
   * Executes one cycle. Public so tests (and an operator endpoint, later) can
   * drive a single deterministic pass without the timer loop.
   */
  async runCycle(signal?: AbortSignal): Promise<SemanticWorkerCycleReport> {
    const abortSignal = signal ?? this.shutdown?.signal ?? new AbortController().signal;
    if (!this.isEnabled()) {
      return { ...EMPTY_REPORT, status: 'disabled', reason: 'semantic-search-disabled' };
    }

    const report: SemanticWorkerCycleReport = { ...EMPTY_REPORT };
    const entityTypes = this.enabledEntityTypes();
    const maintenanceDue = Date.now() - this.lastMaintenanceMs >= this.config.maintenanceIntervalMs;

    if (maintenanceDue) {
      const recovered = await this.recoverLeases();
      report.leasesRecovered = recovered;
      if (!this.isEnabled()) {
        return { ...report, status: 'disabled', reason: 'semantic-search-disabled' };
      }
    }

    const identity = await this.resolveIdentity(maintenanceDue, abortSignal);
    if (!this.isEnabled()) {
      return { ...report, status: 'disabled', reason: 'semantic-search-disabled' };
    }
    if (!identity.identity) {
      this.lastMaintenanceMs = maintenanceDue ? Date.now() : this.lastMaintenanceMs;
      return { ...report, status: 'unavailable', reason: identity.reason };
    }
    report.identityId = identity.identity.id;

    if (maintenanceDue) {
      await this.scheduleRuns(identity.identity);
      if (!this.isEnabled()) {
        return { ...report, status: 'disabled', reason: 'semantic-search-disabled' };
      }
      // Promotion is re-evaluated on every maintenance tick, not only when a
      // backfill completes: the backfill finishes as soon as it has *enqueued*
      // every entity, so the activation gate almost always fails on that first
      // evaluation and would otherwise never be retried.
      await this.promoteIdentity(identity.identity);
      this.lastMaintenanceMs = Date.now();
    }

    if (!this.isEnabled()) {
      return { ...report, status: 'disabled', reason: 'semantic-search-disabled' };
    }
    const intentReport = await this.drainIntents(identity.identity, entityTypes, abortSignal);
    Object.assign(report, intentReport);

    if (!abortSignal.aborted && this.isEnabled()) {
      report.runsExecuted = await this.executeRun(identity.identity, entityTypes, abortSignal) ? 1 : 0;
    }

    const worked = report.intentsClaimed > 0 || report.runsExecuted > 0;
    return { ...report, status: worked ? 'worked' : 'idle' };
  }

  private async recoverLeases(): Promise<number> {
    const now = this.now();
    const [intents, runs] = await Promise.all([
      this.repository.recoverExpiredIntentLeases(now),
      this.repository.recoverExpiredRunLeases(now),
    ]);
    const recovered = intents.requeued + intents.expired + runs.requeued + runs.expired;
    if (recovered > 0) {
      semanticIndexLogger.info({
        event: 'semantic_leases_recovered',
        owner: this.owner,
        intentsRequeued: intents.requeued,
        intentsExpired: intents.expired,
        runsRequeued: runs.requeued,
        runsExpired: runs.expired,
      }, 'Recovered expired semantic index leases');
    }
    return recovered;
  }

  private async resolveIdentity(
    allowCreate: boolean,
    signal: AbortSignal,
  ): Promise<{ identity: SemanticIndexIdentity | null; reason?: string }> {
    const resolved = await this.service.ensureIdentity({ create: allowCreate, signal });
    if (resolved.status === 'ready') return { identity: resolved.identity };
    return { identity: null, reason: resolved.reason };
  }

  // ─── Intent queue ───────────────────────────────────────────────────

  private async drainIntents(
    identity: SemanticIndexIdentity,
    entityTypes: readonly SemanticSourceEntityType[],
    signal: AbortSignal,
  ): Promise<Partial<SemanticWorkerCycleReport>> {
    if (signal.aborted) return {};
    const claimed = await this.repository.claimIntents({
      indexId: identity.id,
      owner: this.owner,
      entityTypes: [...entityTypes],
      limit: this.config.batchSize,
      leaseMs: this.config.intentLeaseMs,
      now: this.now(),
    });
    if (claimed.length === 0) return {};

    const tally = {
      intentsClaimed: claimed.length,
      intentsSucceeded: 0,
      intentsRetried: 0,
      intentsFailed: 0,
      intentsDenied: 0,
    };

    const queue = [...claimed];
    const workers = Array.from(
      { length: Math.min(this.config.concurrency, queue.length) },
      async () => {
        for (;;) {
          const intent = queue.shift();
          if (!intent) return;
          const outcome = await this.processOne(intent, signal);
          switch (outcome.status) {
            case 'succeeded': tally.intentsSucceeded += 1; break;
            case 'retry': tally.intentsRetried += 1; break;
            case 'failed': tally.intentsFailed += 1; break;
            case 'denied': tally.intentsDenied += 1; break;
            default: break;
          }
          // A shutdown abort stops handing out new work; already-claimed
          // intents were released for immediate reclaim by `processIntent`.
          if (signal.aborted) return;
        }
      },
    );
    await Promise.all(workers);
    return tally;
  }

  /**
   * Runs one intent under a heartbeat and a hard duration budget.
   *
   * The budget's abort is combined with the shutdown signal, so an intent can
   * never outlive either. The heartbeat renews the lease at a third of its
   * duration and stops the moment the work settles.
   */
  private async processOne(
    intent: SemanticIntent,
    signal: AbortSignal,
  ): Promise<SemanticIntentOutcome> {
    const budget = new AbortController();
    const lease = new AbortController();
    const budgetTimer = this.setTimer(() => budget.abort(), this.config.intentBudgetMs);
    const combined = AbortSignal.any([signal, budget.signal, lease.signal]);
    const heartbeat = this.startHeartbeat(
      () => this.repository.renewIntentLease({
        id: intent.id,
        owner: this.owner,
        attempt: intent.attempt,
        leaseMs: this.config.intentLeaseMs,
        now: this.now(),
      }),
      combined,
      () => lease.abort(),
    );

    try {
      const outcome = await this.service.processIntent(intent, {
        owner: this.owner,
        signal: combined,
      });
      semanticIndexLogger.debug({
        event: 'semantic_intent_processed',
        owner: this.owner,
        intentId: intent.id,
        indexId: intent.indexId,
        entityType: intent.entityType,
        kind: intent.kind,
        attempt: intent.attempt,
        status: outcome.status,
        outcome: outcome.outcome,
      }, 'Semantic intent processed');
      return outcome;
    } finally {
      heartbeat.stop();
      this.clearTimer(budgetTimer);
    }
  }

  private startHeartbeat(
    renew: () => Promise<boolean>,
    signal: AbortSignal,
    onLeaseLost: () => void,
  ): { stop: () => void } {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const beat = () => {
      if (stopped || signal.aborted) return;
      void renew()
        .catch((error) => {
          semanticIndexLogger.warn({
            event: 'semantic_lease_renew_failed',
            owner: this.owner,
            err: error,
          }, 'Semantic index lease renewal failed');
          return false;
        })
        .then((renewed) => {
          // A lost lease means another worker owns this row now; stop
          // heartbeating and abort the stale work immediately.
          if (stopped) return;
          if (renewed === false) {
            stopped = true;
            onLeaseLost();
            return;
          }
          schedule();
        });
    };

    const schedule = () => {
      if (stopped || signal.aborted) return;
      timer = this.setTimer(beat, this.config.heartbeatIntervalMs);
    };

    schedule();
    return {
      stop: () => {
        stopped = true;
        if (timer) this.clearTimer(timer);
        timer = null;
      },
    };
  }

  // ─── Runs ───────────────────────────────────────────────────────────

  /**
   * Ensures the periodic runs exist. `createRun` is idempotent on its key, so
   * re-scheduling within the same window is a no-op rather than a duplicate.
   */
  private async scheduleRuns(identity: SemanticIndexIdentity): Promise<void> {
    const now = this.now();
    const nowMs = new Date(now).getTime();
    const kinds: Array<{ kind: SemanticRunKind; window: string }> = [
      // Backfill is scheduled once per identity: it exists to populate a new
      // vector space, and reconciliation covers steady-state drift afterwards.
      { kind: 'backfill', window: 'initial' },
      { kind: 'reconcile', window: windowKey(nowMs, this.config.maintenanceIntervalMs * 4) },
      { kind: 'cleanup', window: windowKey(nowMs, this.config.maintenanceIntervalMs * 4) },
    ];

    for (const entry of kinds) {
      try {
        await this.repository.createRun({
          id: randomUUID(),
          indexId: identity.id,
          kind: entry.kind,
          idempotencyKey: runIdempotencyKey(identity.id, entry.kind, entry.window),
          now,
        });
      } catch (error) {
        semanticIndexLogger.warn({
          event: 'semantic_run_schedule_failed',
          owner: this.owner,
          indexId: identity.id,
          kind: entry.kind,
          err: error,
        }, 'Failed to schedule semantic index run');
      }
    }
  }

  /**
   * Claims and executes at most one run slice. Returns true when it ran one.
   *
   * Kinds are tried in priority order rather than by arrival time: populating a
   * new vector space beats reconciling it, and reconciling it beats collecting
   * its garbage. Without this, a freshly provisioned identity could spend
   * several cycles running cleanup over an empty index.
   */
  private async executeRun(
    identity: SemanticIndexIdentity,
    entityTypes: readonly SemanticSourceEntityType[],
    signal: AbortSignal,
  ): Promise<boolean> {
    let run: SemanticRun | null = null;
    for (const kind of RUN_PRIORITY) {
      run = await this.repository.claimRun({
        owner: this.owner,
        leaseMs: this.config.runLeaseMs,
        now: this.now(),
        indexId: identity.id,
        kinds: [kind],
      });
      if (run) break;
    }
    if (!run) return false;
    const claimed = run;
    const lease = new AbortController();
    const combined = AbortSignal.any([signal, lease.signal]);

    const heartbeat = this.startHeartbeat(
      () => this.repository.renewRunLease({
        id: claimed.id,
        owner: this.owner,
        attempt: claimed.attempt,
        leaseMs: this.config.runLeaseMs,
        now: this.now(),
      }),
      combined,
      () => lease.abort(),
    );

    const deps: SemanticRunDependencies = {
      repository: this.repository,
      source: this.source,
      service: this.service,
      config: { ...this.config, entityTypes },
      now: this.now,
    };

    let result: SemanticRunSliceResult;
    try {
      result = await runSlice({
        run: claimed,
        identity,
        owner: this.owner,
        signal: combined,
        deadlineMs: Date.now() + this.config.runSliceBudgetMs,
      }, deps);
    } catch (error) {
      heartbeat.stop();
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.failRun({
        id: claimed.id,
        owner: this.owner,
        attempt: claimed.attempt,
        error: message.slice(0, 500),
        now: this.now(),
      });
      semanticIndexLogger.error({
        event: 'semantic_run_failed',
        owner: this.owner,
        runId: claimed.id,
        kind: claimed.kind,
        err: error,
      }, 'Semantic index run slice failed');
      return true;
    }
    heartbeat.stop();

    await this.settleRun(claimed, result, identity);
    return true;
  }

  private async settleRun(
    run: SemanticRun,
    result: SemanticRunSliceResult,
    identity: SemanticIndexIdentity,
  ): Promise<void> {
    const now = this.now();
    const checkpointed = await this.repository.checkpointRun({
      id: run.id,
      owner: this.owner,
      attempt: run.attempt,
      now,
      checkpoint: result.checkpoint,
      processedDelta: result.processed,
      failedDelta: result.failed,
      skippedDelta: result.skipped,
      leaseMs: this.config.runLeaseMs,
    });
    if (!checkpointed) return;
    this.onRunCheckpointed?.(run, result);

    semanticIndexLogger.info({
      event: 'semantic_run_slice',
      owner: this.owner,
      runId: run.id,
      indexId: run.indexId,
      kind: run.kind,
      status: result.status,
      processed: result.processed,
      skipped: result.skipped,
      failed: result.failed,
      ...(result.detail ?? {}),
    }, 'Semantic index run slice completed');

    if (result.status === 'completed') {
      const completed = await this.repository.completeRun({
        id: run.id,
        owner: this.owner,
        attempt: run.attempt,
        now,
        checkpoint: null,
      });
      if (completed && run.kind === 'backfill') await this.promoteIdentity(identity);
      return;
    }
    // Yielded or aborted: hand the lease back with the checkpoint intact so the
    // next pass (this worker or another) resumes exactly where this one stopped.
    await this.repository.releaseRun({
      id: run.id,
      owner: this.owner,
      attempt: run.attempt,
      now,
    });
  }

  /**
   * Offers the identity for service once it can actually answer queries.
   *
   * The activation gate is the repository's, not the worker's: while any live
   * document still lacks a current vector the gate refuses and the identity
   * simply stays `ready`. Nothing is forced into `active`, and a refusal is
   * logged at debug so a normal "still building" cycle does not look like an
   * error.
   *
   * Cutover is also how a model, provider, or projection change reaches
   * production. When another identity is already serving, this one is promoted
   * only if it is the space the *current* configuration resolves to — the
   * serving identity is otherwise left exactly where it is. The displaced
   * identity is demoted to `ready`, never retired, so it stays a rollback
   * target until cleanup ages it out.
   */
  private async promoteIdentity(identity: SemanticIndexIdentity): Promise<void> {
    const now = this.now();
    const current = await this.repository.getIdentity(identity.id);
    if (!current || current.status === 'active') return;
    if (current.status === 'building') {
      await this.repository.markIdentityReady(current.id, now);
    }

    const active = await this.repository.getActiveIdentity();
    if (active && active.id !== current.id) {
      const isConfiguredRoute = await this.service.matchesConfiguredRoute(current);
      if (!isConfiguredRoute) {
        semanticIndexLogger.debug({
          event: 'semantic_identity_activation',
          owner: this.owner,
          indexId: current.id,
          status: 'skipped',
          reason: 'route-mismatch',
          activeIndexId: active.id,
        }, 'Semantic index identity activation evaluated');
        return;
      }
    }

    const result = await this.repository.activateIdentity(current.id, now, {
      minVectorCount: 1,
    });
    const log = result.status === 'activated'
      ? semanticIndexLogger.info.bind(semanticIndexLogger)
      : semanticIndexLogger.debug.bind(semanticIndexLogger);
    log({
      event: 'semantic_identity_activation',
      owner: this.owner,
      indexId: current.id,
      status: result.status,
      reason: result.reason,
      // The displaced identity stays `ready`; naming it makes the rollback
      // target visible without a second query.
      previousIndexId: result.previousActiveId ?? undefined,
    }, 'Semantic index identity activation evaluated');
  }
}
