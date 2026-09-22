import type {
  CopilotClientOptions,
  ResumeSessionConfig,
  SessionConfig,
} from '@github/copilot-sdk';
import type {
  HoustonToolPolicy,
} from './copilot-houston-tools';
import type {
  CopilotTraceContextCarrier,
  HoustonRunEvent,
  HoustonRunEventCursor,
  HoustonRunEventSink,
  W3CTraceContext,
} from './copilot-run-events';
import type { HoustonRunTracer } from './copilot-run-tracing';

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

export interface CopilotLifecycleSession {
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

export type CopilotLifecycleClientFactory = (
  options: CopilotClientOptions,
) => CopilotLifecycleClient;

export function cloneCopilotRun(
  record: CopilotRunRecord,
): CopilotRunSnapshot {
  return { ...record };
}

export function validateCopilotLifecycleOptions(
  options: CopilotLifecycleOptions,
): void {
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
