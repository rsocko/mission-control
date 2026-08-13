import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { connectorConfigs } from './connectors';

export const EXTERNAL_ENTITY_TYPES = ['repository', 'issue'] as const;
export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

export const EXTERNAL_BINDING_TYPES = ['task', 'source_list'] as const;
export type ExternalBindingType = (typeof EXTERNAL_BINDING_TYPES)[number];

export const EXTERNAL_BINDING_STATES = ['shadow', 'active', 'collision', 'retired'] as const;
export type ExternalBindingState = (typeof EXTERNAL_BINDING_STATES)[number];

export const EXTERNAL_LOCATOR_SOURCES = ['graphql', 'rest', 'backfill', 'operator'] as const;
export type ExternalLocatorSource = (typeof EXTERNAL_LOCATOR_SOURCES)[number];

export const GITHUB_IDENTITY_PHASES = [
  'disabled',
  'schema_ready',
  'shadow_write',
  'backfilling',
  'comparing',
  'stable_primary',
  'compatibility',
  'complete',
  'paused',
  'rollback_legacy',
] as const;
export type GitHubIdentityPhase = (typeof GITHUB_IDENTITY_PHASES)[number];

export const GITHUB_IDENTITY_EFFECTIVE_MODES = ['legacy', 'comparison', 'stable'] as const;
export type GitHubIdentityEffectiveMode = (typeof GITHUB_IDENTITY_EFFECTIVE_MODES)[number];

export const GITHUB_IDENTITY_COMPARISON_SURFACES = [
  'source_list',
  'task',
  'project_association',
  'dependency',
  'sub_issue',
  'linked_source',
  'deletion',
  'write_route',
] as const;
export type GitHubIdentityComparisonSurface =
  (typeof GITHUB_IDENTITY_COMPARISON_SURFACES)[number];

export const GITHUB_IDENTITY_COMPARISON_ACTIONS = [
  'create',
  'update',
  'present',
  'delete_candidate',
  'none',
] as const;
export type GitHubIdentityComparisonAction =
  (typeof GITHUB_IDENTITY_COMPARISON_ACTIONS)[number];

export const GITHUB_IDENTITY_COMPARISON_OUTCOMES = [
  'agreement',
  'legacy_fallback',
  'missing_stable_id',
  'collision',
  'stable_legacy_disagree',
  'locator_change',
  'path_reuse',
  'inaccessible',
  'partial_fetch',
] as const;
export type GitHubIdentityComparisonOutcome =
  (typeof GITHUB_IDENTITY_COMPARISON_OUTCOMES)[number];

export const GITHUB_IDENTITY_COMPARISON_REASONS = [
  'exact_match',
  'legacy_only',
  'missing_stable_evidence',
  'multiple_legacy_candidates',
  'multiple_stable_bindings',
  'selected_ids_differ',
  'current_locator_changed',
  'locator_owned_by_other_entity',
  'access_denied',
  'fetch_incomplete',
] as const;
export type GitHubIdentityComparisonReason =
  (typeof GITHUB_IDENTITY_COMPARISON_REASONS)[number];

export const GITHUB_TASK_WRITE_OPERATIONS = [
  'create', 'update', 'complete', 'delete', 'label', 'comment',
  'dependency', 'sub_issue', 'transfer',
] as const;
export type GitHubTaskWriteOperation = (typeof GITHUB_TASK_WRITE_OPERATIONS)[number];

export const GITHUB_TASK_WRITE_LEASE_STATES = [
  'claimed', 'authorized', 'dispatched', 'succeeded', 'failed', 'blocked', 'unknown', 'expired',
] as const;
export type GitHubTaskWriteLeaseState = (typeof GITHUB_TASK_WRITE_LEASE_STATES)[number];

export const GITHUB_WRITE_CYCLE_RECONCILIATION_STATES = [
  'unresolved', 'pre_dispatch_retryable', 'post_dispatch_retryable',
  'resolved', 'superseded', 'quarantined',
] as const;
export type GitHubWriteCycleReconciliationState =
  (typeof GITHUB_WRITE_CYCLE_RECONCILIATION_STATES)[number];

export const GITHUB_IDENTITY_COMPARISON_RUN_STATES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type GitHubIdentityComparisonRunState =
  (typeof GITHUB_IDENTITY_COMPARISON_RUN_STATES)[number];

export const GITHUB_COMPARISON_INTERRUPTION_STATES = [
  'none',
  'unresolved',
  'resolved',
  'retired',
] as const;
export type GitHubComparisonInterruptionState =
  (typeof GITHUB_COMPARISON_INTERRUPTION_STATES)[number];

export const GITHUB_COMPARISON_INTERRUPTION_SURFACES = [
  'comparison',
  'sub_issue',
] as const;
export type GitHubComparisonInterruptionSurface =
  (typeof GITHUB_COMPARISON_INTERRUPTION_SURFACES)[number];

export const GITHUB_IDENTITY_EXCEPTION_CATEGORIES = [
  'terminal_inaccessible',
] as const;
export type GitHubIdentityExceptionCategory =
  (typeof GITHUB_IDENTITY_EXCEPTION_CATEGORIES)[number];

export const GITHUB_IDENTITY_EXCEPTION_ACTIONS = ['accept', 'revoke'] as const;
export type GitHubIdentityExceptionAction =
  (typeof GITHUB_IDENTITY_EXCEPTION_ACTIONS)[number];

export const GITHUB_IDENTITY_EXCEPTION_PROOF_TYPES = [
  'stage1_inaccessible',
  'post_backfill_authoritative_deletion',
] as const;
export type GitHubIdentityExceptionProofType =
  (typeof GITHUB_IDENTITY_EXCEPTION_PROOF_TYPES)[number];

export const GITHUB_BACKFILL_STATES = [
  'pending',
  'bound',
  'legacy_only',
  'collision',
  'inaccessible',
] as const;
export type GitHubBackfillState = (typeof GITHUB_BACKFILL_STATES)[number];

export const GITHUB_COLLISION_CATEGORIES = [
  'multiple_local_one_stable',
  'one_local_multiple_stable',
  'stable_legacy_disagree',
  'repository_path_replacement',
  'same_stable_id_different_hosts',
  'locator_overlap_or_regression',
] as const;
export type GitHubCollisionCategory = (typeof GITHUB_COLLISION_CATEGORIES)[number];

export const GITHUB_COLLISION_STATES = ['open', 'resolved', 'accepted_legacy_only'] as const;
export type GitHubCollisionState = (typeof GITHUB_COLLISION_STATES)[number];

export const GITHUB_REPOSITORY_REPOINT_PHASES = [
  'locked',
  'applying',
  'applied',
  'verifying',
  'verified',
  'verification_failed',
  'rolling_back',
  'rolled_back',
  'failed',
] as const;
export type GitHubRepositoryRepointPhase = (typeof GITHUB_REPOSITORY_REPOINT_PHASES)[number];

export const GITHUB_BULK_TRANSFER_PHASES = [
  'running',
  'completed',
  'failed',
  'aborted',
] as const;
export type GitHubBulkTransferPhase = (typeof GITHUB_BULK_TRANSFER_PHASES)[number];

export const GITHUB_BULK_TRANSFER_ITEM_STATES = [
  'pending',
  'transferring',
  'transferred',
  'failed',
] as const;
export type GitHubBulkTransferItemState =
  (typeof GITHUB_BULK_TRANSFER_ITEM_STATES)[number];

export interface GitHubIdentityCounters {
  eligible: number;
  bound: number;
  legacyOnly: number;
  inaccessible: number;
  pending: number;
  collisions: number;
  batches: number;
  retries: number;
  rateLimitPauses: number;
}

export interface GitHubCollisionResolution {
  localId?: string;
  externalEntityId?: string;
  rationale: string;
}

export const externalEntities = sqliteTable('external_entities', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  hostKey: text('host_key').notNull(),
  entityType: text('entity_type').$type<ExternalEntityType>().notNull(),
  stableId: text('stable_id').notNull(),
  identityVersion: integer('identity_version').notNull().default(1),
  nextLocatorRevision: integer('next_locator_revision').notNull().default(1),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
}, (table) => [
  uniqueIndex('idx_external_entities_identity')
    .on(table.provider, table.hostKey, table.entityType, table.stableId),
  check('external_entities_type_check', sql`${table.entityType} IN ('repository', 'issue')`),
  check('external_entities_identity_version_check', sql`${table.identityVersion} = 1`),
  check('external_entities_locator_revision_check', sql`${table.nextLocatorRevision} >= 1`),
]);

export const externalEntityBindings = sqliteTable('external_entity_bindings', {
  id: text('id').primaryKey(),
  externalEntityId: text('external_entity_id')
    .notNull()
    .references(() => externalEntities.id, { onDelete: 'cascade' }),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  bindingType: text('binding_type').$type<ExternalBindingType>().notNull(),
  localId: text('local_id').notNull(),
  state: text('state').$type<ExternalBindingState>().notNull().default('shadow'),
  verifiedAt: text('verified_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_external_bindings_local')
    .on(table.connectorInstanceId, table.bindingType, table.localId),
  uniqueIndex('idx_external_bindings_entity')
    .on(table.connectorInstanceId, table.externalEntityId),
  index('idx_external_bindings_external_entity').on(table.externalEntityId),
  index('idx_external_bindings_state').on(table.connectorInstanceId, table.state),
  check('external_bindings_type_check', sql`${table.bindingType} IN ('task', 'source_list')`),
  check('external_bindings_state_check', sql`${table.state} IN ('shadow', 'active', 'collision', 'retired')`),
]);

export const externalEntityLocators = sqliteTable('external_entity_locators', {
  id: text('id').primaryKey(),
  externalEntityId: text('external_entity_id')
    .notNull()
    .references(() => externalEntities.id, { onDelete: 'cascade' }),
  repositoryEntityId: text('repository_entity_id')
    .references(() => externalEntities.id, { onDelete: 'restrict' }),
  provider: text('provider').notNull(),
  hostKey: text('host_key').notNull(),
  owner: text('owner').notNull(),
  repository: text('repository').notNull(),
  ownerKey: text('owner_key').notNull(),
  repositoryKey: text('repository_key').notNull(),
  issueNumber: integer('issue_number'),
  apiUrl: text('api_url'),
  webUrl: text('web_url'),
  validFrom: text('valid_from').notNull(),
  validTo: text('valid_to'),
  lastSeenAt: text('last_seen_at').notNull(),
  observationSource: text('observation_source').$type<ExternalLocatorSource>().notNull(),
  locatorRevision: integer('locator_revision').notNull(),
}, (table) => [
  uniqueIndex('idx_external_locators_revision')
    .on(table.externalEntityId, table.locatorRevision),
  uniqueIndex('idx_external_locators_current')
    .on(table.externalEntityId)
    .where(sql`${table.validTo} IS NULL`),
  uniqueIndex('idx_external_locators_current_repository')
    .on(table.provider, table.hostKey, table.ownerKey, table.repositoryKey)
    .where(sql`${table.validTo} IS NULL AND ${table.issueNumber} IS NULL`),
  uniqueIndex('idx_external_locators_current_issue')
    .on(table.provider, table.hostKey, table.ownerKey, table.repositoryKey, table.issueNumber)
    .where(sql`${table.validTo} IS NULL AND ${table.issueNumber} IS NOT NULL`),
  index('idx_external_locators_repository_issue')
    .on(table.repositoryEntityId, table.issueNumber, table.validTo),
  check('external_locators_source_check', sql`${table.observationSource} IN ('graphql', 'rest', 'backfill', 'operator')`),
  check('external_locators_revision_check', sql`${table.locatorRevision} >= 1`),
  check(
    'external_locators_issue_repository_check',
    sql`(${table.issueNumber} IS NULL AND ${table.repositoryEntityId} IS NULL)
      OR (${table.issueNumber} IS NOT NULL AND ${table.repositoryEntityId} IS NOT NULL)`,
  ),
]);

export const githubIdentityMigrations = sqliteTable('github_identity_migrations', {
  connectorInstanceId: text('connector_instance_id')
    .primaryKey()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  phase: text('phase').$type<GitHubIdentityPhase>().notNull().default('disabled'),
  taskCursor: text('task_cursor'),
  sourceListCursor: text('source_list_cursor'),
  batchSize: integer('batch_size').notNull().default(100),
  startedAt: text('started_at'),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  lastError: text('last_error'),
  counters: text('counters', { mode: 'json' })
    .$type<GitHubIdentityCounters>()
    .notNull()
    .default(sql`'{"eligible":0,"bound":0,"legacyOnly":0,"inaccessible":0,"pending":0,"collisions":0,"batches":0,"retries":0,"rateLimitPauses":0}'`),
}, (table) => [
  index('idx_github_identity_migrations_phase').on(table.phase, table.updatedAt),
  check(
    'github_identity_migrations_phase_check',
    sql`${table.phase} IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'comparing', 'stable_primary', 'compatibility', 'complete', 'paused', 'rollback_legacy')`,
  ),
  check('github_identity_migrations_batch_size_check', sql`${table.batchSize} BETWEEN 1 AND 500`),
]);

export const githubIdentityControls = sqliteTable('github_identity_controls', {
  connectorInstanceId: text('connector_instance_id')
    .primaryKey()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  stablePrimaryEnabled: integer('stable_primary_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  modeRevision: integer('mode_revision').notNull().default(1),
  lastModeEventId: integer('last_mode_event_id'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('github_identity_controls_revision_check', sql`${table.modeRevision} >= 1`),
  check(
    'github_identity_controls_stable_flag_check',
    sql`${table.stablePrimaryEnabled} IN (0, 1)`,
  ),
]);

export const githubIdentityModeEvents = sqliteTable('github_identity_mode_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  oldPhase: text('old_phase').$type<GitHubIdentityPhase>().notNull(),
  newPhase: text('new_phase').$type<GitHubIdentityPhase>().notNull(),
  oldEffectiveMode: text('old_effective_mode').$type<GitHubIdentityEffectiveMode>().notNull(),
  newEffectiveMode: text('new_effective_mode').$type<GitHubIdentityEffectiveMode>().notNull(),
  oldStablePrimaryEnabled: integer('old_stable_primary_enabled', { mode: 'boolean' }).notNull(),
  newStablePrimaryEnabled: integer('new_stable_primary_enabled', { mode: 'boolean' }).notNull(),
  oldModeRevision: integer('old_mode_revision').notNull(),
  newModeRevision: integer('new_mode_revision').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  gateResultCode: text('gate_result_code').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_github_identity_mode_events_idempotency')
    .on(table.connectorInstanceId, table.idempotencyKey),
  index('idx_github_identity_mode_events_connector')
    .on(table.connectorInstanceId, table.id),
  check(
    'github_identity_mode_events_old_phase_check',
    sql`${table.oldPhase} IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'comparing', 'stable_primary', 'compatibility', 'complete', 'paused', 'rollback_legacy')`,
  ),
  check(
    'github_identity_mode_events_new_phase_check',
    sql`${table.newPhase} IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'comparing', 'stable_primary', 'compatibility', 'complete', 'paused', 'rollback_legacy')`,
  ),
  check(
    'github_identity_mode_events_old_mode_check',
    sql`${table.oldEffectiveMode} IN ('legacy', 'comparison', 'stable')`,
  ),
  check(
    'github_identity_mode_events_new_mode_check',
    sql`${table.newEffectiveMode} IN ('legacy', 'comparison', 'stable')`,
  ),
  check(
    'github_identity_mode_events_revision_check',
    sql`${table.oldModeRevision} >= 0 AND ${table.newModeRevision} = ${table.oldModeRevision} + 1`,
  ),
]);

export const githubIdentityComparisonRuns = sqliteTable('github_identity_comparison_runs', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  jobId: text('job_id'),
  ownerId: text('owner_id'),
  ownerTokenDigest: text('owner_token_digest'),
  ownerHeartbeatAt: text('owner_heartbeat_at'),
  ownerLeaseExpiresAt: text('owner_lease_expires_at'),
  predecessorRunId: text('predecessor_run_id'),
  identityMode: text('identity_mode').$type<GitHubIdentityEffectiveMode>().notNull(),
  identityModeRevision: integer('identity_mode_revision').notNull(),
  syncKind: text('sync_kind').$type<'full' | 'incremental'>().notNull(),
  state: text('state').$type<GitHubIdentityComparisonRunState>().notNull().default('running'),
  pageCount: integer('page_count').notNull().default(0),
  queryCount: integer('query_count').notNull().default(0),
  outcomeCounts: text('outcome_counts', { mode: 'json' })
    .$type<Partial<Record<GitHubIdentityComparisonOutcome, number>>>()
    .notNull()
    .default(sql`'{}'`),
  lookupLatencyP50Ms: integer('lookup_latency_p50_ms'),
  lookupLatencyP95Ms: integer('lookup_latency_p95_ms'),
  lookupLatencyP99Ms: integer('lookup_latency_p99_ms'),
  evidenceEligible: integer('evidence_eligible', { mode: 'boolean' }).notNull().default(false),
  subIssueGenerationComplete: integer('sub_issue_generation_complete', { mode: 'boolean' })
    .notNull()
    .default(false),
  subIssueExpectedChildCount: integer('sub_issue_expected_child_count').notNull().default(0),
  subIssueExpectedParentCount: integer('sub_issue_expected_parent_count').notNull().default(0),
  subIssuePopulationCount: integer('sub_issue_population_count').notNull().default(0),
  subIssuePopulationDigest: text('sub_issue_population_digest'),
  subIssueObservedChildCount: integer('sub_issue_observed_child_count').notNull().default(0),
  subIssueObservedChildDigest: text('sub_issue_observed_child_digest'),
  interruptionState: text('interruption_state')
    .$type<GitHubComparisonInterruptionState>()
    .notNull()
    .default('none'),
  interruptionSurface: text('interruption_surface')
    .$type<GitHubComparisonInterruptionSurface>(),
  interruptedAt: text('interrupted_at'),
  interruptedByOwnerId: text('interrupted_by_owner_id'),
  interruptionReason: text('interruption_reason'),
  reconciledAt: text('reconciled_at'),
  reconciledBy: text('reconciled_by'),
  reconciliationReason: text('reconciliation_reason'),
  reconciliationKey: text('reconciliation_key'),
  resolvedByRunId: text('resolved_by_run_id'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  errorCode: text('error_code'),
}, (table) => [
  index('idx_github_identity_comparison_runs_connector')
    .on(table.connectorInstanceId, table.startedAt),
  index('idx_github_identity_comparison_runs_job').on(table.jobId),
  index('idx_github_identity_comparison_runs_interruption')
    .on(table.connectorInstanceId, table.interruptionState, table.identityModeRevision),
  uniqueIndex('idx_github_identity_comparison_runs_reconciliation_key')
    .on(table.connectorInstanceId, table.reconciliationKey),
  check(
    'github_identity_comparison_runs_mode_check',
    sql`${table.identityMode} IN ('legacy', 'comparison', 'stable')`,
  ),
  check(
    'github_identity_comparison_runs_kind_check',
    sql`${table.syncKind} IN ('full', 'incremental')`,
  ),
  check(
    'github_identity_comparison_runs_state_check',
    sql`${table.state} IN ('running', 'succeeded', 'failed', 'cancelled')`,
  ),
  check(
    'github_identity_comparison_runs_counts_check',
    sql`${table.identityModeRevision} >= 0
      AND ${table.pageCount} >= 0
      AND ${table.queryCount} >= 0
      AND ${table.subIssuePopulationCount} >= 0
      AND ${table.subIssueObservedChildCount} >= 0`,
  ),
  check(
    'github_identity_comparison_runs_owner_check',
    sql`(
      ${table.ownerId} IS NULL
      AND ${table.ownerTokenDigest} IS NULL
      AND ${table.ownerHeartbeatAt} IS NULL
      AND ${table.ownerLeaseExpiresAt} IS NULL
    ) OR (
      ${table.ownerId} IS NOT NULL
      AND ${table.ownerTokenDigest} IS NOT NULL
      AND ${table.ownerHeartbeatAt} IS NOT NULL
      AND ${table.ownerLeaseExpiresAt} IS NOT NULL
    )`,
  ),
  check(
    'github_identity_comparison_runs_population_check',
    sql`(
      ${table.subIssuePopulationDigest} IS NULL
      AND ${table.subIssueObservedChildDigest} IS NULL
    ) OR (
      length(${table.subIssuePopulationDigest}) = 64
      AND length(${table.subIssueObservedChildDigest}) = 64
    )`,
  ),
  check(
    'github_identity_comparison_runs_interruption_check',
    sql`${table.interruptionState} IN ('none', 'unresolved', 'resolved', 'retired')
      AND (
        (${table.interruptionState} = 'none' AND ${table.interruptionSurface} IS NULL)
        OR (
          ${table.interruptionState} != 'none'
          AND ${table.interruptionSurface} IN ('comparison', 'sub_issue')
          AND ${table.interruptedAt} IS NOT NULL
          AND ${table.interruptionReason} IS NOT NULL
        )
      )`,
  ),
]);

export const githubIdentityComparisonRecords = sqliteTable('github_identity_comparison_records', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => githubIdentityComparisonRuns.id, { onDelete: 'cascade' }),
  jobId: text('job_id'),
  surface: text('surface').$type<GitHubIdentityComparisonSurface>().notNull(),
  candidateKey: text('candidate_key').notNull(),
  localTaskId: text('local_task_id'),
  localSourceListId: text('local_source_list_id'),
  externalEntityId: text('external_entity_id')
    .references(() => externalEntities.id, { onDelete: 'set null' }),
  legacySelectedLocalId: text('legacy_selected_local_id'),
  stableSelectedLocalId: text('stable_selected_local_id'),
  legacyAction: text('legacy_action').$type<GitHubIdentityComparisonAction>().notNull(),
  stableAction: text('stable_action').$type<GitHubIdentityComparisonAction>().notNull(),
  outcome: text('outcome').$type<GitHubIdentityComparisonOutcome>().notNull(),
  reason: text('reason').$type<GitHubIdentityComparisonReason>().notNull(),
  stableIdDigest: text('stable_id_digest'),
  locatorRevision: integer('locator_revision'),
  legacyLookupMs: integer('legacy_lookup_ms').notNull().default(0),
  stableLookupMs: integer('stable_lookup_ms').notNull().default(0),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_github_identity_comparison_records_candidate')
    .on(table.runId, table.surface, table.candidateKey),
  index('idx_github_identity_comparison_records_outcome')
    .on(table.runId, table.outcome),
  index('idx_github_identity_comparison_records_entity').on(table.externalEntityId),
  check(
    'github_identity_comparison_records_surface_check',
    sql`${table.surface} IN ('source_list', 'task', 'project_association', 'dependency', 'sub_issue', 'linked_source', 'deletion', 'write_route')`,
  ),
  check(
    'github_identity_comparison_records_action_check',
    sql`${table.legacyAction} IN ('create', 'update', 'present', 'delete_candidate', 'none')
      AND ${table.stableAction} IN ('create', 'update', 'present', 'delete_candidate', 'none')`,
  ),
  check(
    'github_identity_comparison_records_outcome_check',
    sql`${table.outcome} IN ('agreement', 'legacy_fallback', 'missing_stable_id', 'collision', 'stable_legacy_disagree', 'locator_change', 'path_reuse', 'inaccessible', 'partial_fetch')`,
  ),
  check(
    'github_identity_comparison_records_reason_check',
    sql`${table.reason} IN ('exact_match', 'legacy_only', 'missing_stable_evidence', 'multiple_legacy_candidates', 'multiple_stable_bindings', 'selected_ids_differ', 'current_locator_changed', 'locator_owned_by_other_entity', 'access_denied', 'fetch_incomplete')`,
  ),
  check(
    'github_identity_comparison_records_metrics_check',
    sql`(${table.locatorRevision} IS NULL OR ${table.locatorRevision} >= 1)
      AND ${table.legacyLookupMs} >= 0 AND ${table.stableLookupMs} >= 0`,
  ),
]);

export const githubIdentitySubIssuePopulationMembers = sqliteTable(
  'github_identity_sub_issue_population_members',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => githubIdentityComparisonRuns.id, { onDelete: 'cascade' }),
    localTaskId: text('local_task_id').notNull(),
    sourceIdDigest: text('source_id_digest').notNull(),
    issueNumber: integer('issue_number').notNull(),
    memberDigest: text('member_digest').notNull(),
    observed: integer('observed', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_github_sub_issue_population_run_task')
      .on(table.runId, table.localTaskId),
    uniqueIndex('idx_github_sub_issue_population_run_member')
      .on(table.runId, table.memberDigest),
    check(
      'github_sub_issue_population_member_check',
      sql`${table.issueNumber} > 0
        AND length(${table.sourceIdDigest}) = 64
        AND length(${table.memberDigest}) = 64`,
    ),
  ],
);

/**
 * A write lease freezes the legacy route and the comparison facts that allowed
 * it.  It deliberately has no task foreign key: a deletion snapshot can retain
 * the evidence after the task is removed.
 */
export const taskSourceWriteLeases = sqliteTable('task_source_write_leases', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  operation: text('operation').$type<GitHubTaskWriteOperation>().notNull(),
  taskVersion: text('task_version').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  effectiveMode: text('effective_mode').$type<GitHubIdentityEffectiveMode>().notNull(),
  modeRevision: integer('mode_revision').notNull(),
  comparisonRunId: text('comparison_run_id')
    .references(() => githubIdentityComparisonRuns.id, { onDelete: 'set null' }),
  writeCycleId: text('write_cycle_id')
    .references(() => githubIdentityWriteCycles.id, { onDelete: 'set null' }),
  legacyRoute: text('route').notNull().default('legacy'),
  route: text('identity_route').notNull().default('legacy'),
  state: text('state').$type<GitHubTaskWriteLeaseState>().notNull().default('claimed'),
  cycleObservedAt: text('cycle_observed_at'),
  cycleOutcome: text('cycle_outcome')
    .$type<'succeeded' | 'failed' | 'blocked' | 'unknown'>(),
  intentKind: text('intent_kind'),
  intentDigest: text('intent_digest'),
  resultDigest: text('result_digest'),
  blockReason: text('block_reason'),
  unknownReason: text('unknown_reason'),
  dispatchedAt: text('dispatched_at'),
  finalizedAt: text('finalized_at'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_task_source_write_leases_token').on(table.token),
  uniqueIndex('idx_task_source_write_leases_task_operation_active')
    .on(table.connectorInstanceId, table.taskId, table.operation)
    .where(sql`${table.state} IN ('claimed', 'authorized', 'dispatched', 'unknown')`),
  index('idx_task_source_write_leases_connector_expiry')
    .on(table.connectorInstanceId, table.state, table.expiresAt),
  index('idx_task_source_write_leases_operator')
    .on(table.connectorInstanceId, table.createdAt),
  index('idx_task_source_write_leases_cycle').on(table.writeCycleId),
  check(
    'task_source_write_leases_operation_check',
    sql`${table.operation} IN ('create', 'update', 'complete', 'delete', 'label', 'comment', 'dependency', 'sub_issue', 'transfer')`,
  ),
  check(
    'task_source_write_leases_state_check',
    sql`${table.state} IN ('claimed', 'authorized', 'dispatched', 'succeeded', 'failed', 'blocked', 'unknown', 'expired')`,
  ),
  check(
    'task_source_write_leases_identity_route_check',
    sql`${table.route} IN ('legacy', 'stable')`,
  ),
  check(
    'task_source_write_leases_reason_check',
    sql`(${table.blockReason} IS NULL OR length(${table.blockReason}) <= 100)
      AND (${table.unknownReason} IS NULL OR length(${table.unknownReason}) <= 100)`,
  ),
]);

export const taskSourceWriteLeaseTargets = sqliteTable('task_source_write_lease_targets', {
  leaseId: text('lease_id')
    .notNull()
    .references(() => taskSourceWriteLeases.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  externalEntityId: text('external_entity_id')
    .references(() => externalEntities.id, { onDelete: 'restrict' }),
  repositoryEntityId: text('repository_entity_id')
    .references(() => externalEntities.id, { onDelete: 'restrict' }),
  hostKey: text('host_key'),
  locatorRevision: integer('locator_revision'),
  bindingRevision: text('binding_revision'),
  legacyLocatorDigest: text('legacy_locator_digest'),
  owner: text('owner'),
  repository: text('repository'),
  issueNumber: integer('issue_number'),
}, (table) => [
  primaryKey({ columns: [table.leaseId, table.role] }),
  index('idx_task_source_write_lease_targets_entity')
    .on(table.externalEntityId, table.repositoryEntityId),
  check(
    'task_source_write_lease_targets_role_check',
    sql`${table.role} IN ('primary_issue', 'parent_issue', 'blocker_issue', 'blocked_issue', 'source_repository', 'target_repository')`,
  ),
  check(
    'task_source_write_lease_targets_locator_check',
    sql`${table.locatorRevision} IS NULL OR ${table.locatorRevision} >= 1`,
  ),
]);

export const githubIdentityWriteCycles = sqliteTable('github_identity_write_cycles', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  comparisonRunId: text('comparison_run_id')
    .references(() => githubIdentityComparisonRuns.id, { onDelete: 'set null' }),
  jobId: text('job_id'),
  effectiveMode: text('effective_mode').$type<GitHubIdentityEffectiveMode>().notNull(),
  modeRevision: integer('mode_revision').notNull(),
  pendingCandidateCount: integer('pending_candidate_count').notNull().default(0),
  observedRouteCount: integer('observed_route_count').notNull().default(0),
  legacyAppliedCount: integer('legacy_applied_count').notNull().default(0),
  blockedCount: integer('blocked_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  unknownCount: integer('unknown_count').notNull().default(0),
  state: text('state').notNull().default('running'),
  reconciliationState: text('reconciliation_state')
    .$type<GitHubWriteCycleReconciliationState>()
    .notNull()
    .default('unresolved'),
  reconciliationReason: text('reconciliation_reason'),
  reconciliationCode: text('reconciliation_code'),
  reconciledAt: text('reconciled_at'),
  reconciledBy: text('reconciled_by'),
  reconciliationIdempotencyKey: text('reconciliation_idempotency_key'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  index('idx_github_identity_write_cycles_connector')
    .on(table.connectorInstanceId, table.completedAt),
  uniqueIndex('idx_github_identity_write_cycles_active')
    .on(table.connectorInstanceId)
    .where(sql`${table.state} = 'running'`),
  uniqueIndex('idx_github_identity_write_cycles_reconciliation_key')
    .on(table.connectorInstanceId, table.reconciliationIdempotencyKey)
    .where(sql`${table.reconciliationIdempotencyKey} IS NOT NULL`),
  check(
    'github_identity_write_cycles_state_check',
    sql`${table.state} IN ('running', 'completed', 'interrupted')`,
  ),
  check(
    'github_identity_write_cycles_count_check',
    sql`${table.pendingCandidateCount} >= 0 AND ${table.observedRouteCount} >= 0
      AND ${table.legacyAppliedCount} >= 0 AND ${table.blockedCount} >= 0
      AND ${table.failedCount} >= 0 AND ${table.unknownCount} >= 0`,
  ),
]);

export const githubWriteOutcomeEvents = sqliteTable('github_write_outcome_events', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  cycleId: text('cycle_id')
    .notNull()
    .references(() => githubIdentityWriteCycles.id, { onDelete: 'restrict' }),
  leaseId: text('lease_id')
    .notNull()
    .references(() => taskSourceWriteLeases.id, { onDelete: 'restrict' }),
  taskId: text('task_id').notNull(),
  operation: text('operation').$type<GitHubTaskWriteOperation>().notNull(),
  taskVersion: text('task_version').notNull(),
  expectedModeRevision: integer('expected_mode_revision').notNull(),
  outcome: text('outcome')
    .$type<'proven_applied' | 'proven_not_applied_retryable'>()
    .notNull(),
  proofKind: text('proof_kind').$type<'issue_state' | 'local_finalization'>().notNull(),
  proofDigest: text('proof_digest').notNull(),
  remoteState: text('remote_state').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_github_write_outcome_events_connector_key')
    .on(table.connectorInstanceId, table.idempotencyKey),
  uniqueIndex('idx_github_write_outcome_events_lease').on(table.leaseId),
  index('idx_github_write_outcome_events_cycle').on(table.cycleId, table.createdAt),
  check(
    'github_write_outcome_events_outcome_check',
    sql`${table.outcome} IN ('proven_applied', 'proven_not_applied_retryable')`,
  ),
  check(
    'github_write_outcome_events_proof_check',
    sql`(${table.proofKind} = 'issue_state'
        AND ${table.remoteState} IN ('open', 'closed', 'authoritative_absent'))
      OR (${table.proofKind} = 'local_finalization'
        AND ${table.remoteState} IN ('locally_succeeded', 'locally_failed_pre_dispatch'))`,
  ),
  check(
    'github_write_outcome_events_audit_check',
    sql`length(${table.actor}) BETWEEN 1 AND 80
      AND length(${table.reason}) BETWEEN 3 AND 500
      AND length(${table.idempotencyKey}) BETWEEN 8 AND 192
      AND length(${table.proofDigest}) = 64`,
  ),
]);

export const githubIdentityExceptionEvents = sqliteTable('github_identity_exception_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  bindingType: text('binding_type').$type<ExternalBindingType>().notNull(),
  localId: text('local_id').notNull(),
  category: text('category').$type<GitHubIdentityExceptionCategory>().notNull(),
  action: text('action').$type<GitHubIdentityExceptionAction>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  proofType: text('proof_type').$type<GitHubIdentityExceptionProofType>(),
  comparisonRunId: text('comparison_run_id')
    .references(() => githubIdentityComparisonRuns.id, { onDelete: 'restrict' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_github_identity_exception_events_idempotency')
    .on(table.connectorInstanceId, table.idempotencyKey),
  index('idx_github_identity_exception_events_local')
    .on(table.connectorInstanceId, table.bindingType, table.localId, table.id),
  check(
    'github_identity_exception_events_type_check',
    sql`${table.bindingType} IN ('task', 'source_list')`,
  ),
  check(
    'github_identity_exception_events_category_check',
    sql`${table.category} IN ('terminal_inaccessible')`,
  ),
  check(
    'github_identity_exception_events_action_check',
    sql`${table.action} IN ('accept', 'revoke')`,
  ),
  check(
    'github_identity_exception_events_proof_check',
    sql`${table.proofType} IS NULL OR ${table.proofType} IN ('stage1_inaccessible', 'post_backfill_authoritative_deletion')`,
  ),
  check(
    'github_identity_exception_events_proof_state_check',
    sql`(
      ${table.action} = 'revoke'
      AND ${table.proofType} IS NULL
      AND ${table.comparisonRunId} IS NULL
    ) OR (
      ${table.action} = 'accept'
      AND (
        (
          (${table.proofType} IS NULL OR ${table.proofType} = 'stage1_inaccessible')
          AND ${table.comparisonRunId} IS NULL
        ) OR (
          ${table.proofType} = 'post_backfill_authoritative_deletion'
          AND ${table.comparisonRunId} IS NOT NULL
        )
      )
    )`,
  ),
]);

export const githubIdentityTaskTransferReconciliations = sqliteTable(
  'github_identity_task_transfer_reconciliations',
  {
    id: text('id').primaryKey(),
    connectorInstanceId: text('connector_instance_id')
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
    sourceTaskId: text('source_task_id').notNull(),
    successorTaskId: text('successor_task_id').notNull(),
    sourceExternalEntityId: text('source_external_entity_id')
      .notNull()
      .references(() => externalEntities.id, { onDelete: 'restrict' }),
    successorExternalEntityId: text('successor_external_entity_id')
      .notNull()
      .references(() => externalEntities.id, { onDelete: 'restrict' }),
    expectedModeRevision: integer('expected_mode_revision').notNull(),
    proofKind: text('proof_kind').$type<'rest_historical_redirect'>().notNull(),
    proof: text('proof', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    proofDigest: text('proof_digest').notNull(),
    observedAt: text('observed_at').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_github_task_transfer_reconciliations_idempotency')
      .on(table.connectorInstanceId, table.idempotencyKey),
    uniqueIndex('idx_github_task_transfer_reconciliations_source')
      .on(table.connectorInstanceId, table.sourceTaskId),
    index('idx_github_task_transfer_reconciliations_successor')
      .on(table.connectorInstanceId, table.successorTaskId),
    check(
      'github_task_transfer_reconciliations_distinct_tasks_check',
      sql`${table.sourceTaskId} <> ${table.successorTaskId}`,
    ),
    check(
      'github_task_transfer_reconciliations_distinct_entities_check',
      sql`${table.sourceExternalEntityId} <> ${table.successorExternalEntityId}`,
    ),
    check(
      'github_task_transfer_reconciliations_revision_check',
      sql`${table.expectedModeRevision} >= 0`,
    ),
    check(
      'github_task_transfer_reconciliations_proof_check',
      sql`${table.proofKind} = 'rest_historical_redirect'
        AND length(${table.proofDigest}) = 64`,
    ),
    check(
      'github_task_transfer_reconciliations_audit_check',
      sql`length(${table.actor}) BETWEEN 1 AND 80
        AND length(${table.reason}) BETWEEN 3 AND 500
        AND length(${table.idempotencyKey}) BETWEEN 8 AND 192`,
    ),
  ],
);

export const githubIdentityBackfillItems = sqliteTable('github_identity_backfill_items', {
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  bindingType: text('binding_type').$type<ExternalBindingType>().notNull(),
  localId: text('local_id').notNull(),
  state: text('state').$type<GitHubBackfillState>().notNull(),
  externalEntityId: text('external_entity_id')
    .references(() => externalEntities.id, { onDelete: 'set null' }),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  reasonCode: text('reason_code'),
  observedAt: text('observed_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.connectorInstanceId, table.bindingType, table.localId] }),
  index('idx_github_backfill_items_state')
    .on(table.connectorInstanceId, table.state, table.nextAttemptAt),
  index('idx_github_backfill_items_entity').on(table.externalEntityId),
  check('github_backfill_items_type_check', sql`${table.bindingType} IN ('task', 'source_list')`),
  check(
    'github_backfill_items_state_check',
    sql`${table.state} IN ('pending', 'bound', 'legacy_only', 'collision', 'inaccessible')`,
  ),
  check('github_backfill_items_attempt_check', sql`${table.attemptCount} >= 0`),
]);

export const githubIdentityCollisions = sqliteTable('github_identity_collisions', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  category: text('category').$type<GitHubCollisionCategory>().notNull(),
  fingerprint: text('fingerprint').notNull(),
  bindingType: text('binding_type').$type<ExternalBindingType>().notNull(),
  localIds: text('local_ids', { mode: 'json' }).$type<string[]>().notNull(),
  externalEntityIds: text('external_entity_ids', { mode: 'json' }).$type<string[]>().notNull(),
  legacyIdentityDigest: text('legacy_identity_digest'),
  state: text('state').$type<GitHubCollisionState>().notNull().default('open'),
  resolution: text('resolution', { mode: 'json' }).$type<GitHubCollisionResolution>(),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  resolvedAt: text('resolved_at'),
  resolvedBy: text('resolved_by'),
}, (table) => [
  uniqueIndex('idx_github_identity_collisions_fingerprint')
    .on(table.connectorInstanceId, table.category, table.fingerprint),
  index('idx_github_identity_collisions_state')
    .on(table.connectorInstanceId, table.state, table.lastSeenAt),
  check(
    'github_identity_collisions_category_check',
    sql`${table.category} IN ('multiple_local_one_stable', 'one_local_multiple_stable', 'stable_legacy_disagree', 'repository_path_replacement', 'same_stable_id_different_hosts', 'locator_overlap_or_regression')`,
  ),
  check('github_identity_collisions_type_check', sql`${table.bindingType} IN ('task', 'source_list')`),
  check(
    'github_identity_collisions_state_check',
    sql`${table.state} IN ('open', 'resolved', 'accepted_legacy_only')`,
  ),
]);

export const githubRepositoryRepoints = sqliteTable('github_repository_repoints', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  phase: text('phase').$type<GitHubRepositoryRepointPhase>().notNull(),
  actor: text('actor').notNull(),
  hostKey: text('host_key').notNull(),
  repositoryEntityId: text('repository_entity_id')
    .notNull()
    .references(() => externalEntities.id, { onDelete: 'restrict' }),
  repositoryStableId: text('repository_stable_id').notNull(),
  fromOwner: text('from_owner').notNull(),
  fromRepository: text('from_repository').notNull(),
  toOwner: text('to_owner').notNull(),
  toRepository: text('to_repository').notNull(),
  connectorWasEnabled: integer('connector_was_enabled', { mode: 'boolean' }).notNull(),
  backupProof: text('backup_proof', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  preflight: text('preflight', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  rollbackSnapshot: text('rollback_snapshot', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  verification: text('verification', { mode: 'json' }).$type<Record<string, unknown>>(),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_github_repository_repoints_idempotency')
    .on(table.connectorInstanceId, table.idempotencyKey),
  uniqueIndex('idx_github_repository_repoints_active_connector')
    .on(table.connectorInstanceId)
    .where(sql`${table.phase} IN ('locked', 'applying', 'applied', 'verifying', 'verification_failed', 'rolling_back')`),
  index('idx_github_repository_repoints_phase').on(table.phase, table.updatedAt),
  check(
    'github_repository_repoints_phase_check',
    sql`${table.phase} IN ('locked', 'applying', 'applied', 'verifying', 'verified', 'verification_failed', 'rolling_back', 'rolled_back', 'failed')`,
  ),
]);

export const githubRepositoryRepointEvents = sqliteTable('github_repository_repoint_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  operationId: text('operation_id')
    .notNull()
    .references(() => githubRepositoryRepoints.id, { onDelete: 'cascade' }),
  phase: text('phase').$type<GitHubRepositoryRepointPhase>().notNull(),
  actor: text('actor').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_github_repository_repoint_events_operation').on(table.operationId, table.id),
]);

export const connectorMaintenanceLocks = sqliteTable('connector_maintenance_locks', {
  connectorInstanceId: text('connector_instance_id')
    .primaryKey()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  operationId: text('operation_id')
    .notNull()
    .references(() => githubRepositoryRepoints.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  acquiredAt: text('acquired_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_connector_maintenance_locks_operation').on(table.operationId),
]);

export const githubBulkTransferRuns = sqliteTable('github_bulk_transfer_runs', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  phase: text('phase').$type<GitHubBulkTransferPhase>().notNull(),
  actor: text('actor').notNull(),
  sourceRepository: text('source_repository').notNull(),
  targetRepository: text('target_repository').notNull(),
  planHash: text('plan_hash').notNull(),
  plan: text('plan', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  connectorWasEnabled: integer('connector_was_enabled', { mode: 'boolean' }).notNull(),
  transferredCount: integer('transferred_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_github_bulk_transfer_runs_idempotency')
    .on(table.connectorInstanceId, table.idempotencyKey),
  uniqueIndex('idx_github_bulk_transfer_runs_active_connector')
    .on(table.connectorInstanceId)
    .where(sql`${table.phase} = 'running'`),
  index('idx_github_bulk_transfer_runs_phase').on(table.phase, table.updatedAt),
  check(
    'github_bulk_transfer_runs_phase_check',
    sql`${table.phase} IN ('running', 'completed', 'failed', 'aborted')`,
  ),
]);

export const githubBulkTransferItems = sqliteTable('github_bulk_transfer_items', {
  runId: text('run_id')
    .notNull()
    .references(() => githubBulkTransferRuns.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  issueEntityId: text('issue_entity_id')
    .notNull()
    .references(() => externalEntities.id, { onDelete: 'restrict' }),
  issueStableId: text('issue_stable_id').notNull(),
  sourceNumber: integer('source_number').notNull(),
  targetNumber: integer('target_number'),
  state: text('state').$type<GitHubBulkTransferItemState>().notNull().default('pending'),
  beforeDigest: text('before_digest').notNull(),
  newSourceId: text('new_source_id'),
  lastError: text('last_error'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.taskId] }),
  uniqueIndex('idx_github_bulk_transfer_items_issue').on(table.runId, table.issueStableId),
  index('idx_github_bulk_transfer_items_state').on(table.runId, table.state, table.sourceNumber),
  check(
    'github_bulk_transfer_items_state_check',
    sql`${table.state} IN ('pending', 'transferring', 'transferred', 'failed')`,
  ),
]);

export const githubBulkTransferSuccessions = sqliteTable(
  'github_bulk_transfer_successions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => githubBulkTransferRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    sourceExternalEntityId: text('source_external_entity_id')
      .notNull()
      .references(() => externalEntities.id, { onDelete: 'restrict' }),
    successorExternalEntityId: text('successor_external_entity_id')
      .notNull()
      .references(() => externalEntities.id, { onDelete: 'restrict' }),
    sourceStableIdDigest: text('source_stable_id_digest').notNull(),
    successorStableIdDigest: text('successor_stable_id_digest').notNull(),
    sourceId: text('source_id').notNull(),
    successorSourceId: text('successor_source_id').notNull(),
    targetRepositoryEntityId: text('target_repository_entity_id')
      .notNull()
      .references(() => externalEntities.id, { onDelete: 'restrict' }),
    targetNumber: integer('target_number').notNull(),
    proof: text('proof', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    proofDigest: text('proof_digest').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    observedAt: text('observed_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_github_bulk_transfer_successions_item')
      .on(table.runId, table.taskId),
    uniqueIndex('idx_github_bulk_transfer_successions_idempotency')
      .on(table.runId, table.idempotencyKey),
    index('idx_github_bulk_transfer_successions_source')
      .on(table.sourceExternalEntityId),
    index('idx_github_bulk_transfer_successions_successor')
      .on(table.successorExternalEntityId),
    check(
      'github_bulk_transfer_successions_distinct_entities_check',
      sql`${table.sourceExternalEntityId} <> ${table.successorExternalEntityId}`,
    ),
    check(
      'github_bulk_transfer_successions_digest_check',
      sql`length(${table.sourceStableIdDigest}) = 64
        AND length(${table.successorStableIdDigest}) = 64
        AND length(${table.proofDigest}) = 64`,
    ),
    check(
      'github_bulk_transfer_successions_audit_check',
      sql`${table.targetNumber} > 0
        AND length(${table.actor}) BETWEEN 1 AND 80
        AND length(${table.reason}) BETWEEN 3 AND 500
        AND length(${table.idempotencyKey}) BETWEEN 8 AND 192`,
    ),
  ],
);

export const githubBulkTransferEvents = sqliteTable('github_bulk_transfer_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id')
    .notNull()
    .references(() => githubBulkTransferRuns.id, { onDelete: 'cascade' }),
  taskId: text('task_id'),
  eventType: text('event_type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_github_bulk_transfer_events_run').on(table.runId, table.id),
]);
