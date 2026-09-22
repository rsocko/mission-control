export const EXTERNAL_AGENT_TYPES = [
  'copilot-cloud',
  'copilot-sdk-workspace',
  'webhook-roundtrip',
  'mcp',
  'pull-queue',
  'manual',
  'inference',
] as const;

export const EXTERNAL_AGENT_TRANSPORTS = ['push', 'pull', 'mcp', 'manual'] as const;
export const EXTERNAL_AGENT_LOCALITIES = [
  'inference',
  'mission-control-host',
  'github-hosted',
  'external',
] as const;
export const EXTERNAL_AGENT_AUTH_TYPES = [
  'none',
  'bearer',
  'hmac',
  'github-user',
  'github-app',
] as const;
export const AGENT_DATA_CLASSIFICATIONS = ['standard', 'restricted', 'local-only'] as const;
export const AGENT_DISPATCH_STATUSES = [
  'needs_confirmation',
  'queued',
  'claimed',
  'in_progress',
  'waiting_for_user',
  'completed',
  'failed',
  'timed_out',
  'dead_letter',
  'cancelled',
] as const;
export const AGENT_RESULT_STATUSES = [
  'pending_review',
  'accepted',
  'rejected',
  'partial',
] as const;

export type ExternalAgentType = (typeof EXTERNAL_AGENT_TYPES)[number];
export type ExternalAgentTransport = (typeof EXTERNAL_AGENT_TRANSPORTS)[number];
export type ExternalAgentLocality = (typeof EXTERNAL_AGENT_LOCALITIES)[number];
export type ExternalAgentAuthType = (typeof EXTERNAL_AGENT_AUTH_TYPES)[number];
export type AgentDataClassification = (typeof AGENT_DATA_CLASSIFICATIONS)[number];
export type AgentDispatchStatus = (typeof AGENT_DISPATCH_STATUSES)[number];
export type AgentResultStatus = (typeof AGENT_RESULT_STATUSES)[number];

export interface ExternalAgentCapabilities {
  canAnalyzeCode?: boolean;
  canWriteCode?: boolean;
  canRunCommands?: boolean;
  canPush?: boolean;
  canCreatePullRequest?: boolean;
  canProposeTasks?: boolean;
  canProposePhases?: boolean;
}

export interface ExternalAgentDataPolicy {
  allowedClassifications: AgentDataClassification[];
  fieldAllowlist: string[];
  retentionDays: number;
  maxRequestsPerMinute: number;
}

export interface AgentDispatchScope {
  projectId?: string;
  taskIds?: string[];
  repository?: string;
  defaultBranch?: string;
  baseRef?: string;
  createPullRequest?: boolean;
}

export interface AgentResultReference {
  name: string;
  status?: string;
  url?: string;
  mediaType?: string;
}

export interface AgentDispatchResult {
  summary: string;
  tasks?: Array<Record<string, unknown>>;
  phases?: Array<Record<string, unknown>>;
  modifications?: Array<Record<string, unknown>>;
  suggestedClosures?: Array<Record<string, unknown>>;
  codeChange?: {
    repository: string;
    baseRef?: string;
    branchRef?: string;
    commitSha?: string;
    pullRequestUrl?: string;
    checks?: AgentResultReference[];
    artifacts?: AgentResultReference[];
  };
  providerDetail?: Record<string, unknown>;
}

export interface ExternalAgentRecord {
  id: string;
  name: string;
  type: ExternalAgentType;
  transport: ExternalAgentTransport;
  executionLocality: ExternalAgentLocality;
  description: string | null;
  endpoint: string | null;
  authType: ExternalAgentAuthType;
  authCredentialRef: string | null;
  capabilities: ExternalAgentCapabilities;
  inputFormat: string;
  outputFormat: string;
  inboundWebhookId: string | null;
  dataPolicy: ExternalAgentDataPolicy;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AgentDispatchRecord {
  id: string;
  externalAgentId: string;
  idempotencyKey: string;
  instruction: string;
  scope: AgentDispatchScope;
  status: AgentDispatchStatus;
  transport: ExternalAgentTransport;
  executionLocality: ExternalAgentLocality;
  dataClassification: AgentDataClassification;
  allowedActions: string[];
  disclosedFields: string[];
  payloadPreview: Record<string, unknown>;
  previewHash: string;
  providerTaskId: string | null;
  providerDetail: Record<string, unknown> | null;
  result: AgentDispatchResult | null;
  resultDigest: string | null;
  resultStatus: AgentResultStatus | null;
  claimTokenHash: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  deadlineAt: string | null;
  cancelRequestedAt: string | null;
  githubIssueUrl: string | null;
  githubPullRequestUrl: string | null;
  repository: string | null;
  baseRef: string | null;
  branchRef: string | null;
  commitSha: string | null;
  checks: AgentResultReference[] | null;
  artifacts: AgentResultReference[] | null;
  errorMessage: string | null;
  confirmedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDispatchAttemptRecord {
  id: string;
  dispatchId: string;
  attemptNumber: number;
  status: string;
  providerTaskId: string | null;
  providerDetail: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentDispatchEventRecord {
  id: number;
  dispatchId: string;
  eventType: string;
  fromStatus: AgentDispatchStatus | null;
  toStatus: AgentDispatchStatus | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type AgentDispatchDetail = AgentDispatchRecord & {
  attempts: AgentDispatchAttemptRecord[];
  events: AgentDispatchEventRecord[];
};

export interface AgentPayloadSnapshot {
  project?: { id: string; name: string; description: string | null };
  tasks: Array<{
    id: string;
    title: string;
    description: string | null;
    priority: string;
    status: string;
    connectorType: string;
    tags: string[];
  }>;
  phases: Array<{
    name: string;
    description: string | null;
    sortOrder: number;
    taskIds: string[];
  }>;
}
