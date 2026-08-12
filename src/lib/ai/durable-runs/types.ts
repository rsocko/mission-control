import type {
  AiRunCleanupStatus,
  AiRunFallbackState,
  AiRunSensitivity,
  AiRunStatus,
} from '@/db/schema';

export type DurableAiRunStatus = AiRunStatus;
export type DurableAiRunSensitivity = AiRunSensitivity;
export type DurableAiRunFallbackState = AiRunFallbackState;
export type DurableAiRunCleanupStatus = AiRunCleanupStatus;

export interface DurableAiRun {
  id: string;
  featureId: string;
  sensitivity: DurableAiRunSensitivity;
  status: DurableAiRunStatus;
  executionRoute: string;
  requestedProvider: string | null;
  requestedModel: string | null;
  provider: string | null;
  model: string | null;
  fallbackState: DurableAiRunFallbackState;
  correlationId: string;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  timeoutAt: string;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  notifyOnCompletion: boolean;
  cleanupStatus: DurableAiRunCleanupStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ClaimedDurableAiRun extends DurableAiRun {
  leaseOwner: string;
  leaseExpiresAt: string;
  traceparent: string | null;
  tracestate: string | null;
}

export interface DurableAiRunEvent {
  cursor: number;
  eventId: string;
  runId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateDurableAiRunInput {
  id?: string;
  idempotencyKey: string;
  featureId: string;
  sensitivity: DurableAiRunSensitivity;
  executionRoute: string;
  requestedProvider?: string;
  requestedModel?: string;
  correlationId?: string;
  traceparent?: string;
  tracestate?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  notifyOnCompletion?: boolean;
  now?: Date;
}

export interface AppendDurableAiRunEventInput {
  eventId?: string;
  idempotencyKey: string;
  kind: string;
  payload?: Record<string, unknown>;
  provider?: string;
  model?: string;
  fallbackState?: DurableAiRunFallbackState;
  now?: Date;
}

export interface DurableAiRunHistoryFilter {
  status?: DurableAiRunStatus;
  featureId?: string;
  limit?: number;
  before?: string;
}

export interface DurableAiRunRouteOutcome {
  provider?: string;
  model?: string;
  fallbackState?: DurableAiRunFallbackState;
}

export interface ProtectedProviderSession {
  provider: string;
  reference: string;
  expiresAt: string;
}

export interface DurableAiRunRetentionResult {
  deletedRuns: number;
  revokedProviderSessions: number;
}

export const DURABLE_AI_RUN_TERMINAL_STATUSES = new Set<DurableAiRunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
