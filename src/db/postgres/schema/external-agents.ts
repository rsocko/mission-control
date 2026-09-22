import { boolean, jsonb, serial } from 'drizzle-orm/pg-core';
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  EXTERNAL_AGENT_TYPES,
  EXTERNAL_AGENT_TRANSPORTS,
  EXTERNAL_AGENT_LOCALITIES,
  EXTERNAL_AGENT_AUTH_TYPES,
  AGENT_DATA_CLASSIFICATIONS,
  AGENT_DISPATCH_STATUSES,
  AGENT_RESULT_STATUSES,
  type ExternalAgentType,
  type ExternalAgentTransport,
  type ExternalAgentLocality,
  type ExternalAgentAuthType,
  type ExternalAgentCapabilities,
  type ExternalAgentDataPolicy,
  type AgentDataClassification,
  type AgentDispatchScope,
  type AgentDispatchStatus,
  type AgentDispatchResult,
  type AgentResultReference,
  type AgentResultStatus,
} from '@/lib/external-agents/contracts';

export {
  EXTERNAL_AGENT_TYPES,
  EXTERNAL_AGENT_TRANSPORTS,
  EXTERNAL_AGENT_LOCALITIES,
  EXTERNAL_AGENT_AUTH_TYPES,
  AGENT_DATA_CLASSIFICATIONS,
  AGENT_DISPATCH_STATUSES,
  AGENT_RESULT_STATUSES,
};
export type {
  ExternalAgentType,
  ExternalAgentTransport,
  ExternalAgentLocality,
  ExternalAgentAuthType,
  ExternalAgentCapabilities,
  ExternalAgentDataPolicy,
  AgentDataClassification,
  AgentDispatchScope,
  AgentDispatchStatus,
  AgentDispatchResult,
  AgentResultReference,
  AgentResultStatus,
};

export const externalAgents = pgTable('external_agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').$type<ExternalAgentType>().notNull(),
  transport: text('transport').$type<ExternalAgentTransport>().notNull(),
  executionLocality: text('execution_locality').$type<ExternalAgentLocality>().notNull(),
  description: text('description'),
  endpoint: text('endpoint'),
  authType: text('auth_type').$type<ExternalAgentAuthType>().notNull().default('none'),
  authCredentialRef: text('auth_credential_ref'),
  capabilities: jsonb('capabilities')
    .$type<ExternalAgentCapabilities>()
    .notNull()
    .default({}),
  inputFormat: text('input_format').notNull().default('mc-tasks'),
  outputFormat: text('output_format').notNull().default('mc-tasks'),
  inboundWebhookId: text('inbound_webhook_id'),
  dataPolicy: jsonb('data_policy')
    .$type<ExternalAgentDataPolicy>()
    .notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  index('idx_external_agents_enabled').on(table.enabled, table.deletedAt),
  index('idx_external_agents_transport').on(table.transport),
]);

export const agentDispatches = pgTable('agent_dispatches', {
  id: text('id').primaryKey(),
  externalAgentId: text('external_agent_id')
    .notNull()
    .references(() => externalAgents.id),
  idempotencyKey: text('idempotency_key').notNull(),
  instruction: text('instruction').notNull(),
  scope: jsonb('scope').$type<AgentDispatchScope>().notNull(),
  status: text('status').$type<AgentDispatchStatus>().notNull(),
  transport: text('transport').$type<ExternalAgentTransport>().notNull(),
  executionLocality: text('execution_locality').$type<ExternalAgentLocality>().notNull(),
  dataClassification: text('data_classification').$type<AgentDataClassification>().notNull(),
  allowedActions: jsonb('allowed_actions').$type<string[]>().notNull(),
  disclosedFields: jsonb('disclosed_fields').$type<string[]>().notNull(),
  payloadPreview: jsonb('payload_preview').$type<Record<string, unknown>>().notNull(),
  previewHash: text('preview_hash').notNull(),
  providerTaskId: text('provider_task_id'),
  providerDetail: jsonb('provider_detail').$type<Record<string, unknown>>(),
  result: jsonb('result').$type<AgentDispatchResult>(),
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
  checks: jsonb('checks').$type<AgentResultReference[]>(),
  artifacts: jsonb('artifacts').$type<AgentResultReference[]>(),
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

export const agentDispatchAttempts = pgTable('agent_dispatch_attempts', {
  id: text('id').primaryKey(),
  dispatchId: text('dispatch_id')
    .notNull()
    .references(() => agentDispatches.id, { onDelete: 'cascade' }),
  attemptNumber: integer('attempt_number').notNull(),
  status: text('status').notNull(),
  providerTaskId: text('provider_task_id'),
  providerDetail: jsonb('provider_detail').$type<Record<string, unknown>>(),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_agent_dispatch_attempt_number').on(table.dispatchId, table.attemptNumber),
  index('idx_agent_dispatch_attempt_status').on(table.status, table.startedAt),
]);

export const agentDispatchEvents = pgTable('agent_dispatch_events', {
  id: serial('id').primaryKey(),
  dispatchId: text('dispatch_id')
    .notNull()
    .references(() => agentDispatches.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  fromStatus: text('from_status').$type<AgentDispatchStatus>(),
  toStatus: text('to_status').$type<AgentDispatchStatus>(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_agent_dispatch_events_dispatch').on(table.dispatchId, table.id),
  index('idx_agent_dispatch_events_created').on(table.createdAt),
]);
