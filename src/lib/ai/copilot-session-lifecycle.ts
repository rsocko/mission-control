import type {
  CopilotClientOptions,
  SessionConfig,
} from '@github/copilot-sdk';
import type {
  HoustonToolRunBinding,
} from './copilot-houston-tools';
import {
  CopilotTraceContextCarrier,
  copilotSdkTelemetryOptions,
  createW3CTraceContext,
  validateW3CTraceContext,
  type W3CTraceContext,
} from './copilot-run-events';
import type {
  HoustonRunTrace,
  HoustonRunTraceOperation,
} from './copilot-run-tracing';
import { createIsolatedCopilotSessionConfig } from './copilot-runtime-smoke';
import {
  CopilotLifecycleError,
  cloneCopilotRun,
  validateCopilotLifecycleOptions,
  type CopilotLifecycleClient,
  type CopilotLifecycleErrorCode,
  type CopilotLifecycleEvent,
  type CopilotLifecycleOptions,
  type CopilotLifecycleSession,
  type CopilotRunRecord,
  type CopilotRunSnapshot,
  type CopilotRunState,
  type CopilotRunStore,
  type CreateCopilotRunInput,
} from './copilot-lifecycle-contracts';
import {
  CopilotLeaseManager,
  type CopilotLifecycleClock,
} from './copilot-lease-manager';
import { CopilotLifecycleTelemetryBridge } from './copilot-lifecycle-telemetry';
import { CopilotRunReaper } from './copilot-run-reaper';
import { CopilotRunStateMachine } from './copilot-run-state-machine';

export * from './copilot-lifecycle-contracts';

interface ActiveRun {
  session: CopilotLifecycleSession;
  toolBinding?: HoustonToolRunBinding;
  eventContext: RunEventContext;
  record: CopilotRunRecord;
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

export class CopilotSessionLifecycleManager {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly stateMachine: CopilotRunStateMachine;
  private readonly leases: CopilotLeaseManager;
  private readonly reaper: CopilotRunReaper;
  private readonly telemetry: CopilotLifecycleTelemetryBridge;

  constructor(
    private readonly client: CopilotLifecycleClient,
    store: CopilotRunStore,
    private readonly options: CopilotLifecycleOptions,
    private readonly now: () => number = Date.now,
  ) {
    validateCopilotLifecycleOptions(options);
    this.telemetry = new CopilotLifecycleTelemetryBridge(options, now);
    this.stateMachine = new CopilotRunStateMachine(
      store,
      options.workerId,
      options.leaseDurationMs,
      now,
      (record) => {
        const active = this.activeRuns.get(record.runId);
        if (active) {
          active.record = record;
          active.eventContext.record = record;
        }
        this.telemetry.emitLifecycle(record);
      },
    );
    const clock: CopilotLifecycleClock = {
      now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.leases = new CopilotLeaseManager(
      store,
      options.maxConcurrentSessions,
      options.idleTimeoutMs,
      clock,
    );
    this.reaper = new CopilotRunReaper(this.stateMachine, this.leases, {
      deleteSession: (runId, sessionId) =>
        this.deleteSessionWithTimeout(runId, sessionId),
      ensureTelemetry: (record) => this.ensureRunTrace(record),
      reportError: (operation, error) => {
        try {
          this.options.reportError(error, operation);
        } catch {
          // Error reporting is observational and cannot change reaper outcomes.
        }
      },
    });
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
    return this.telemetry.subscribe(runId, listener);
  }

  async getRun(runId: string): Promise<CopilotRunSnapshot | undefined> {
    const record = await this.stateMachine.get(runId);
    return record ? cloneCopilotRun(record) : undefined;
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
      await this.stateMachine.create(record);
      created = true;
      runTrace = this.startRunTrace(input, incomingTraceContext);
      if (runTrace) {
        try {
          record = await this.stateMachine.updateMetadata(record, {
            traceContext: runTrace.traceContext,
          });
        } catch (error) {
          this.telemetry.endRun(record.runId, 'failed');
          this.telemetry.removeRunTrace(record.runId);
          runTrace = undefined;
          throw error;
        }
        eventContext.record = record;
      } else {
        this.emit(record);
      }

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
        () => this.leases.release(input.runId),
      );
      record = await this.transition(record, 'idle', {
        providerSessionId: session.sessionId,
      });
      eventContext.record = record;
      this.activate(record, session, eventContext, toolBinding);
      activated = true;
      return cloneCopilotRun(record);
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
      if (!retainReservation) this.leases.release(input.runId);
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
      return cloneCopilotRun(resuming);
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
      this.leases.release(runId);
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
      this.scheduleIdleCleanup(idle);
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
      return cloneCopilotRun(detached);
    } catch (error) {
      active.terminalizing = false;
      this.scheduleIdleCleanup(active.record);
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
    return cloneCopilotRun(await this.terminalCleanup(active, terminal, false));
  }

  async retryCleanup(runId: string): Promise<CopilotRunSnapshot> {
    const record = await this.requireRecord(runId);
    this.ensureRunTrace(record);
    if (!record.cleanupPending || !record.providerSessionId) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    const active = this.activeRuns.get(runId);
    if (active) {
      return cloneCopilotRun(await this.terminalCleanup(active, record, false));
    }

    try {
      await this.deleteSessionWithTimeout(runId, record.providerSessionId);
    } catch {
      throw new CopilotLifecycleError('cleanup_failed');
    }
    return cloneCopilotRun(
      await this.transition(record, 'cleaned_up', {
        cleanupPending: undefined,
        cleanupFailure: undefined,
        providerSessionId: undefined,
      }),
    );
  }

  async reapExpiredDisconnectedRuns(): Promise<CopilotRunSnapshot[]> {
    return this.reaper.reapExpiredDisconnectedRuns();
  }

  async recoverExpiredWorkerLeases(): Promise<CopilotRunSnapshot[]> {
    return this.reaper.recoverExpiredWorkerLeases();
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
    return cloneCopilotRun(
      await this.terminalCleanup(active, cancelling, true),
    );
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
      onAudit: (event) =>
        this.telemetry.emitToolAudit(eventContext.record, event),
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
        onEvent: (event) =>
          this.telemetry.emitNative(eventContext.record, event),
      },
      toolBinding,
    };
  }

  private async reserve(runId: string): Promise<void> {
    await this.leases.reserve(runId);
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
    this.scheduleIdleCleanup(record);
  }

  private scheduleIdleCleanup(record: CopilotRunRecord): void {
    this.leases.scheduleIdleExpiration(record.runId, async () => {
      try {
        await this.expireIdleRun(record.runId);
      } catch {
        this.reportSafeError('idle-session-cleanup', 'cleanup_failed');
      }
    });
  }

  private async expireIdleRun(runId: string): Promise<void> {
    const record = await this.stateMachine.get(runId);
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
    this.leases.clearIdleExpiration(active.record.runId);
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
    this.telemetry.forgetListeners(record.runId);
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
        this.telemetry.forgetListeners(runId);
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
    return this.stateMachine.require(runId);
  }

  private async authorizeActiveRunSession(
    runId: string,
    sessionId: string,
  ): Promise<{ validUntil: number } | undefined> {
    const active = this.activeRuns.get(runId);
    const record = await this.stateMachine.get(runId);
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
    return this.stateMachine.transitionCurrent(runId, state, changes);
  }

  private reportSafeError(
    operation: string,
    code: CopilotLifecycleErrorCode,
  ): void {
    try {
      this.options.reportError(new CopilotLifecycleError(code), operation);
    } catch {
      // Error reporting is observational and cannot change lifecycle outcomes.
    }
  }

  private async transition(
    record: CopilotRunRecord,
    state: CopilotRunState,
    changes: Partial<CopilotRunRecord> = {},
  ): Promise<CopilotRunRecord> {
    return this.stateMachine.transition(record, state, changes);
  }

  private async withTraceContext<T>(
    record: CopilotRunRecord,
    operationName: HoustonRunTraceOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.telemetry.withTraceContext(record, operationName, operation);
  }

  private startRunTrace(
    input: CreateCopilotRunInput,
    incomingTraceContext: W3CTraceContext | undefined,
  ): HoustonRunTrace | undefined {
    return this.telemetry.startRun(input, incomingTraceContext);
  }

  private ensureRunTrace(record: CopilotRunRecord): void {
    this.telemetry.ensureRun(record);
  }

  private emit(record: CopilotRunRecord): void {
    this.telemetry.emitLifecycle(record);
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
