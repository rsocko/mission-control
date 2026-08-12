import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

export const externalAgents = sqliteTable('external_agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').$type<ExternalAgentType>().notNull(),
  transport: text('transport').$type<ExternalAgentTransport>().notNull(),
  executionLocality: text('execution_locality').$type<ExternalAgentLocality>().notNull(),
  description: text('description'),
  endpoint: text('endpoint'),
  authType: text('auth_type').$type<ExternalAgentAuthType>().notNull().default('none'),
  authCredentialRef: text('auth_credential_ref'),
  capabilities: text('capabilities', { mode: 'json' })
    .$type<ExternalAgentCapabilities>()
    .notNull()
    .default({}),
  inputFormat: text('input_format').notNull().default('mc-tasks'),
  outputFormat: text('output_format').notNull().default('mc-tasks'),
  inboundWebhookId: text('inbound_webhook_id'),
  dataPolicy: text('data_policy', { mode: 'json' })
    .$type<ExternalAgentDataPolicy>()
    .notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_external_agents_enabled').on(table.enabled, table.deletedAt),
  index('idx_external_agents_transport').on(table.transport),
]);

export const agentDispatches = sqliteTable('agent_dispatches', {
  id: text('id').primaryKey(),
  externalAgentId: text('external_agent_id')
    .notNull()
    .references(() => externalAgents.id),
  idempotencyKey: text('idempotency_key').notNull(),
  instruction: text('instruction').notNull(),
  scope: text('scope', { mode: 'json' }).$type<AgentDispatchScope>().notNull(),
  status: text('status').$type<AgentDispatchStatus>().notNull(),
  transport: text('transport').$type<ExternalAgentTransport>().notNull(),
  executionLocality: text('execution_locality').$type<ExternalAgentLocality>().notNull(),
  dataClassification: text('data_classification').$type<AgentDataClassification>().notNull(),
  allowedActions: text('allowed_actions', { mode: 'json' }).$type<string[]>().notNull(),
  disclosedFields: text('disclosed_fields', { mode: 'json' }).$type<string[]>().notNull(),
  payloadPreview: text('payload_preview', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  previewHash: text('preview_hash').notNull(),
  providerTaskId: text('provider_task_id'),
  providerDetail: text('provider_detail', { mode: 'json' }).$type<Record<string, unknown>>(),
  result: text('result', { mode: 'json' }).$type<AgentDispatchResult>(),
  resultDigest: text('result_digest'),
  resultStatus: text('result_status').$type<AgentResultStatus>(),
  claimTokenHash: text('claim_token_hash'),
  claimedAt: text('claimed_at'),
  leaseExpiresAt: text('lease_expires_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  availableAt: text('available_at').notNull(),
  deadlineAt: text('deadline_at'),
  cancelRequestedAt: text('cancel_requested_at'),
  githubIssueUrl: text('github_issue_url'),
  githubPullRequestUrl: text('github_pull_request_url'),
  repository: text('repository'),
  baseRef: text('base_ref'),
  branchRef: text('branch_ref'),
  commitSha: text('commit_sha'),
  checks: text('checks', { mode: 'json' }).$type<AgentResultReference[]>(),
  artifacts: text('artifacts', { mode: 'json' }).$type<AgentResultReference[]>(),
  errorMessage: text('error_message'),
  confirmedAt: text('confirmed_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  reviewedAt: text('reviewed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_agent_dispatches_agent_idempotency')
    .on(table.externalAgentId, table.idempotencyKey),
  index('idx_agent_dispatches_status_available')
    .on(table.status, table.availableAt, table.createdAt),
  index('idx_agent_dispatches_lease').on(table.status, table.leaseExpiresAt),
  index('idx_agent_dispatches_provider_task').on(table.providerTaskId),
  index('idx_agent_dispatches_completed').on(table.completedAt),
]);

export const agentDispatchAttempts = sqliteTable('agent_dispatch_attempts', {
  id: text('id').primaryKey(),
  dispatchId: text('dispatch_id')
    .notNull()
    .references(() => agentDispatches.id, { onDelete: 'cascade' }),
  attemptNumber: integer('attempt_number').notNull(),
  status: text('status').notNull(),
  providerTaskId: text('provider_task_id'),
  providerDetail: text('provider_detail', { mode: 'json' }).$type<Record<string, unknown>>(),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_agent_dispatch_attempt_number').on(table.dispatchId, table.attemptNumber),
  index('idx_agent_dispatch_attempt_status').on(table.status, table.startedAt),
]);

export const agentDispatchEvents = sqliteTable('agent_dispatch_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dispatchId: text('dispatch_id')
    .notNull()
    .references(() => agentDispatches.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  fromStatus: text('from_status').$type<AgentDispatchStatus>(),
  toStatus: text('to_status').$type<AgentDispatchStatus>(),
  detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_agent_dispatch_events_dispatch').on(table.dispatchId, table.id),
  index('idx_agent_dispatch_events_created').on(table.createdAt),
]);
