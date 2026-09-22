import type { SessionEvent } from '@github/copilot-sdk';
import {
  CopilotLifecycleError,
  type CopilotLifecycleEvent,
  type CopilotLifecycleOptions,
  type CopilotRunRecord,
  type CopilotTerminalState,
  type CreateCopilotRunInput,
} from './copilot-lifecycle-contracts';
import {
  HoustonRunEventMapper,
  type W3CTraceContext,
} from './copilot-run-events';
import {
  getDefaultHoustonRunTracer,
  type HoustonRunTrace,
  type HoustonRunTraceOperation,
  type HoustonRunTracer,
} from './copilot-run-tracing';

type HoustonToolAudit = Parameters<HoustonRunEventMapper['mapToolAudit']>[0];

export class CopilotLifecycleTelemetryBridge {
  private readonly listeners = new Map<
    string,
    Set<(event: CopilotLifecycleEvent) => void>
  >();
  private readonly eventMappers = new Map<string, HoustonRunEventMapper>();
  private readonly runTraces = new Map<string, HoustonRunTrace>();
  private readonly runTracer: HoustonRunTracer;

  constructor(
    private readonly options: Pick<
      CopilotLifecycleOptions,
      | 'eventCursor'
      | 'eventSink'
      | 'reportError'
      | 'runTracer'
      | 'traceContextCarrier'
    >,
    private readonly now: () => number = Date.now,
  ) {
    this.runTracer = options.runTracer ?? getDefaultHoustonRunTracer();
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

  startRun(
    input: CreateCopilotRunInput,
    incomingTraceContext: W3CTraceContext | undefined,
  ): HoustonRunTrace | undefined {
    try {
      const runTrace = this.runTracer.startRun({
        runId: input.runId,
        correlationId: input.correlationId,
        featureId: input.featureId,
        sensitivity: 'standard',
        incomingTraceContext,
      });
      this.runTraces.set(input.runId, runTrace);
      return runTrace;
    } catch {
      this.reportTraceError('run-trace-start');
      return undefined;
    }
  }

  removeRunTrace(runId: string): void {
    this.runTraces.delete(runId);
  }

  endRun(runId: string, terminalState: CopilotTerminalState): void {
    const runTrace = this.runTraces.get(runId);
    if (!runTrace) return;
    try {
      runTrace.end(terminalState);
    } catch {
      this.reportTraceError('run-trace-end');
    }
  }

  ensureRun(record: CopilotRunRecord): void {
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

  async withTraceContext<T>(
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
    let operationSettled = false;
    let operationSucceeded = false;
    let operationResult: T | undefined;
    let operationError: unknown;
    try {
      return await runTrace.runOperation(operationName, (traceContext) => {
        operationStarted = true;
        return runWithCarrier(traceContext).then(
          (result) => {
            operationResult = result;
            operationSucceeded = true;
            operationSettled = true;
            return result;
          },
          (error: unknown) => {
            operationError = error;
            operationSettled = true;
            throw error;
          },
        );
      });
    } catch (error) {
      if (operationSettled) {
        if (operationSucceeded) return operationResult as T;
        throw operationError;
      }
      if (operationStarted) throw error;
      this.reportTraceError('run-trace-operation');
      return runWithCarrier(record.traceContext);
    }
  }

  emitLifecycle(record: CopilotRunRecord): void {
    try {
      const disposition = this.mapperFor(record).mapLifecycle(record);
      if (!disposition.accepted) return;
      this.dispatch(disposition.event);
      if (record.state === 'cleaned_up') {
        this.eventMappers.delete(record.runId);
        this.runTraces.delete(record.runId);
      }
    } catch {
      this.reportSafeError('run-event-map-lifecycle', 'lifecycle_conflict');
    }
  }

  emitNative(record: CopilotRunRecord, event: SessionEvent): void {
    try {
      const disposition = this.mapperFor(record).mapNative(event);
      if (disposition.accepted) this.dispatch(disposition.event);
    } catch {
      this.reportSafeError('run-event-map-native', 'lifecycle_conflict');
    }
  }

  emitToolAudit(record: CopilotRunRecord, event: HoustonToolAudit): void {
    try {
      const disposition = this.mapperFor(record).mapToolAudit(event);
      if (disposition.accepted) this.dispatch(disposition.event);
    } catch {
      this.reportSafeError('run-event-map-tool-audit', 'lifecycle_conflict');
    }
  }

  forgetListeners(runId: string): void {
    this.listeners.delete(runId);
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

  private reportTraceError(operation: string): void {
    this.safeReport(new Error('Copilot run tracing failed.'), operation);
  }

  private reportSafeError(
    operation: string,
    code: ConstructorParameters<typeof CopilotLifecycleError>[0],
  ): void {
    this.safeReport(new CopilotLifecycleError(code), operation);
  }

  private safeReport(error: unknown, operation: string): void {
    try {
      this.options.reportError(error, operation);
    } catch {
      // Observability must never become part of the durable lifecycle outcome.
    }
  }
}
