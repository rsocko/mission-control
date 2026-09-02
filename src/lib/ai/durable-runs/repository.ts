import type {
  AppendDurableAiRunEventInput,
  ClaimedDurableAiRun,
  CreateDurableAiRunInput,
  DurableAiRun,
  DurableAiRunEvent,
  DurableAiRunFallbackState,
  DurableAiRunHistoryFilter,
  DurableAiRunRetentionResult,
  DurableAiRunRouteOutcome,
  DurableAiRunStatus,
  ProtectedProviderSession,
} from './types';

export interface InternalDurableAiRun extends DurableAiRun {
  idempotencyKey: string;
  requestFingerprint: string;
  traceparent: string | null;
  tracestate: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  executionState: Record<string, unknown> | null;
}

export interface ProviderSessionWriteOptions {
  expiresAt?: Date;
  now?: Date;
}

export interface DurableAiRunFailureOptions {
  retryable?: boolean;
  code?: string;
  outcome?: DurableAiRunRouteOutcome;
  now?: Date;
}

export interface DurableAiRunInitializeStateOptions {
  expectedRevision: number;
  status?: DurableAiRunStatus;
  traceparent?: string;
  tracestate?: string;
  owner?: string;
  leaseExpiresAt?: string;
  providerSession?: {
    provider: string;
    reference: string;
    expiresAt?: Date;
  };
  now?: Date;
}

export interface DurableAiRunCompareAndSetOptions {
  status?: DurableAiRunStatus;
  traceparent?: string;
  tracestate?: string;
  owner?: string | null;
  leaseExpiresAt?: string | null;
  completedAt?: string | null;
  cleanupStatus?: DurableAiRun['cleanupStatus'];
  provider?: string;
  model?: string;
  fallbackState?: DurableAiRunFallbackState;
  providerSession?: {
    provider: string;
    reference: string;
    expiresAt?: Date;
  };
  revokeProviderSession?: boolean;
  allowedCurrentStatuses?: readonly DurableAiRunStatus[];
  cancellation?: 'absent' | 'requested';
  requiredLeaseOwner?: string;
  leaseState?: 'active' | 'expired';
  now?: Date;
}

export interface DurableAiRunRepository {
  createRun(input: CreateDurableAiRunInput): Promise<{
    run: DurableAiRun;
    created: boolean;
  }>;
  getRun(runId: string): Promise<DurableAiRun | null>;
  getInternalRun(runId: string): Promise<InternalDurableAiRun | null>;
  listInternalRunsByRoute(executionRoute: string): Promise<InternalDurableAiRun[]>;
  listRuns(filter?: DurableAiRunHistoryFilter): Promise<DurableAiRun[]>;
  getEventsAfter(
    runId: string,
    cursor?: number,
    limit?: number,
  ): Promise<DurableAiRunEvent[]>;
  getEventIdempotencyKeys(runId: string): Promise<string[]>;
  appendEvent(
    runId: string,
    input: AppendDurableAiRunEventInput,
  ): Promise<DurableAiRunEvent>;
  appendEventForClaim(
    runId: string,
    owner: string,
    attempt: number,
    input: AppendDurableAiRunEventInput,
  ): Promise<DurableAiRunEvent>;
  appendEventForExecutionOwner(
    runId: string,
    owner: string,
    input: AppendDurableAiRunEventInput,
    receivedAt?: Date,
  ): Promise<DurableAiRunEvent>;
  claimNextRun(
    owner: string,
    routes: readonly string[],
    leaseMs?: number,
    now?: Date,
  ): Promise<ClaimedDurableAiRun | null>;
  renewLease(
    runId: string,
    owner: string,
    leaseMs?: number,
    now?: Date,
  ): Promise<boolean>;
  isCancellationRequested(runId: string, owner?: string): Promise<boolean>;
  requestCancellation(runId: string, now?: Date): Promise<DurableAiRun | null>;
  retryRun(
    runId: string,
    commandIdempotencyKey: string,
    now?: Date,
  ): Promise<DurableAiRun | null>;
  completeRun(
    runId: string,
    owner: string,
    outcome?: DurableAiRunRouteOutcome,
    now?: Date,
  ): Promise<DurableAiRun>;
  cancelRun(runId: string, owner: string, now?: Date): Promise<DurableAiRun>;
  timeOutRun(runId: string, owner: string, now?: Date): Promise<DurableAiRun>;
  failRun(
    runId: string,
    owner: string,
    error: unknown,
    options?: DurableAiRunFailureOptions,
  ): Promise<DurableAiRun>;
  expireTimedOutQueuedRuns(now?: Date): Promise<number>;
  recoverExpiredRuns(now?: Date, routes?: readonly string[]): Promise<number>;
  setProviderSession(
    runId: string,
    provider: string,
    reference: string,
    options?: ProviderSessionWriteOptions,
  ): Promise<ProtectedProviderSession>;
  setProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    provider: string,
    reference: string,
    options?: ProviderSessionWriteOptions,
  ): Promise<ProtectedProviderSession>;
  getProviderSession(
    runId: string,
    now?: Date,
  ): Promise<ProtectedProviderSession | null>;
  getProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    now?: Date,
  ): Promise<ProtectedProviderSession | null>;
  revokeProviderSession(runId: string, now?: Date): Promise<boolean>;
  revokeProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    now?: Date,
  ): Promise<boolean>;
  claimCleanup(
    owner: string,
    routes: readonly string[],
    leaseMs?: number,
    now?: Date,
  ): Promise<ClaimedDurableAiRun | null>;
  renewCleanupLease(
    runId: string,
    owner: string,
    leaseMs?: number,
    now?: Date,
  ): Promise<boolean>;
  finishCleanup(
    runId: string,
    owner: string,
    error?: unknown,
    now?: Date,
  ): Promise<DurableAiRun>;
  initializeExecutionState(
    runId: string,
    state: Record<string, unknown>,
    options: DurableAiRunInitializeStateOptions,
  ): Promise<boolean>;
  compareAndSetExecutionState(
    runId: string,
    expectedRevision: number,
    state: Record<string, unknown>,
    options?: DurableAiRunCompareAndSetOptions,
  ): Promise<boolean>;
  pruneExpired(now?: Date): Promise<DurableAiRunRetentionResult>;
}
