import { boolean, jsonb, serial } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import type { tasks } from './tasks';

// ─── CONNECTOR CONFIGS ──────────────────────────────────────────────────────

export const connectorConfigs = pgTable('connector_configs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  syncMode: text('sync_mode').notNull().default('poll'),
  pollIntervalMinutes: integer('poll_interval_minutes').default(5),
  capabilities: jsonb('capabilities').notNull(),
  credentials: jsonb('credentials').notNull().default({}),
  settings: jsonb('settings').notNull().default({}),
  syncedLists: jsonb('synced_lists').notNull().default([]),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const listGroups = pgTable('list_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon'),
  iconColor: text('icon_color'),
  sourceId: text('source_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

// ─── SOURCE LISTS ───────────────────────────────────────────────────────────

export const sourceLists = pgTable('source_lists', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id').notNull(),
  sourceId: text('source_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(), // list | project | repo | folder | board
  taskCount: integer('task_count').notNull().default(0),
  lastSyncedAt: text('last_synced_at'),
  wellKnownListName: text('well_known_list_name'), // flaggedEmails, defaultList, etc.
  groupId: text('group_id').references(() => listGroups.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  hidden: boolean('hidden').notNull().default(false),
  lastKnownRemoteName: text('last_known_remote_name'),
  userDisplayName: text('user_display_name'),
  icon: text('icon'),
  iconColor: text('icon_color'),
});

// ─── WORK MICROSOFT TO DO BRIDGE ────────────────────────────────────────────

export const workTodoBridgeState = pgTable('work_todo_bridge_state', {
  connectorId: text('connector_id').primaryKey(),
  transport: text('transport')
    .$type<'power-automate-standard' | 'power-automate-graph'>()
    .notNull(),
  capabilityProfile: text('capability_profile')
    .$type<'standard-v1' | 'extended-v1'>()
    .notNull(),
  listDeltaLink: text('list_delta_link'),
  resetRequired: boolean('reset_required').notNull().default(false),
  lastIngestAt: text('last_ingest_at'),
  lastIngestMode: text('last_ingest_mode').$type<'snapshot' | 'delta'>(),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workTodoListDeltaState = pgTable('work_todo_list_delta_state', {
  connectorId: text('connector_id').notNull(),
  listSourceId: text('list_source_id').notNull(),
  deltaLink: text('delta_link'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.connectorId, table.listSourceId] }),
  index('idx_work_todo_list_delta_connector').on(table.connectorId),
]);

export const workTodoOutboundChanges = pgTable('work_todo_outbound_changes', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  connectorId: text('connector_id').notNull(),
  taskId: text('task_id').notNull(),
  sourceId: text('source_id').notNull(),
  listSourceId: text('list_source_id').notNull(),
  remoteTaskId: text('remote_task_id').notNull(),
  operation: text('operation').$type<'update' | 'complete' | 'delete'>().notNull(),
  fields: jsonb('fields').$type<Record<string, unknown>>(),
  taskVersion: text('task_version').notNull(),
  status: text('status')
    .$type<'pending' | 'leased' | 'succeeded' | 'failed' | 'superseded'>()
    .notNull()
    .default('pending'),
  leaseId: text('lease_id'),
  leasedAt: text('leased_at'),
  leaseExpiresAt: text('lease_expires_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  acknowledgedAt: text('acknowledged_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_work_todo_change_task_version')
    .on(table.connectorId, table.taskId, table.taskVersion),
  index('idx_work_todo_change_ready')
    .on(table.connectorId, table.status, table.leaseExpiresAt, table.createdAt),
  index('idx_work_todo_change_task').on(table.taskId),
]);

// ─── SYNC LOG ───────────────────────────────────────────────────────────────

export const syncLog = pgTable('sync_log', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  success: boolean('success').notNull(),
  tasksAdded: integer('tasks_added').notNull().default(0),
  tasksUpdated: integer('tasks_updated').notNull().default(0),
  tasksRemoved: integer('tasks_removed').notNull().default(0),
  tasksPushed: integer('tasks_pushed').notNull().default(0),
  localOnlyProtected: integer('local_only_protected').notNull().default(0),
  notificationsAdded: integer('alerts_added').notNull().default(0),
  errors: jsonb('errors').notNull().default([]),
  /** Detailed audit trail: individual task-level actions taken during this sync */
  details: jsonb('details').notNull().default([]),
  syncedAt: text('synced_at').notNull(),
  durationMs: integer('duration_ms'),
  jobId: text('job_id'),
  trigger: text('trigger')
    .$type<'api' | 'schedule' | 'nightly' | 'watchdog' | 'recovery' | 'operator-canary'>(),
  scheduledFor: text('scheduled_for'),
  startedAt: text('started_at'),
  attempt: integer('attempt'),
  maxAttempts: integer('max_attempts'),
  identityMode: text('identity_mode'),
  identityModeRevision: integer('identity_mode_revision'),
}, (table) => [
  index('idx_sync_log_job_id').on(table.jobId),
  index('idx_sync_log_connector_success_synced_at')
    .on(table.connectorId, table.success, table.syncedAt),
  index('idx_sync_log_connector_synced_at')
    .on(table.connectorId, table.syncedAt),
]);

export const syncJobs = pgTable('sync_jobs', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  full: boolean('full').notNull().default(false),
  source: text('source')
    .$type<'api' | 'schedule' | 'nightly' | 'watchdog' | 'recovery' | 'operator-canary'>()
    .notNull(),
  status: text('status')
    .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>()
    .notNull(),
  attempt: integer('attempt').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  availableAt: text('available_at').notNull(),
  scheduledFor: text('scheduled_for').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  cancelRequestedAt: text('cancel_requested_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  result: jsonb('result'),
  error: text('error'),
  durationBudgetMs: integer('duration_budget_ms').notNull().default(300000),
  identityMode: text('identity_mode'),
  identityModeRevision: integer('identity_mode_revision'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_sync_jobs_active_connector')
    .on(table.connectorId, table.status)
    .where(sql`${table.status} IN ('queued', 'running')`),
  index('idx_sync_jobs_claim').on(table.status, table.availableAt, table.createdAt),
  index('idx_sync_jobs_lease').on(table.status, table.leaseExpiresAt),
  index('idx_sync_jobs_completed').on(table.completedAt),
]);

export const connectorOperationLeases = pgTable('connector_operation_leases', {
  connectorId: text('connector_id').primaryKey(),
  operationType: text('operation_type').$type<'sync' | 'retention' | 'transfer'>().notNull(),
  owner: text('owner').notNull(),
  leaseExpiresAt: text('lease_expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_connector_operation_leases_expiry').on(table.leaseExpiresAt),
]);

export const syncJobEvents = pgTable('sync_job_events', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').references(() => syncJobs.id, { onDelete: 'cascade' }),
  connectorId: text('connector_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_sync_job_events_cursor').on(table.id),
  index('idx_sync_job_events_job').on(table.jobId, table.id),
]);

export const runtimeTelemetry = pgTable('runtime_telemetry', {
  role: text('role').$type<'web' | 'worker'>().primaryKey(),
  instanceId: text('instance_id').notNull(),
  pid: integer('pid').notNull(),
  startedAt: text('started_at').notNull(),
  heartbeatAt: text('heartbeat_at').notNull(),
  metrics: jsonb('metrics').notNull(),
});

export const runtimeTelemetryInstances = pgTable('runtime_telemetry_instances', {
  instanceId: text('instance_id').primaryKey(),
  role: text('role').$type<'web' | 'worker'>().notNull(),
  pid: integer('pid').notNull(),
  startedAt: text('started_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  stoppedAt: text('stopped_at'),
  terminalReason: text('terminal_reason'),
  restartCount: integer('restart_count'),
  buildSha: text('build_sha'),
  runtimeMode: text('runtime_mode').notNull(),
  highWaterMetrics: jsonb('high_water_metrics').notNull(),
  terminalMetrics: jsonb('terminal_metrics'),
}, (table) => [
  index('idx_runtime_instances_role_started').on(table.role, table.startedAt),
  index('idx_runtime_instances_last_seen').on(table.lastSeenAt),
]);

export const runtimeTelemetrySamples = pgTable('runtime_telemetry_samples', {
  id: serial('id').primaryKey(),
  role: text('role').$type<'web' | 'worker'>().notNull(),
  instanceId: text('instance_id').notNull(),
  pid: integer('pid').notNull(),
  sampledAt: text('sampled_at').notNull(),
  resolutionSeconds: integer('resolution_seconds').notNull().default(10),
  metrics: jsonb('metrics').notNull(),
}, (table) => [
  uniqueIndex('idx_runtime_samples_instance_time_resolution')
    .on(table.instanceId, table.sampledAt, table.resolutionSeconds),
  index('idx_runtime_samples_role_time').on(table.role, table.sampledAt),
  index('idx_runtime_samples_time').on(table.sampledAt),
  index('idx_runtime_telemetry_samples_time').on(table.sampledAt),
  index('idx_runtime_telemetry_samples_role_time').on(table.role, table.sampledAt),
  index('idx_runtime_telemetry_samples_role_id').on(table.role, table.id),
]);

export const workerHealthSnapshot = pgTable('worker_health_snapshot', {
  id: text('id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  generatedAt: text('generated_at').notNull(),
  workerInstanceId: text('worker_instance_id').notNull(),
  workerRevision: text('worker_revision').notNull(),
  generationDurationMs: integer('generation_duration_ms').notNull(),
  payload: jsonb('payload').notNull(),
});

export const syncSchedules = pgTable('sync_schedules', {
  connectorId: text('connector_id').primaryKey(),
  intervalMinutes: integer('interval_minutes').notNull(),
  nextDueAt: text('next_due_at').notNull(),
  lastEnqueuedAt: text('last_enqueued_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_sync_schedules_next_due').on(table.nextDueAt),
]);

export const connectorSyncControls = pgTable('connector_sync_controls', {
  connectorId: text('connector_id')
    .primaryKey()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  schedulerState: text('scheduler_state')
    .$type<'scheduled' | 'quarantined'>()
    .notNull()
    .default('scheduled'),
  quarantineId: text('quarantine_id'),
  quarantinedAt: text('quarantined_at'),
  releasedAt: text('released_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_connector_sync_controls_state').on(table.schedulerState, table.updatedAt),
]);

export const connectorSyncOperatorRuns = pgTable('connector_sync_operator_runs', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  quarantineId: text('quarantine_id'),
  operation: text('operation')
    .$type<'quarantine' | 'canary' | 'release' | 'rollback'>()
    .notNull(),
  actorType: text('actor_type').$type<'parent-admin' | 'service'>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  jobId: text('job_id').references(() => syncJobs.id, { onDelete: 'set null' }),
  resultCode: text('result_code').notNull(),
  cancelledQueuedCount: integer('cancelled_queued_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_connector_sync_operator_idempotency')
    .on(table.connectorId, table.idempotencyKey),
  uniqueIndex('idx_connector_sync_operator_canary')
    .on(table.connectorId, table.quarantineId, table.operation)
    .where(sql`${table.operation} = 'canary'`),
  index('idx_connector_sync_operator_connector')
    .on(table.connectorId, table.createdAt),
]);

export const syncDeletionCandidates = pgTable('sync_deletion_candidates', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  taskId: text('task_id').notNull(),
  sourceId: text('source_id').notNull(),
  firstMissingAt: text('first_missing_at').notNull(),
  lastMissingAt: text('last_missing_at').notNull(),
  missingCount: integer('missing_count').notNull().default(1),
  identityMode: text('identity_mode'),
  identityModeRevision: integer('identity_mode_revision'),
  issueEntityId: text('issue_entity_id'),
  repositoryEntityId: text('repository_entity_id'),
  hostKey: text('host_key'),
  locatorRevision: integer('locator_revision'),
  bindingState: text('binding_state'),
  bindingRevision: text('binding_revision'),
}, (table) => [
  uniqueIndex('idx_sync_deletion_candidate_source').on(table.connectorId, table.sourceId),
  index('idx_sync_deletion_candidate_task').on(table.taskId),
  index('idx_sync_deletion_candidate_fence')
    .on(table.connectorId, table.identityModeRevision, table.issueEntityId),
]);

export const syncDeletionSnapshots = pgTable('sync_deletion_snapshots', {
  id: text('id').primaryKey(),
  originalTaskId: text('original_task_id').notNull(),
  connectorId: text('connector_id').notNull(),
  sourceId: text('source_id').notNull(),
  taskTitle: text('task_title').notNull(),
  reason: text('reason').notNull(),
  taskData: jsonb('task_data').$type<typeof tasks.$inferSelect>().notNull(),
  relationshipData: jsonb('relationship_data').$type<Record<string, unknown>>().notNull(),
  deletedAt: text('deleted_at').notNull(),
  restoredAt: text('restored_at'),
  restoredTaskId: text('restored_task_id'),
  restoreMode: text('restore_mode').$type<'local' | 'source'>(),
  identityMode: text('identity_mode'),
  identityModeRevision: integer('identity_mode_revision'),
  issueEntityId: text('issue_entity_id'),
  repositoryEntityId: text('repository_entity_id'),
  hostKey: text('host_key'),
  locatorRevision: integer('locator_revision'),
  bindingState: text('binding_state'),
  bindingRevision: text('binding_revision'),
  recoveryState: text('recovery_state').notNull().default('pending'),
  recoveryClaimToken: text('recovery_claim_token'),
  recoveryValidation: text('recovery_validation'),
  quarantineReason: text('quarantine_reason'),
  recoveryClaimedAt: text('recovery_claimed_at'),
}, (table) => [
  index('idx_sync_deletion_snapshot_task').on(table.originalTaskId),
  index('idx_sync_deletion_snapshot_deleted').on(table.deletedAt),
  index('idx_sync_deletion_snapshot_recovery')
    .on(table.connectorId, table.recoveryState, table.deletedAt),
]);

export const dependencyReconciliationSnapshots = pgTable(
  'dependency_reconciliation_snapshots',
  {
    id: text('id').primaryKey(),
    connectorInstanceId: text('connector_instance_id').notNull(),
    status: text('status')
      .$type<'running' | 'failed' | 'partial' | 'completed'>()
      .notNull(),
    phase: text('phase')
      .$type<'collecting' | 'ready' | 'reconciling' | 'completed'>()
      .notNull()
      .default('reconciling'),
    readMode: text('read_mode').$type<'graphql-bulk' | 'rest-fallback' | 'legacy'>(),
    cursor: integer('cursor').notNull().default(0),
    total: integer('total').notNull(),
    batchSize: integer('batch_size').notNull(),
    failureCount: integer('failure_count').notNull().default(0),
    importedCount: integer('imported_count').notNull().default(0),
    removedCount: integer('removed_count').notNull().default(0),
    startedAt: text('started_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
    collectionCompletedAt: text('collection_completed_at'),
    collectionPageCount: integer('collection_page_count').notNull().default(0),
    overflowFetchCount: integer('overflow_fetch_count').notNull().default(0),
    identityMode: text('identity_mode').notNull().default('stable'),
    identityModeRevision: integer('identity_mode_revision').notNull().default(0),
    identityEvidenceSource: text('identity_evidence_source')
      .$type<'graphql-node' | 'rest-unavailable' | 'legacy-unavailable'>()
      .notNull()
      .default('legacy-unavailable'),
    identityEvidenceEligible: boolean('identity_evidence_eligible')
      .notNull()
      .default(false),
    identityEvidenceFailureReason: text('identity_evidence_failure_reason'),
    failedAt: text('failed_at'),
    nextAttemptAt: text('next_attempt_at'),
    failureReason: text('failure_reason'),
    lastResumeAttemptAt: text('last_resume_attempt_at'),
    lastResumeOutcome: text('last_resume_outcome')
      .$type<'advanced' | 'deferred' | 'failed'>(),
    lastResumeReason: text('last_resume_reason'),
  },
  (table) => [
    uniqueIndex('idx_dependency_snapshot_active_connector')
      .on(table.connectorInstanceId)
      .where(sql`${table.status} IN ('running', 'failed')`),
    index('idx_dependency_snapshot_connector_updated')
      .on(table.connectorInstanceId, table.updatedAt),
    index('idx_dependency_snapshot_connector_status_completed')
      .on(table.connectorInstanceId, table.status, table.completedAt),
    index('idx_dependency_snapshot_resume')
      .on(table.status, table.nextAttemptAt),
  ],
);

export const dependencyReconciliationItems = pgTable(
  'dependency_reconciliation_items',
  {
    snapshotId: text('snapshot_id').notNull()
      .references(() => dependencyReconciliationSnapshots.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    sourceId: text('source_id').notNull(),
    verified: boolean('verified').notNull().default(false),
    identityEvidence: jsonb('identity_evidence')
      .$type<ExternalIdentityEvidence>(),
    identityEvidenceState: text('identity_evidence_state')
      .$type<'verified' | 'missing' | 'partial'>()
      .notNull()
      .default('missing'),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.position] }),
    uniqueIndex('idx_dependency_snapshot_item_source')
      .on(table.snapshotId, table.sourceId),
  ],
);

export const dependencyReconciliationEdges = pgTable(
  'dependency_reconciliation_edges',
  {
    snapshotId: text('snapshot_id').notNull()
      .references(() => dependencyReconciliationSnapshots.id, { onDelete: 'cascade' }),
    blockerSourceId: text('blocker_source_id').notNull(),
    blockedSourceId: text('blocked_source_id').notNull(),
    blockerIdentityEvidence: jsonb('blocker_identity_evidence')
      .$type<ExternalIdentityEvidence>(),
    blockerIdentityEvidenceState: text('blocker_identity_evidence_state')
      .$type<'verified' | 'missing' | 'partial'>()
      .notNull()
      .default('missing'),
  },
  (table) => [
    primaryKey({
      columns: [
        table.snapshotId,
        table.blockerSourceId,
        table.blockedSourceId,
      ],
    }),
    index('idx_dependency_snapshot_edge_blocked')
      .on(table.snapshotId, table.blockedSourceId),
  ],
);

export const dependencyReconciliationCandidates = pgTable(
  'dependency_reconciliation_candidates',
  {
    snapshotId: text('snapshot_id').notNull()
      .references(() => dependencyReconciliationSnapshots.id, { onDelete: 'cascade' }),
    dependencyId: text('dependency_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.dependencyId] }),
    index('idx_dependency_snapshot_candidate_dependency').on(table.dependencyId),
  ],
);

// ─── INTEGRATIONS ─────────────────────────────────────────────────────────────

export const outboundWebhooks = pgTable('outbound_webhooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secret: text('secret'),
  eventTypes: jsonb('event_types').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  lastTriggeredAt: text('last_triggered_at'),
  lastStatus: integer('last_status'),
  createdAt: text('created_at').notNull(),
});

export const integrationConfigs = pgTable('integration_configs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  apiKey: text('api_key'),
  enabled: boolean('enabled').notNull().default(true),
  settings: jsonb('settings').notNull().default({}),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── INBOUND WEBHOOKS ─────────────────────────────────────────────────────────

export const inboundWebhooks = pgTable('inbound_webhooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Label shown in task/alert source attribution (e.g. "Home Server", "n8n", "IFTTT") */
  sourceLabel: text('source_label').notNull().default('webhook'),
  /** HMAC-SHA256 secret for verifying inbound payloads */
  secret: text('secret'),
  enabled: boolean('enabled').notNull().default(true),
  /** What to create: 'task', 'alert', or 'auto' (infer from payload) */
  defaultAction: text('default_action').notNull().default('auto'),
  /** JSON path mappings for extracting fields from arbitrary payloads */
  fieldMappings: jsonb('field_mappings').notNull().default({}),
  /** Total number of payloads received */
  totalReceived: integer('total_received').notNull().default(0),
  lastReceivedAt: text('last_received_at'),
  lastStatus: integer('last_status'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const inboundWebhookLog = pgTable('inbound_webhook_log', {
  id: text('id').primaryKey(),
  webhookId: text('webhook_id').notNull(),
  /** 'success' | 'auth_failed' | 'parse_error' | 'error' */
  status: text('status').notNull(),
  /** HTTP status code returned */
  httpStatus: integer('http_status').notNull(),
  /** What was created: 'task', 'alert', or null if nothing */
  createdType: text('created_type'),
  /** ID of the created task or alert */
  createdId: text('created_id'),
  /** Error message if failed */
  errorMessage: text('error_message'),
  /** First 2KB of the incoming payload for debugging */
  payloadPreview: text('payload_preview'),
  receivedAt: text('received_at').notNull(),
});

export const inboundWebhookReplays = pgTable('inbound_webhook_replays', {
  id: text('id').primaryKey(),
  webhookId: text('webhook_id').notNull(),
  deliveryKey: text('delivery_key').notNull(),
  receivedAt: text('received_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  uniqueIndex('idx_inbound_webhook_replays_delivery')
    .on(table.webhookId, table.deliveryKey),
  index('idx_inbound_webhook_replays_expiry').on(table.expiresAt),
]);

/**
 * Audit trail for list fix operations (emoji bug fixes, migrations, renames).
 * Stores full before/after state to enable undo and traceability.
 */
export const listFixAuditLog = pgTable('list_fix_audit_log', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  strategy: text('strategy').notNull(), // 'strip-emoji' | 'migrate'
  status: text('status').notNull(), // 'completed' | 'partial' | 'failed' | 'undone'
  // Original list state
  originalListId: text('original_list_id').notNull(),
  originalSourceId: text('original_source_id').notNull(),
  originalName: text('original_name').notNull(),
  originalGroupId: text('original_group_id'),
  connectorInstanceId: text('connector_instance_id').notNull(),
  // New list state (for migrate strategy)
  newListId: text('new_list_id'),
  newName: text('new_name').notNull(),
  // Task snapshot (JSON array of {id, title, status, dueDate?})
  taskSnapshot: jsonb('task_snapshot'),
  // Move results (JSON array of {taskId, newTaskId?, success, error?})
  moveResults: jsonb('move_results'),
  // Summary stats
  tasksTotal: integer('tasks_total').notNull().default(0),
  tasksMoved: integer('tasks_moved').notNull().default(0),
  tasksFailed: integer('tasks_failed').notNull().default(0),
  oldListDeleted: boolean('old_list_deleted').notNull().default(false),
  // Undo state
  undoneAt: text('undone_at'),
  undoNotes: text('undo_notes'),
});

// --- APP SETTINGS (key-value for global config) --------------------------------

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
