import type {
  AgentDataClassification,
  AgentDispatchDetail,
  AgentDispatchRecord,
  AgentDispatchResult,
  AgentDispatchScope,
  AgentDispatchStatus,
  AgentPayloadSnapshot,
  AgentResultReference,
  AgentResultStatus,
  ExternalAgentRecord,
} from '@/lib/external-agents/contracts';

export type ExternalAgentCreateRecord = ExternalAgentRecord;
export type ExternalAgentUpdateRecord = Omit<ExternalAgentRecord, 'id' | 'createdAt'>;

export interface DispatchEventInput {
  eventType: string;
  fromStatus: AgentDispatchStatus | null;
  toStatus: AgentDispatchStatus | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface DispatchFinalizeInput {
  dispatchId: string;
  attempt: number;
  leaseExpiresAt: string;
  status: Extract<
    AgentDispatchStatus,
    'queued' | 'in_progress' | 'waiting_for_user' | 'completed' | 'failed'
  >;
  providerTaskId?: string;
  providerDetail?: Record<string, unknown>;
  result?: AgentDispatchResult;
  resultDigest: string | null;
  resultStatus: AgentResultStatus | null;
  errorMessage: string | null;
  repository: string | null;
  baseRef: string | null;
  branchRef: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  checks?: AgentResultReference[];
  artifacts?: AgentResultReference[];
  providerState?: string;
  now: string;
}

export interface DispatchResultPersistenceInput extends Omit<
  DispatchFinalizeInput,
  'attempt' | 'resultDigest' | 'resultStatus'
> {
  digest: string;
  authorization: { claimTokenHash?: string; agentAuthenticated?: boolean };
  leaseExpiresAt: string;
}

export interface ExternalAgentControlPersistence {
  registry: {
    list(options?: { includeDeleted?: boolean }): Promise<ExternalAgentRecord[]>;
    get(id: string, includeDeleted?: boolean): Promise<ExternalAgentRecord | null>;
    create(record: ExternalAgentCreateRecord): Promise<ExternalAgentRecord>;
    update(id: string, record: ExternalAgentUpdateRecord): Promise<ExternalAgentRecord | null>;
    softDelete(id: string, now: string): Promise<boolean>;
  };
  payloads: {
    snapshot(scope: AgentDispatchScope): Promise<AgentPayloadSnapshot>;
  };
  dispatches: {
    get(id: string): Promise<AgentDispatchDetail | null>;
    list(options?: {
      status?: AgentDispatchStatus;
      agentId?: string;
      limit?: number;
    }): Promise<AgentDispatchRecord[]>;
    findPreview(agentId: string, idempotencyKey: string): Promise<{
      id: string;
      previewHash: string;
    } | null>;
    createPreview(
      record: AgentDispatchRecord,
      event: DispatchEventInput,
    ): Promise<{ id: string; previewHash: string; created: boolean }>;
    confirm(input: {
      id: string;
      agentId: string;
      agentSnapshot: Pick<
        ExternalAgentRecord,
        | 'type'
        | 'transport'
        | 'executionLocality'
        | 'endpoint'
        | 'authType'
        | 'authCredentialRef'
        | 'inboundWebhookId'
        | 'capabilities'
        | 'dataPolicy'
        | 'enabled'
        | 'deletedAt'
      >;
      previewHash: string;
      currentPreviewHash: string;
      maxRequestsPerMinute: number;
      now: string;
    }): Promise<boolean>;
    beginAttempt(input: {
      id: string;
      attemptId: string;
      now: string;
      leaseExpiresAt: string;
    }): Promise<{
      attempt: number;
      leaseExpiresAt: string;
      payload: Record<string, unknown>;
    } | null>;
    resumeAttempt(input: {
      id: string;
      now: string;
      leaseExpiresAt: string;
    }): Promise<{
      attempt: number;
      leaseExpiresAt: string;
      payload: Record<string, unknown>;
    } | null>;
    finalizeAttempt(input: DispatchFinalizeInput): Promise<'updated' | 'stale' | 'expired'>;
    claimNext(input: {
      agentId: string;
      attemptId: string;
      claimTokenHash: string;
      now: string;
      leaseExpiresAt: string;
    }): Promise<{
      dispatchId: string;
      attempt: number;
      leaseExpiresAt: string;
      payload: Record<string, unknown>;
    } | null>;
    submitResult(input: DispatchResultPersistenceInput): Promise<{
      duplicate: boolean;
      status: AgentDispatchStatus;
      expired?: boolean;
    }>;
    cancel(id: string, now: string): Promise<boolean>;
    retry(input: {
      id: string;
      agentId: string;
      maxRequestsPerMinute: number;
      now: string;
      executionLocality: string;
    }): Promise<void>;
    markWaiting(id: string, detail: Record<string, unknown>, now: string): Promise<void>;
    expire(now: string): Promise<number>;
    review(
      id: string,
      decision: Exclude<AgentResultStatus, 'pending_review'>,
      now: string,
    ): Promise<void>;
    cleanup(now: string): Promise<number>;
  };
}
