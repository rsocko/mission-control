import type {
  CopilotClientOptions,
  ResumeSessionConfig,
  SessionConfig,
} from '@github/copilot-sdk';
import type {
  HoustonToolPolicy,
  HoustonToolRunBinding,
} from './copilot-houston-tools';
import {
  CopilotTraceContextCarrier,
  HoustonRunEventMapper,
  copilotSdkTelemetryOptions,
  createW3CTraceContext,
  validateW3CTraceContext,
  type HoustonRunEvent,
  type HoustonRunEventCursor,
  type HoustonRunEventSink,
  type W3CTraceContext,
} from './copilot-run-events';
import {
  HoustonRunTracer,
  getDefaultHoustonRunTracer,
  type HoustonRunTrace,
  type HoustonRunTraceOperation,
} from './copilot-run-tracing';
import { createIsolatedCopilotSessionConfig } from './copilot-runtime-smoke';

export type CopilotRunState =
  | 'creating'
  | 'active'
  | 'idle'
  | 'resuming'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cleaned_up';

export type CopilotTerminalState =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'timed_out';

export type CopilotLifecycleErrorCode =
  | 'policy_denied'
  | 'run_exists'
  | 'run_not_found'
  | 'run_not_resumable'
  | 'run_not_active'
  | 'concurrency_saturated'
  | 'request_timed_out'
  | 'session_start_timed_out'
  | 'lifecycle_conflict'
  | 'cleanup_failed';

const ERROR_MESSAGES: Record<CopilotLifecycleErrorCode, string> = {
  policy_denied: 'Direct Copilot execution is not allowed by the resolved policy.',
  run_exists: 'The Mission Control run already owns a Copilot session.',
  run_not_found: 'The Mission Control run does not own a Copilot session.',
  run_not_resumable: 'The Mission Control run cannot be resumed.',
  run_not_active: 'The Mission Control run does not have an active Copilot session.',
  concurrency_saturated: 'The Copilot runtime concurrency limit is saturated.',
  request_timed_out: 'The Copilot request exceeded its bounded timeout.',
  session_start_timed_out: 'The Copilot session operation exceeded its bounded timeout.',
  lifecycle_conflict: 'The Mission Control run has a conflicting lifecycle operation.',
  cleanup_failed: 'The Copilot session could not be cleaned up deterministically.',
};

export class CopilotLifecycleError extends Error {
  constructor(readonly code: CopilotLifecycleErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CopilotLifecycleError';
  }
}

export interface CopilotRunRecord {
  runId: string;
  featureId: string;
  sensitivity: 'standard';
  correlationId: string;
  model: string;
  state: CopilotRunState;
  connection: 'attached' | 'detached';
  terminalState?: CopilotTerminalState;
  cleanupPending?: true;
  cleanupFailure?: true;
  providerSessionId?: string;
  traceContext: W3CTraceContext;
  ownerId: string;
  leaseExpiresAt: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type CopilotRunSnapshot = CopilotRunRecord;

export interface CopilotRunStore {
  get(runId: string): Promise<CopilotRunRecord | undefined>;
  list(): Promise<CopilotRunRecord[]>;
  create(record: CopilotRunRecord): Promise<boolean>;
  compareAndSet(
    expectedRevision: number,
    record: CopilotRunRecord,
  ): Promise<boolean>;
}

export class InMemoryCopilotRunStore implements CopilotRunStore {
  private readonly records = new Map<string, CopilotRunRecord>();

  async get(runId: string): Promise<CopilotRunRecord | undefined> {
    const record = this.records.get(runId);
    return record ? { ...record } : undefined;
  }

  async list(): Promise<CopilotRunRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async create(record: CopilotRunRecord): Promise<boolean> {
    if (this.records.has(record.runId)) return false;
    this.records.set(record.runId, { ...record });
    return true;
  }

  async compareAndSet(
    expectedRevision: number,
    record: CopilotRunRecord,
  ): Promise<boolean> {
    const current = this.records.get(record.runId);
    if (!current || current.revision !== expectedRevision) return false;
    this.records.set(record.runId, { ...record });
    return true;
  }
}

interface CopilotLifecycleSession {
  readonly sessionId: string;
  sendAndWait(
    prompt: string,
    timeout?: number,
  ): Promise<{ data: { content: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotLifecycleClient {
  createSession(config: SessionConfig): Promise<CopilotLifecycleSession>;
  resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotLifecycleSession>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface CopilotLifecycleOptions {
  maxConcurrentSessions: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  cleanupTimeoutMs: number;
  sessionOperationTimeoutMs: number;
  leaseDurationMs: number;
  workerId: string;
  reportError(error: unknown, operation: string): void;
  toolPolicy?: HoustonToolPolicy;
  eventSink?: HoustonRunEventSink;
  eventCursor?(runId: string): HoustonRunEventCursor | undefined;
  traceContextCarrier?: CopilotTraceContextCarrier;
  runTracer?: HoustonRunTracer;
}

export interface CreateCopilotRunInput {
  runId: string;
  featureId: string;
  sensitivity: 'local-only' | 'restricted' | 'standard';
  correlationId: string;
  model: string;
  traceContext?: W3CTraceContext;
}

export type CopilotLifecycleEvent = HoustonRunEvent;

interface ActiveRun {
  session: CopilotLifecycleSession;
  toolBinding?: HoustonToolRunBinding;
  eventContext: RunEventContext;
  record: CopilotRunRecord;
  idleTimer?: ReturnType<typeof setTimeout>;
  operation?: Promise<unknown>;
  terminalizing?: boolean;
  terminalOperation?: Promise<CopilotRunRecord>;
  cleanupStage?: 'abort' | 'disconnect' | 'delete';
}

interface RunEventContext {
  record: CopilotRunRecord;
}

const TERMINAL_STATES = new Set<CopilotRunState>([
  'completed',
  'failed',
  'timed_out',
  'cleaned_up',
]);

function validateOptions(options: CopilotLifecycleOptions): void {
  for (const value of [
    options.maxConcurrentSessions,
    options.requestTimeoutMs,
    options.idleTimeoutMs,
    options.cleanupTimeoutMs,
    options.sessionOperationTimeoutMs,
    options.leaseDurationMs,
  ]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError('Copilot lifecycle limits must be positive integers.');
    }
  }
  if (
    options.leaseDurationMs <=
    Math.max(
      options.requestTimeoutMs,
      options.sessionOperationTimeoutMs,
      options.idleTimeoutMs,
      options.cleanupTimeoutMs * 3,
    )
  ) {
    throw new TypeError('The worker lease must exceed every lifecycle deadline.');
  }
  if (!options.workerId.trim()) {
    throw new TypeError('The Copilot lifecycle worker ID is required.');
  }
}

function clone(record: CopilotRunRecord): CopilotRunSnapshot {
  return { ...record };
}

export class CopilotSessionLifecycleManager {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly reservations = new Set<string>();
  private reservationLock: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<
    string,
    Set<(event: CopilotLifecycleEvent) => void>
  >();
  private readonly eventMappers = new Map<string, HoustonRunEventMapper>();
  private readonly runTraces = new Map<string, HoustonRunTrace>();
  private readonly runTracer: HoustonRunTracer;

  constructor(
    private readonly client: CopilotLifecycleClient,
    private readonly store: CopilotRunStore,
    private readonly options: CopilotLifecycleOptions,
    private readonly now: () => number = Date.now,
  ) {
    validateOptions(options);
    this.runTracer = options.runTracer ?? getDefaultHoustonRunTracer();
    if (
      options.toolPolicy &&
      options.toolPolicy.executionTimeoutMs >= options.leaseDurationMs
    ) {
      throw new TypeError(
        'The worker lease must exceed the Houston tool execution timeout.',
      );
    }
  }

  subscribe(
    runId: string,
    listener: (event: CopilotLifecycleEvent) => void,
  ): () => void {
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  async getRun(runId: string): Promise<CopilotRunSnapshot | undefined> {
    const record = await this.store.get(runId);
    return record ? clone(record) : undefined;
  }

  async createRun(input: CreateCopilotRunInput): Promise<CopilotRunSnapshot> {
    if (input.sensitivity !== 'standard') {
      throw new CopilotLifecycleError('policy_denied');
    }
    const incomingTraceContext = input.traceContext
      ? validateW3CTraceContext(input.traceContext)
      : undefined;
    await this.reserve(input.runId);

    const timestamp = this.now();
    const traceContext =
      incomingTraceContext ?? createW3CTraceContext();
    let record: CopilotRunRecord = {
      runId: input.runId,
      featureId: input.featureId,
      sensitivity: input.sensitivity,
      correlationId: input.correlationId,
      model: input.model,
      traceContext,
      state: 'creating',
      connection: 'attached',
      ownerId: this.options.workerId,
      leaseExpiresAt: timestamp + this.options.leaseDurationMs,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let created = false;
    let retainReservation = false;
    let session: CopilotLifecycleSession | undefined;
    let toolBinding: HoustonToolRunBinding | undefined;
    let runTrace: HoustonRunTrace | undefined;
    const eventContext: RunEventContext = { record };
    let activated = false;
    try {
      if (!(await this.store.create(record))) {
        runTrace?.end('failed');
        throw new CopilotLifecycleError('run_exists');
      }
      created = true;
      runTrace = this.startRunTrace(input, incomingTraceContext);
      if (runTrace) {
        const tracedRecord: CopilotRunRecord = {
          ...record,
          traceContext: runTrace.traceContext,
          revision: record.revision + 1,
          updatedAt: this.now(),
        };
        if (!(await this.store.compareAndSet(record.revision, tracedRecord))) {
          runTrace.end('failed');
          runTrace = undefined;
          throw new CopilotLifecycleError('lifecycle_conflict');
        }
        record = tracedRecord;
        eventContext.record = record;
        this.runTraces.set(record.runId, runTrace);
      }
      this.emit(record);

      const configured = this.sessionConfig(record, eventContext);
      toolBinding = configured.toolBinding;
      session = await this.withSessionOperationTimeout(
        this.withTraceContext(record, 'session.create', () =>
          this.client.createSession(configured.config),
        ),
        async (lateSession) => {
          await this.cleanupLateSession(
            input.runId,
            lateSession,
            'late-session-create',
          );
        },
        'late-session-create',
        () => this.reservations.delete(input.runId),
      );
      record = await this.transition(record, 'idle', {
        providerSessionId: session.sessionId,
      });
      eventContext.record = record;
      this.activate(record, session, eventContext, toolBinding);
      activated = true;
      return clone(record);
    } catch (error) {
      if (!created) throw error;
      const timedOut =
        error instanceof CopilotLifecycleError &&
        error.code === 'session_start_timed_out';
      if (session) {
        record = await this.transitionCurrent(
          input.runId,
          timedOut ? 'timed_out' : 'failed',
          {
            terminalState: timedOut ? 'timed_out' : 'failed',
            providerSessionId: session.sessionId,
          },
        );
        await this.cleanup(record, session, false);
      } else if (timedOut) {
        retainReservation = true;
        record = await this.transitionCurrent(input.runId, 'timed_out', {
          terminalState: 'timed_out',
        });
        await this.transition(record, 'timed_out', {
          cleanupPending: true,
        });
      } else {
        record = await this.transitionCurrent(input.runId, 'failed', {
          terminalState: 'failed',
        });
        await this.transition(record, 'cleaned_up');
      }
      throw error;
    } finally {
      if (!activated) toolBinding?.dispose();
      if (!retainReservation) this.reservations.delete(input.runId);
    }
  }

  async resumeRun(runId: string): Promise<CopilotRunSnapshot> {
    const record = await this.requireRecord(runId);
    if (
      record.state !== 'idle' ||
      record.connection !== 'detached' ||
      !record.providerSessionId ||
      this.activeRuns.has(runId)
    ) {
      throw new CopilotLifecycleError('run_not_resumable');
    }
    await this.reserve(runId);
    this.ensureRunTrace(record);
    let resuming: CopilotRunRecord | undefined;
    let toolBinding: HoustonToolRunBinding | undefined;
    const eventContext: RunEventContext = { record };
    let activated = false;
    try {
      resuming = await this.transition(record, 'resuming');
      eventContext.record = resuming;
      const configured = this.sessionConfig(resuming, eventContext);
      toolBinding = configured.toolBinding;
      const session = await this.withSessionOperationTimeout(
        this.withTraceContext(resuming, 'session.resume', () =>
          this.client.resumeSession(record.providerSessionId!, {
            ...configured.config,
            suppressResumeEvent: false,
            continuePendingWork: false,
          }),
        ),
        async (lateSession) => {
          await this.cleanupLateSession(
            runId,
            lateSession,
            'late-session-resume',
          );
        },
        'late-session-resume',
      );
      if (session.sessionId !== record.providerSessionId) {
        await this.withTraceContext(resuming, 'session.disconnect', () =>
          session.disconnect(),
        );
        throw new CopilotLifecycleError('lifecycle_conflict');
      }
      resuming = await this.transition(resuming, 'idle', {
        connection: 'attached',
      });
      eventContext.record = resuming;
      this.activate(resuming, session, eventContext, toolBinding);
      activated = true;
      return clone(resuming);
    } catch (error) {
      if (!resuming) throw error;
      if (
        error instanceof CopilotLifecycleError &&
        error.code === 'session_start_timed_out'
      ) {
        const terminal = await this.transitionCurrent(runId, 'timed_out', {
          terminalState: 'timed_out',
          providerSessionId: record.providerSessionId,
        });
        await this.transition(terminal, 'timed_out', {
          cleanupPending: true,
        });
      } else {
        await this.transitionCurrent(runId, 'idle', {
          connection: 'detached',
        });
      }
      throw error;
    } finally {
      if (!activated) toolBinding?.dispose();
      this.reservations.delete(runId);
    }
  }

  async send(runId: string, prompt: string): Promise<string> {
    const active = this.activeRuns.get(runId);
    if (!active || active.terminalizing || active.operation) {
      throw new CopilotLifecycleError('run_not_active');
    }
    active.operation = Promise.resolve();

    let sending: CopilotRunRecord | undefined;
    try {
      const record = await this.requireRecord(runId);
      if (
        active.terminalizing ||
        record.state !== 'idle' ||
        record.connection !== 'attached' ||
        record.ownerId !== this.options.workerId
      ) {
        throw new CopilotLifecycleError('run_not_active');
      }

      this.clearIdleTimer(active);
      sending = await this.transition(record, 'active');
      if (active.terminalizing) {
        throw new CopilotLifecycleError('lifecycle_conflict');
      }
      const operation = this.sendWithTimeout(
        sending,
        active.session,
        prompt,
      );
      active.operation = operation;

      const response = await operation;
      const latest = await this.requireRecord(runId);
      if (latest.state !== 'active') {
        throw new CopilotLifecycleError('lifecycle_conflict');
      }
      const idle = await this.transition(latest, 'idle');
      this.scheduleIdleCleanup(idle, active);
      return response?.data.content ?? '';
    } catch (error) {
      if (!sending) throw error;
      const timedOut =
        error instanceof CopilotLifecycleError &&
        error.code === 'request_timed_out';
      const latest = await this.requireRecord(runId);
      if (active.terminalizing || latest.state === 'cleaned_up') {
        throw error;
      }
      active.terminalizing = true;
      const terminal = await this.transition(
        latest,
        timedOut ? 'timed_out' : 'failed',
        { terminalState: timedOut ? 'timed_out' : 'failed' },
      );
      await this.terminalCleanup(active, terminal, true);
      throw error;
    } finally {
      active.operation = undefined;
    }
  }

  async disconnectRun(runId: string): Promise<CopilotRunSnapshot> {
    const active = this.activeRuns.get(runId);
    if (!active || active.operation || active.terminalizing) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    active.terminalizing = true;
    try {
      const record = await this.requireRecord(runId);
      if (
        record.state !== 'idle' ||
        record.connection !== 'attached' ||
        record.ownerId !== this.options.workerId
      ) {
        throw new CopilotLifecycleError('lifecycle_conflict');
      }
      this.clearIdleTimer(active);
      await this.withTimeout(
        this.withTraceContext(record, 'session.disconnect', () =>
          active.session.disconnect(),
        ),
      );
      const detached = await this.transition(record, 'idle', {
        connection: 'detached',
      });
      active.toolBinding?.dispose();
      this.activeRuns.delete(runId);
      return clone(detached);
    } catch (error) {
      active.terminalizing = false;
      this.scheduleIdleCleanup(active.record, active);
      if (
        error instanceof CopilotLifecycleError &&
        error.code === 'lifecycle_conflict'
      ) {
        throw error;
      }
      throw new CopilotLifecycleError('cleanup_failed');
    }
  }

  async completeRun(runId: string): Promise<CopilotRunSnapshot> {
    const active = this.activeRuns.get(runId);
    if (!active || active.operation || active.terminalizing) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    active.terminalizing = true;
    const record = await this.requireRecord(runId);
    if (
      record.state !== 'idle' ||
      record.connection !== 'attached' ||
      record.ownerId !== this.options.workerId
    ) {
      active.terminalizing = false;
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    const terminal = await this.transition(record, 'completed', {
      terminalState: 'completed',
    });
    return clone(await this.terminalCleanup(active, terminal, false));
  }

  async retryCleanup(runId: string): Promise<CopilotRunSnapshot> {
    const record = await this.requireRecord(runId);
    this.ensureRunTrace(record);
    if (!record.cleanupPending || !record.providerSessionId) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    const active = this.activeRuns.get(runId);
    if (active) {
      return clone(await this.terminalCleanup(active, record, false));
    }

    try {
      await this.deleteSessionWithTimeout(runId, record.providerSessionId);
    } catch {
      throw new CopilotLifecycleError('cleanup_failed');
    }
    return clone(
      await this.transition(record, 'cleaned_up', {
        cleanupPending: undefined,
        cleanupFailure: undefined,
        providerSessionId: undefined,
      }),
    );
  }

  async reapExpiredDisconnectedRuns(): Promise<CopilotRunSnapshot[]> {
    const cutoff = this.now() - this.options.idleTimeoutMs;
    const expired = (await this.store.list()).filter(
      (record) =>
        record.state === 'idle' &&
        record.connection === 'detached' &&
        record.providerSessionId &&
        record.updatedAt <= cutoff,
    );
    const reaped: CopilotRunSnapshot[] = [];
    for (const record of expired) {
      this.ensureRunTrace(record);
      const terminal = await this.transition(record, 'timed_out', {
        terminalState: 'timed_out',
      });
      const cleanupStarted = await this.transition(terminal, 'timed_out', {
        cleanupPending: true,
        cleanupFailure: undefined,
      });
      try {
        await this.deleteSessionWithTimeout(
          record.runId,
          record.providerSessionId!,
        );
        reaped.push(
          clone(
            await this.transition(cleanupStarted, 'cleaned_up', {
              cleanupPending: undefined,
              cleanupFailure: undefined,
              providerSessionId: undefined,
            }),
          ),
        );
      } catch {
        await this.transition(cleanupStarted, 'failed', {
          cleanupPending: true,
          cleanupFailure: true,
        });
        this.reportSafeError('detached-session-reaper', 'cleanup_failed');
      }
    }
    return reaped;
  }

  async recoverExpiredWorkerLeases(): Promise<CopilotRunSnapshot[]> {
    const expired = (await this.store.list()).filter(
      (record) =>
        record.connection === 'attached' &&
        record.leaseExpiresAt <= this.now(),
    );
    const recovered: CopilotRunSnapshot[] = [];
    for (const record of expired) {
      this.ensureRunTrace(record);
      try {
        if (
          record.providerSessionId &&
          (record.state === 'idle' || record.state === 'resuming')
        ) {
          recovered.push(
            clone(
              await this.transition(record, 'idle', {
                connection: 'detached',
              }),
            ),
          );
          continue;
        }

        let terminal = await this.transition(record, 'failed', {
          terminalState: record.terminalState ?? 'failed',
        });
        if (record.providerSessionId) {
          terminal = await this.transition(terminal, 'failed', {
            cleanupPending: true,
            cleanupFailure: undefined,
          });
          try {
            await this.deleteSessionWithTimeout(
              record.runId,
              record.providerSessionId,
            );
          } catch {
            terminal = await this.transition(terminal, 'failed', {
              cleanupPending: true,
              cleanupFailure: true,
            });
            this.reportSafeError(
              'expired-worker-lease-recovery',
              'cleanup_failed',
            );
            recovered.push(clone(terminal));
            continue;
          }
        }
        recovered.push(
          clone(
            await this.transition(terminal, 'cleaned_up', {
              cleanupPending: undefined,
              cleanupFailure: undefined,
              providerSessionId: undefined,
            }),
          ),
        );
      } catch (error) {
        if (
          !(error instanceof CopilotLifecycleError) ||
          error.code !== 'lifecycle_conflict'
        ) {
          throw error;
        }
      }
    }
    return recovered;
  }

  async cancelRun(runId: string): Promise<CopilotRunSnapshot> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      throw new CopilotLifecycleError('run_not_active');
    }
    if (active.terminalizing) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    active.terminalizing = true;
    const record = await this.requireRecord(runId);
    if (
      record.ownerId !== this.options.workerId ||
      TERMINAL_STATES.has(record.state) ||
      record.state === 'cancelling'
    ) {
      active.terminalizing = false;
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    active.toolBinding?.cancel();
    let latest = record;
    let cancelling: CopilotRunRecord;
    for (;;) {
      if (
        latest.ownerId !== this.options.workerId ||
        (latest.state !== 'idle' && latest.state !== 'active')
      ) {
        active.terminalizing = false;
        throw new CopilotLifecycleError('lifecycle_conflict');
      }
      try {
        cancelling = await this.transition(latest, 'cancelling', {
          terminalState: 'cancelled',
        });
        break;
      } catch (error) {
        if (
          !(error instanceof CopilotLifecycleError) ||
          error.code !== 'lifecycle_conflict'
        ) {
          active.terminalizing = false;
          throw error;
        }
        latest = await this.requireRecord(runId);
      }
    }
    return clone(await this.terminalCleanup(active, cancelling, true));
  }

  async shutdownForRestart(): Promise<void> {
    const runs = [...this.activeRuns.entries()];
    const results = await Promise.allSettled(
      runs.map(async ([runId, active]) => {
        const record = await this.requireRecord(runId);
        if (record.ownerId !== this.options.workerId) {
          active.toolBinding?.dispose();
          await this.withTimeout(
            this.withTraceContext(record, 'session.disconnect', () =>
              active.session.disconnect(),
            ),
          );
          this.activeRuns.delete(runId);
          return;
        }
        if (
          active.terminalOperation ||
          record.state === 'cancelling' ||
          record.state === 'completed' ||
          record.state === 'failed' ||
          record.state === 'timed_out'
        ) {
          active.terminalizing = true;
          await this.terminalCleanup(
            active,
            record,
            record.terminalState !== 'completed',
          );
          return;
        }
        if (record.state === 'active') {
          active.terminalizing = true;
          const terminal = await this.transition(record, 'failed', {
            terminalState: 'failed',
          });
          await this.terminalCleanup(active, terminal, true);
          return;
        }
        await this.disconnectRun(runId);
      }),
    );
    if (results.some((result) => result.status === 'rejected')) {
      throw new CopilotLifecycleError('cleanup_failed');
    }
  }

  private sessionConfig(
    record: CopilotRunRecord,
    eventContext: RunEventContext,
  ): {
    config: SessionConfig;
    toolBinding?: HoustonToolRunBinding;
  } {
    const toolBinding = this.options.toolPolicy?.bindRun({
      runId: record.runId,
      correlationId: record.correlationId,
      authorizeSession: (sessionId) =>
        this.authorizeActiveRunSession(record.runId, sessionId),
      onAudit: (event) => {
        const disposition = this.mapperFor(
          eventContext.record,
        ).mapToolAudit(event);
        if (disposition.accepted) this.dispatch(disposition.event);
      },
    });
    const config = createIsolatedCopilotSessionConfig(
      'mission-control-copilot-session-lifecycle-spike',
      record.model,
      toolBinding?.onPermissionRequest ??
        (() => ({
          kind: 'reject',
          feedback: 'The isolated lifecycle spike denies all permissions.',
        })),
    );
    return {
      config: {
        ...config,
        availableTools: toolBinding?.availableTools ?? [],
        tools: toolBinding?.tools ?? [],
        excludedTools: [],
        canvases: [],
        commands: [],
        mcpServers: {},
        customAgents: [],
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        disabledSkills: [],
        customAgentsLocalOnly: true,
        coauthorEnabled: false,
        memory: { enabled: false },
        toolSearch: { enabled: false },
        largeOutput: { enabled: false },
        streaming: false,
        includeSubAgentStreamingEvents: false,
        manageScheduleEnabled: false,
        enableCitations: false,
        enableMcpApps: false,
        enableManagedSettings: false,
        enableOnDemandInstructionDiscovery: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        onEvent: (event) => {
          const disposition = this.mapperFor(
            eventContext.record,
          ).mapNative(event);
          if (disposition.accepted) this.dispatch(disposition.event);
        },
      },
      toolBinding,
    };
  }

  private async reserve(runId: string): Promise<void> {
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
        this.options.maxConcurrentSessions
      ) {
        throw new CopilotLifecycleError('concurrency_saturated');
      }
      this.reservations.add(runId);
    } finally {
      unlock();
    }
  }

  private activate(
    record: CopilotRunRecord,
    session: CopilotLifecycleSession,
    eventContext: RunEventContext,
    toolBinding?: HoustonToolRunBinding,
  ): void {
    const active: ActiveRun = {
      session,
      toolBinding,
      eventContext,
      record,
    };
    this.activeRuns.set(record.runId, active);
    this.scheduleIdleCleanup(record, active);
  }

  private scheduleIdleCleanup(
    record: CopilotRunRecord,
    active: ActiveRun,
  ): void {
    this.clearIdleTimer(active);
    active.idleTimer = setTimeout(() => {
      void this.expireIdleRun(record.runId).catch(() => {
        this.reportSafeError('idle-session-cleanup', 'cleanup_failed');
      });
    }, this.options.idleTimeoutMs);
  }

  private async expireIdleRun(runId: string): Promise<void> {
    const record = await this.store.get(runId);
    const active = this.activeRuns.get(runId);
    if (
      !record ||
      !active ||
      record.state !== 'idle' ||
      record.connection !== 'attached' ||
      record.ownerId !== this.options.workerId ||
      active.operation ||
      active.terminalizing
    ) {
      return;
    }
    active.terminalizing = true;
    const terminal = await this.transition(record, 'timed_out', {
      terminalState: 'timed_out',
    });
    await this.terminalCleanup(active, terminal, true);
  }

  private clearIdleTimer(active: ActiveRun): void {
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = undefined;
  }

  private terminalCleanup(
    active: ActiveRun,
    record: CopilotRunRecord,
    abort: boolean,
  ): Promise<CopilotRunRecord> {
    if (active.terminalOperation) return active.terminalOperation;
    const tracked = this.cleanup(record, active.session, abort).finally(() => {
      if (active.terminalOperation === tracked) {
        active.terminalOperation = undefined;
      }
    });
    active.terminalOperation = tracked;
    return tracked;
  }

  private async cleanup(
    record: CopilotRunRecord,
    session: CopilotLifecycleSession,
    abort: boolean,
  ): Promise<CopilotRunRecord> {
    const active = this.activeRuns.get(record.runId);
    if (active) {
      this.clearIdleTimer(active);
      active.toolBinding?.cancel();
      if (!active.cleanupStage) {
        active.cleanupStage = abort ? 'abort' : 'disconnect';
      }
    }

    let cleanupRecord = record.cleanupPending
      ? record
      : await this.transition(record, record.state, {
          cleanupPending: true,
          cleanupFailure: undefined,
          providerSessionId: session.sessionId,
        });
    let cleanupStage =
      active?.cleanupStage ?? (abort ? 'abort' : 'disconnect');
    try {
      if (cleanupStage === 'abort') {
        await this.withTimeout(
          this.withTraceContext(cleanupRecord, 'session.abort', () =>
            session.abort(),
          ),
        );
        cleanupStage = 'disconnect';
        if (active) active.cleanupStage = cleanupStage;
      }
      if (cleanupStage === 'disconnect') {
        await this.withTimeout(
          this.withTraceContext(cleanupRecord, 'session.disconnect', () =>
            session.disconnect(),
          ),
        );
        cleanupStage = 'delete';
        if (active) active.cleanupStage = cleanupStage;
      }
      await this.deleteSessionWithTimeout(record.runId, session.sessionId);
    } catch {
      cleanupRecord = await this.transitionCurrent(record.runId, 'failed', {
        cleanupPending: true,
        cleanupFailure: true,
        providerSessionId: session.sessionId,
      });
      throw new CopilotLifecycleError('cleanup_failed');
    }

    this.activeRuns.delete(record.runId);
    active?.toolBinding?.dispose();
    const cleaned = await this.transitionCurrent(cleanupRecord.runId, 'cleaned_up', {
      cleanupPending: undefined,
      cleanupFailure: undefined,
      providerSessionId: undefined,
    });
    this.listeners.delete(record.runId);
    return cleaned;
  }

  private async sendWithTimeout(
    record: CopilotRunRecord,
    session: CopilotLifecycleSession,
    prompt: string,
  ): Promise<{ data: { content: string } } | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CopilotLifecycleError('request_timed_out')),
        this.options.requestTimeoutMs,
      );
    });
    try {
      return await Promise.race([
        this.withTraceContext(record, 'session.send', () =>
          session.sendAndWait(prompt, this.options.requestTimeoutMs + 1_000),
        ),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CopilotLifecycleError('cleanup_failed')),
        this.options.cleanupTimeoutMs,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async withSessionOperationTimeout<T extends CopilotLifecycleSession>(
    operation: Promise<T>,
    cleanupLateSession: (session: T) => Promise<void>,
    operationName: string,
    onLateSettled?: () => void,
  ): Promise<T> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void operation.then(
      async (session) => {
        if (!timedOut) return;
        try {
          await cleanupLateSession(session);
        } catch {
          this.reportSafeError(operationName, 'cleanup_failed');
        } finally {
          onLateSettled?.();
        }
      },
      () => {
        if (timedOut) {
          this.reportSafeError(operationName, 'session_start_timed_out');
          onLateSettled?.();
        }
      },
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new CopilotLifecycleError('session_start_timed_out'));
      }, this.options.sessionOperationTimeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async cleanupLateSession(
    runId: string,
    session: CopilotLifecycleSession,
    operationName: string,
  ): Promise<void> {
    await this.markCleanupPending(runId, session.sessionId);
    const cleanupRecord = await this.requireRecord(runId);
    try {
      await this.withTraceContext(cleanupRecord, 'session.disconnect', () =>
        session.disconnect(),
      );
    } catch {
      this.reportSafeError(`${operationName}-disconnect`, 'cleanup_failed');
    }

    try {
      await this.withTraceContext(cleanupRecord, 'session.delete', () =>
        this.client.deleteSession(session.sessionId),
      );
      await this.reconcileDeletedSession(runId, session.sessionId);
    } catch {
      await this.transitionCurrent(runId, 'failed', {
        cleanupPending: true,
        cleanupFailure: true,
        providerSessionId: session.sessionId,
      });
      throw new CopilotLifecycleError('cleanup_failed');
    }
  }

  private async deleteSessionWithTimeout(
    runId: string,
    sessionId: string,
  ): Promise<void> {
    let timedOut = false;
    const record = await this.requireRecord(runId);
    this.ensureRunTrace(record);
    const deletion = this.withTraceContext(
      record,
      'session.delete',
      () => this.client.deleteSession(sessionId),
    );
    void deletion.then(
      () => {
        if (!timedOut) return;
        void this.reconcileDeletedSession(runId, sessionId).catch(() => {
          this.reportSafeError('late-session-delete', 'cleanup_failed');
        });
      },
      () => {
        if (timedOut) {
          this.reportSafeError('late-session-delete', 'cleanup_failed');
        }
      },
    );
    try {
      await this.withTimeout(deletion);
    } catch (error) {
      timedOut = true;
      throw error;
    }
  }

  private async markCleanupPending(
    runId: string,
    sessionId: string,
  ): Promise<CopilotRunRecord> {
    const current = await this.requireRecord(runId);
    if (
      current.cleanupPending &&
      current.providerSessionId === sessionId
    ) {
      return current;
    }
    return this.transitionCurrent(runId, undefined, {
      cleanupPending: true,
      cleanupFailure: undefined,
      providerSessionId: sessionId,
    });
  }

  private async reconcileDeletedSession(
    runId: string,
    sessionId: string,
  ): Promise<void> {
    for (;;) {
      const record = await this.requireRecord(runId);
      if (
        record.state === 'cleaned_up' ||
        record.providerSessionId !== sessionId
      ) {
        return;
      }
      try {
        await this.transition(record, 'cleaned_up', {
          cleanupPending: undefined,
          cleanupFailure: undefined,
          providerSessionId: undefined,
        });
        this.activeRuns.delete(runId);
        this.listeners.delete(runId);
        return;
      } catch (error) {
        if (
          !(error instanceof CopilotLifecycleError) ||
          error.code !== 'lifecycle_conflict'
        ) {
          throw error;
        }
      }
    }
  }

  private async requireRecord(runId: string): Promise<CopilotRunRecord> {
    const record = await this.store.get(runId);
    if (!record) throw new CopilotLifecycleError('run_not_found');
    return record;
  }

  private async authorizeActiveRunSession(
    runId: string,
    sessionId: string,
  ): Promise<{ validUntil: number } | undefined> {
    const active = this.activeRuns.get(runId);
    const record = await this.store.get(runId);
    if (
      active &&
      !active.terminalizing &&
      record &&
      record.sensitivity === 'standard' &&
      record.ownerId === this.options.workerId &&
      record.leaseExpiresAt > this.now() &&
      record.connection === 'attached' &&
      (record.state === 'idle' || record.state === 'active') &&
      record.providerSessionId === sessionId &&
      active.session.sessionId === sessionId
    ) {
      return { validUntil: record.leaseExpiresAt };
    }
    return undefined;
  }

  private async transitionCurrent(
    runId: string,
    state: CopilotRunState | undefined,
    changes: Partial<CopilotRunRecord>,
  ): Promise<CopilotRunRecord> {
    for (;;) {
      const record = await this.requireRecord(runId);
      if (record.state === 'cleaned_up') return record;
      try {
        return await this.transition(record, state ?? record.state, changes);
      } catch (error) {
        if (
          !(error instanceof CopilotLifecycleError) ||
          error.code !== 'lifecycle_conflict'
        ) {
          throw error;
        }
      }
    }
  }

  private reportSafeError(
    operation: string,
    code: CopilotLifecycleErrorCode,
  ): void {
    this.options.reportError(new CopilotLifecycleError(code), operation);
  }

  private async transition(
    record: CopilotRunRecord,
    state: CopilotRunState,
    changes: Partial<CopilotRunRecord> = {},
  ): Promise<CopilotRunRecord> {
    const updated: CopilotRunRecord = {
      ...record,
      ...changes,
      runId: record.runId,
      state,
      ownerId: this.options.workerId,
      leaseExpiresAt: this.now() + this.options.leaseDurationMs,
      revision: record.revision + 1,
      updatedAt: this.now(),
    };
    if (!(await this.store.compareAndSet(record.revision, updated))) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    const active = this.activeRuns.get(record.runId);
    if (active) {
      active.record = updated;
      active.eventContext.record = updated;
    }
    this.emit(updated);
    return updated;
  }

  private async withTraceContext<T>(
    record: CopilotRunRecord,
    operationName: HoustonRunTraceOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    const carrier = this.options.traceContextCarrier;
    const runWithCarrier = (traceContext: W3CTraceContext) =>
      carrier ? carrier.run(traceContext, operation) : operation();
    const runTrace = this.runTraces.get(record.runId);
    if (!runTrace) return runWithCarrier(record.traceContext);

    let operationStarted = false;
    try {
      return await runTrace.runOperation(operationName, (traceContext) => {
        operationStarted = true;
        return runWithCarrier(traceContext);
      });
    } catch (error) {
      if (operationStarted) throw error;
      this.reportTraceError('run-trace-operation');
      return runWithCarrier(record.traceContext);
    }
  }

  private startRunTrace(
    input: CreateCopilotRunInput,
    incomingTraceContext: W3CTraceContext | undefined,
  ): HoustonRunTrace | undefined {
    try {
      return this.runTracer.startRun({
        runId: input.runId,
        correlationId: input.correlationId,
        featureId: input.featureId,
        sensitivity: 'standard',
        incomingTraceContext,
      });
    } catch {
      this.reportTraceError('run-trace-start');
      return undefined;
    }
  }

  private ensureRunTrace(record: CopilotRunRecord): void {
    if (this.runTraces.has(record.runId)) return;
    try {
      this.runTraces.set(
        record.runId,
        this.runTracer.continueRun(record.traceContext),
      );
    } catch {
      this.reportTraceError('run-trace-continue');
    }
  }

  private reportTraceError(operation: string): void {
    this.options.reportError(
      new Error('Copilot run tracing failed.'),
      operation,
    );
  }

  private mapperFor(record: CopilotRunRecord): HoustonRunEventMapper {
    const existing = this.eventMappers.get(record.runId);
    if (existing) return existing;
    const mapper = new HoustonRunEventMapper(
      record,
      this.options.eventCursor?.(record.runId),
      this.now,
    );
    this.eventMappers.set(record.runId, mapper);
    return mapper;
  }

  private emit(record: CopilotRunRecord): void {
    const disposition = this.mapperFor(record).mapLifecycle(record);
    if (!disposition.accepted) return;
    this.dispatch(disposition.event);
    if (record.state === 'cleaned_up') {
      this.eventMappers.delete(record.runId);
      this.runTraces.delete(record.runId);
    }
  }

  private dispatch(event: CopilotLifecycleEvent): void {
    const runTrace = this.runTraces.get(event.runId);
    if (runTrace) {
      try {
        event.trace = runTrace.recordEvent(event);
      } catch {
        this.reportTraceError('run-trace-event');
      }
      if (event.kind === 'run.terminal' && event.terminalState) {
        try {
          runTrace.end(event.terminalState);
        } catch {
          this.reportTraceError('run-trace-end');
        }
      }
    }
    try {
      const emitted = this.options.eventSink?.emit(event);
      if (emitted) {
        void emitted.catch(() => {
          this.reportSafeError('run-event-sink', 'lifecycle_conflict');
        });
      }
    } catch {
      this.reportSafeError('run-event-sink', 'lifecycle_conflict');
    }
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        this.reportSafeError('run-event-listener', 'lifecycle_conflict');
      }
    }
  }
}

export function createTracedCopilotSessionLifecycleManager(
  createClient: (options: CopilotClientOptions) => CopilotLifecycleClient,
  store: CopilotRunStore,
  options: CopilotLifecycleOptions,
  clientOptions: CopilotClientOptions = {},
): CopilotSessionLifecycleManager {
  const carrier =
    options.traceContextCarrier ?? new CopilotTraceContextCarrier();
  const telemetryOptions = copilotSdkTelemetryOptions(carrier);
  const client = createClient({
    ...clientOptions,
    ...telemetryOptions,
    telemetry: {
      ...clientOptions.telemetry,
      ...telemetryOptions.telemetry,
      captureContent: false,
    },
  });
  return new CopilotSessionLifecycleManager(client, store, {
    ...options,
    traceContextCarrier: carrier,
  });
}
