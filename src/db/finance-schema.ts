import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { connectorConfigs } from './schema/connectors';

export const FINANCE_DATASETS = [
  'accounts',
  'category-groups',
  'categories',
  'tags',
  'recurring',
  'budgets',
] as const;

export type FinanceDataset = typeof FINANCE_DATASETS[number];
export type FinanceFreshnessState = 'fresh' | 'stale' | 'partial' | 'unavailable';

// ─── FINANCE TRANSACTIONS ───────────────────────────────────────────────────

export const financeTransactions = sqliteTable('finance_transactions', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id').notNull().default('finance-manager-default'),
  upstreamTransactionId: text('upstream_transaction_id').notNull(),
  date: text('date').notNull(), // YYYY-MM-DD
  amount: real('amount').notNull(),
  merchantName: text('merchant_name'),
  merchantLogoUrl: text('merchant_logo_url'),
  categoryId: text('category_id'),
  originalCategory: text('original_category'),
  confirmedCategory: text('confirmed_category'),
  accountId: text('account_id'),
  accountName: text('account_name'),
  cardLast4: text('card_last4'),
  assignedKidId: text('assigned_kid_id'),
  kidAssignmentMethod: text('kid_assignment_method'),
  manualDecisionAction: text('manual_decision_action').$type<'assign-kid' | 'parent-expense'>(),
  manualDecidedAt: text('manual_decided_at'),
  attributionSourceRef: text('attribution_source_ref'),
  attributionContractVersion: text('attribution_contract_version'),
  attributionStatus: text('attribution_status')
    .$type<'attributed' | 'unassigned' | 'pending' | 'unavailable'>()
    .notNull()
    .default('pending'),
  attributionConfidence: text('attribution_confidence').$type<'definite' | 'likely' | 'none'>(),
  attributionMethod: text('attribution_method')
    .$type<'manual' | 'account-rule' | 'merchant-rule' | 'historical-pattern' | 'unassigned' | 'unavailable'>(),
  attributionExplanation: text('attribution_explanation'),
  attributionReasons: text('attribution_reasons', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  attributionDecisionSource: text('attribution_decision_source').$type<'manual' | 'automated' | 'fallback'>(),
  attributionPolicyVersion: integer('attribution_policy_version'),
  attributionEngineVersion: text('attribution_engine_version'),
  attributionEvaluatedAt: text('attribution_evaluated_at'),
  attributionReviewState: text('attribution_review_state')
    .$type<'not-required' | 'pending' | 'resolved'>()
    .notNull()
    .default('pending'),
  attributionProvenance: text('attribution_provenance'),
  attributionLastErrorCode: text('attribution_last_error_code'),
  attributionRetryable: integer('attribution_retryable', { mode: 'boolean' }).notNull().default(false),
  attributionUpdatedAt: text('attribution_updated_at'),
  triageStatus: text('triage_status').notNull().default('pending'), // 'pending' | 'confirmed' | 'flagged'
  flagReason: text('flag_reason'),
  isPending: integer('is_pending', { mode: 'boolean' }).notNull().default(false),
  isRecurring: integer('is_recurring', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  tags: text('tags', { mode: 'json' }).notNull().default('[]'),
  tagReferences: text('tag_references', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  lifecycleStatus: text('lifecycle_status').$type<'active' | 'deleted'>().notNull().default('active'),
  deletedAt: text('deleted_at'),
  provenanceProvider: text('provenance_provider').$type<'demo' | 'live'>(),
  provenanceFetchedAt: text('provenance_fetched_at'),
  sourceFingerprint: text('source_fingerprint').notNull().default(''),
  sourceUrl: text('source_url'),
  lastSeenGenerationId: text('last_seen_generation_id'),
  firstSeenAt: text('first_seen_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text('last_seen_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  syncedAt: text('synced_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_transactions_connector_upstream')
    .on(table.connectorInstanceId, table.upstreamTransactionId),
  index('idx_finance_transactions_connector_date')
    .on(table.connectorInstanceId, table.date),
  index('idx_finance_transactions_connector_lifecycle')
    .on(table.connectorInstanceId, table.lifecycleStatus, table.date),
  index('idx_finance_transactions_generation')
    .on(table.connectorInstanceId, table.lastSeenGenerationId),
  uniqueIndex('idx_finance_transactions_connector_source_ref')
    .on(table.connectorInstanceId, table.attributionSourceRef),
  index('idx_finance_transactions_attribution_review')
    .on(table.connectorInstanceId, table.attributionReviewState, table.attributionUpdatedAt),
]);

export const financeSyncState = sqliteTable('finance_sync_state', {
  connectorId: text('connector_id').primaryKey(),
  status: text('status').$type<'idle' | 'running' | 'succeeded' | 'failed'>().notNull().default('idle'),
  currentGenerationId: text('current_generation_id'),
  currentWindowStart: text('current_window_start'),
  currentWindowEnd: text('current_window_end'),
  lastMode: text('last_mode').$type<'backfill' | 'incremental'>(),
  lastAttemptAt: text('last_attempt_at'),
  lastSuccessfulSyncAt: text('last_successful_sync_at'),
  lastSuccessfulGenerationId: text('last_successful_generation_id'),
  lastSuccessfulSourceAsOf: text('last_successful_source_as_of'),
  lastSuccessfulItemCount: integer('last_successful_item_count'),
  lastSuccessfulContentDigest: text('last_successful_content_digest'),
  lastSuccessfulProjectionStartDate: text('last_successful_projection_start_date'),
  lastSuccessfulProjectionCoverageStart: text('last_successful_projection_coverage_start'),
  lastSuccessfulProjectionCoverageEnd: text('last_successful_projection_coverage_end'),
  lastSuccessfulBridgeContractVersion: text('last_successful_bridge_contract_version'),
  lastSuccessfulWindowStart: text('last_successful_window_start'),
  lastSuccessfulWindowEnd: text('last_successful_window_end'),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  lastAdded: integer('last_added').notNull().default(0),
  lastUpdated: integer('last_updated').notNull().default(0),
  lastDeleted: integer('last_deleted').notNull().default(0),
  attributionStatus: text('attribution_status')
    .$type<'idle' | 'healthy' | 'degraded' | 'unavailable'>()
    .notNull()
    .default('idle'),
  attributionLastAttemptAt: text('attribution_last_attempt_at'),
  attributionLastSuccessfulAt: text('attribution_last_successful_at'),
  attributionLastErrorCode: text('attribution_last_error_code'),
  attributionPolicyVersion: integer('attribution_policy_version'),
  attributionEngineVersion: text('attribution_engine_version'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_finance_sync_state_status').on(table.status, table.updatedAt),
]);

export const financeConnectionOutages = sqliteTable('finance_connection_outages', {
  connectorId: text('connector_id').primaryKey(),
  episodeId: text('episode_id').notNull(),
  status: text('status')
    .$type<'transient' | 'degraded' | 'authentication_expired' | 'recovery_pending' | 'recovered'>()
    .notNull(),
  authState: text('auth_state')
    .$type<'connected' | 'unauthenticated' | 'expired' | 'degraded' | 'unavailable'>()
    .notNull(),
  startedAt: text('started_at').notNull(),
  lastObservedAt: text('last_observed_at').notNull(),
  notificationCreatedAt: text('notification_created_at'),
  taskCreatedAt: text('task_created_at'),
  recoverySyncSucceededAt: text('recovery_sync_succeeded_at'),
  recoveredAt: text('recovered_at'),
  lastErrorCode: text('last_error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_finance_connection_outages_status')
    .on(table.status, table.updatedAt),
]);

export const financeInsightTransactionBackfillPlans = sqliteTable(
  'finance_insight_transaction_backfill_plans',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    horizonMonths: integer('horizon_months').notNull(),
    coverageStart: text('coverage_start').notNull(),
    coverageEnd: text('coverage_end').notNull(),
    currency: text('currency').notNull(),
    bridgeContractVersion: text('bridge_contract_version').notNull(),
    windowCount: integer('window_count').notNull(),
    nextWindowOrdinal: integer('next_window_ordinal').notNull().default(0),
    status: text('status').$type<'running' | 'completed'>().notNull().default('running'),
    lastErrorCode: text('last_error_code'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_finance_insight_backfill_plan_idempotency')
      .on(table.connectorId, table.idempotencyKey),
    index('idx_finance_insight_backfill_plan_status')
      .on(table.connectorId, table.status, table.updatedAt),
  ],
);

export const financeInsightTransactionWindowProofs = sqliteTable(
  'finance_insight_transaction_window_proofs',
  {
    planId: text('plan_id')
      .notNull()
      .references(() => financeInsightTransactionBackfillPlans.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id').notNull(),
    windowOrdinal: integer('window_ordinal').notNull(),
    generationRef: text('generation_ref').notNull(),
    windowStart: text('window_start').notNull(),
    windowEnd: text('window_end').notNull(),
    sourceAsOf: text('source_as_of').notNull(),
    itemCount: integer('item_count').notNull(),
    contentDigest: text('content_digest').notNull(),
    currency: text('currency').notNull(),
    bridgeContractVersion: text('bridge_contract_version').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.windowOrdinal] }),
    uniqueIndex('idx_finance_insight_window_generation')
      .on(table.connectorId, table.generationRef),
    index('idx_finance_insight_window_coverage')
      .on(table.connectorId, table.windowStart, table.windowEnd),
  ],
);

export const financeDatasetSyncState = sqliteTable('finance_dataset_sync_state', {
  connectorId: text('connector_id').notNull(),
  dataset: text('dataset').$type<FinanceDataset>().notNull(),
  lastAttemptAt: text('last_attempt_at'),
  lastAttemptOutcome: text('last_attempt_outcome').$type<'succeeded' | 'failed'>(),
  lastSuccessfulAt: text('last_successful_at'),
  sourceAsOf: text('source_as_of'),
  freshUntil: text('fresh_until'),
  coverageStart: text('coverage_start'),
  coverageEnd: text('coverage_end'),
  currentGenerationId: text('current_generation_id'),
  previousGenerationId: text('previous_generation_id'),
  schemaVersion: text('schema_version').notNull().default('1.0'),
  configVersion: integer('config_version').notNull().default(1),
  publishedItemCount: integer('published_item_count').notNull().default(0),
  insightItemCount: integer('insight_item_count'),
  insightContentDigest: text('insight_content_digest'),
  insightBridgeContractVersion: text('insight_bridge_contract_version'),
  sourceLimit: integer('source_limit').notNull(),
  lastErrorCode: text('last_error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.connectorId, table.dataset] }),
  index('idx_finance_dataset_state_freshness')
    .on(table.connectorId, table.freshUntil),
]);

export const financeAccounts = sqliteTable('finance_accounts', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  upstreamAccountId: text('upstream_account_id').notNull(),
  displayName: text('display_name').notNull(),
  type: text('type').notNull(),
  institution: text('institution'),
  mask: text('mask'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sourceIsActive: integer('source_is_active', { mode: 'boolean' }).notNull().default(true),
  lastSeenGenerationId: text('last_seen_generation_id').notNull().default(''),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  deactivatedAt: text('deactivated_at'),
}, (table) => [
  uniqueIndex('idx_finance_accounts_connector_upstream')
    .on(table.connectorId, table.upstreamAccountId),
  index('idx_finance_accounts_connector_active').on(table.connectorId, table.isActive),
]);

export const financeCategoryGroups = sqliteTable('finance_category_groups', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  upstreamGroupId: text('upstream_group_id').notNull(),
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sourceIsActive: integer('source_is_active', { mode: 'boolean' }).notNull().default(true),
  lastSeenGenerationId: text('last_seen_generation_id').notNull().default(''),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  deactivatedAt: text('deactivated_at'),
}, (table) => [
  uniqueIndex('idx_finance_category_groups_connector_upstream')
    .on(table.connectorId, table.upstreamGroupId),
  index('idx_finance_category_groups_connector_active').on(table.connectorId, table.isActive),
]);

export const financeCategories = sqliteTable('finance_categories', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  upstreamCategoryId: text('upstream_category_id').notNull(),
  name: text('name').notNull(),
  upstreamGroupId: text('upstream_group_id'),
  groupName: text('group_name'),
  icon: text('icon'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sourceIsActive: integer('source_is_active', { mode: 'boolean' }).notNull().default(true),
  lastSeenGenerationId: text('last_seen_generation_id').notNull().default(''),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  deactivatedAt: text('deactivated_at'),
}, (table) => [
  uniqueIndex('idx_finance_categories_connector_upstream')
    .on(table.connectorId, table.upstreamCategoryId),
  index('idx_finance_categories_connector_active').on(table.connectorId, table.isActive),
  index('idx_finance_categories_connector_group').on(table.connectorId, table.upstreamGroupId),
]);

export const financeTags = sqliteTable('finance_tags', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  upstreamTagId: text('upstream_tag_id').notNull(),
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sourceIsActive: integer('source_is_active', { mode: 'boolean' }).notNull().default(true),
  lastSeenGenerationId: text('last_seen_generation_id').notNull().default(''),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  deactivatedAt: text('deactivated_at'),
}, (table) => [
  uniqueIndex('idx_finance_tags_connector_upstream')
    .on(table.connectorId, table.upstreamTagId),
  index('idx_finance_tags_connector_active').on(table.connectorId, table.isActive),
]);

export const financeRecurringObligations = sqliteTable('finance_recurring_obligations', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  generationId: text('generation_id').notNull(),
  upstreamRecurringId: text('upstream_recurring_id').notNull(),
  merchant: text('merchant').notNull(),
  amount: real('amount').notNull(),
  frequency: text('frequency').notNull(),
  nextExpectedDate: text('next_expected_date'),
  upstreamAccountId: text('upstream_account_id'),
  accountName: text('account_name'),
  upstreamCategoryId: text('upstream_category_id'),
  categoryName: text('category_name'),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(true),
  sourceAsOf: text('source_as_of').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_recurring_generation_upstream')
    .on(table.connectorId, table.generationId, table.upstreamRecurringId),
  index('idx_finance_recurring_current').on(table.connectorId, table.isCurrent),
]);

export const financeBudgetSnapshots = sqliteTable('finance_budget_snapshots', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  generationId: text('generation_id').notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  upstreamCategoryId: text('upstream_category_id').notNull(),
  categoryName: text('category_name').notNull(),
  budgeted: real('budgeted').notNull(),
  spent: real('spent').notNull(),
  remaining: real('remaining').notNull(),
  percentUsed: real('percent_used'),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(true),
  sourceAsOf: text('source_as_of').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_budgets_generation_category')
    .on(table.connectorId, table.generationId, table.periodStart, table.upstreamCategoryId),
  index('idx_finance_budgets_current').on(table.connectorId, table.isCurrent, table.periodStart),
]);

export const financeMutationAudit = sqliteTable('finance_mutation_audit', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  connectorId: text('connector_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  upstreamTransactionId: text('upstream_transaction_id').notNull(),
  operation: text('operation').$type<'category_update'>().notNull(),
  requestedValue: text('requested_value').notNull(),
  status: text('status').$type<'pending' | 'processing' | 'succeeded' | 'failed'>().notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_finance_mutation_idempotency').on(table.connectorId, table.idempotencyKey),
  index('idx_finance_mutation_status').on(table.connectorId, table.status, table.updatedAt),
  index('idx_finance_mutation_transaction').on(table.transactionId, table.createdAt),
  index('idx_finance_mutation_attention_scan').on(table.connectorId, table.updatedAt, table.id),
]);

export const houstonFinanceActionAudit = sqliteTable('houston_finance_action_audit', {
  id: text('id').primaryKey(),
  correlationId: text('correlation_id').notNull(),
  callHash: text('call_hash').notNull(),
  tool: text('tool')
    .$type<'assignFinanceTransactionKid' | 'updateFinanceTransactionCategory'>()
    .notNull(),
  decision: text('decision').$type<'approve' | 'deny'>().notNull(),
  outcome: text('outcome')
    .$type<'denied' | 'succeeded' | 'failed' | 'stale' | 'invalid-approval'>()
    .notNull(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_houston_finance_action_call').on(table.callHash, table.createdAt),
  index('idx_houston_finance_action_correlation').on(table.correlationId, table.createdAt),
]);

export const houstonFinancePendingApprovals = sqliteTable('houston_finance_pending_approvals', {
  approvalId: text('approval_id').primaryKey(),
  toolCallId: text('tool_call_id').notNull(),
  tool: text('tool')
    .$type<'assignFinanceTransactionKid' | 'updateFinanceTransactionCategory'>()
    .notNull(),
  toolInput: text('tool_input').notNull(),
  correlationId: text('correlation_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_houston_finance_pending_expiry').on(table.expiresAt),
]);

export const financeAttributionSubjects = sqliteTable('finance_attribution_subjects', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  kidId: text('kid_id').notNull(),
  policyVersion: integer('policy_version').notNull(),
  engineVersion: text('engine_version').notNull(),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_attribution_subject_unique').on(table.connectorId, table.kidId),
  index('idx_finance_attribution_subject_policy').on(table.connectorId, table.policyVersion),
]);

export const financeAttributionExceptions = sqliteTable('finance_attribution_exceptions', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  sourceRef: text('source_ref'),
  status: text('status')
    .$type<'open' | 'retry_requested' | 'resolved' | 'dismissed'>()
    .notNull()
    .default('open'),
  reasonCode: text('reason_code').notNull(),
  retryable: integer('retryable', { mode: 'boolean' }).notNull().default(false),
  reviewState: text('review_state')
    .$type<'pending' | 'resolved'>()
    .notNull()
    .default('pending'),
  sourceFingerprint: text('source_fingerprint').notNull(),
  policyVersion: integer('policy_version'),
  occurrenceCount: integer('occurrence_count').notNull().default(1),
  resolution: text('resolution')
    .$type<'approved' | 'manual' | 'dismissed' | 'reattributed'>(),
  createdAt: text('created_at').notNull(),
  firstObservedAt: text('first_observed_at').notNull(),
  lastObservedAt: text('last_observed_at').notNull(),
  resolvedAt: text('resolved_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_attribution_exception_current')
    .on(table.connectorId, table.transactionId),
  index('idx_finance_attribution_exception_queue')
    .on(table.connectorId, table.status, table.updatedAt),
  index('idx_finance_attribution_attention_scan')
    .on(table.connectorId, table.updatedAt, table.id),
]);

export const financeAttributionAudit = sqliteTable('finance_attribution_audit', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  exceptionId: text('exception_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  action: text('action')
    .$type<'approve' | 'manual-resolve' | 'dismiss' | 'retry'>()
    .notNull(),
  actorType: text('actor_type').$type<'parent-admin' | 'service'>().notNull(),
  requestedKidId: text('requested_kid_id'),
  requestedDecision: text('requested_decision').$type<'assign-kid' | 'parent-expense'>(),
  resultStatus: text('result_status').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_attribution_audit_idempotency')
    .on(table.connectorId, table.idempotencyKey),
  index('idx_finance_attribution_audit_transaction')
    .on(table.connectorId, table.transactionId, table.createdAt),
]);

export const financeAttentionRepairAudit = sqliteTable('finance_attention_repair_audit', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  mode: text('mode').$type<'dry-run' | 'apply'>().notNull(),
  actorType: text('actor_type').$type<'parent-admin' | 'service'>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  dryRunId: text('dry_run_id'),
  reasonCode: text('reason_code').notNull(),
  targetDigest: text('target_digest').notNull(),
  occurrenceCount: integer('occurrence_count').notNull(),
  notificationCount: integer('notification_count').notNull(),
  actionCount: integer('action_count').notNull(),
  deliveryCount: integer('delivery_count').notNull(),
  taskCount: integer('task_count').notNull(),
  myDayCount: integer('my_day_count').notNull(),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_attention_repair_idempotency')
    .on(table.connectorId, table.idempotencyKey),
  index('idx_finance_attention_repair_connector')
    .on(table.connectorId, table.createdAt),
]);

// ─── KID PROFILES ───────────────────────────────────────────────────────────

export const kidProfiles = sqliteTable('kid_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#3b82f6'),
  avatar: text('avatar'),
  dailyLimit: real('daily_limit'),
  weeklyLimit: real('weekly_limit'),
  monthlyLimit: real('monthly_limit'),
});

export const financeInsightPublicationState = sqliteTable('finance_insight_publication_state', {
  connectorId: text('connector_id').primaryKey(),
  providerType: text('provider_type').notNull(),
  latestPublicationId: text('latest_publication_id'),
  latestGenerationIdentity: text('latest_generation_identity'),
  lastSourceSequence: integer('last_source_sequence').notNull().default(0),
  lastCaptureAttemptAt: text('last_capture_attempt_at'),
  lastCaptureOutcome: text('last_capture_outcome')
    .$type<'captured' | 'idempotent' | 'refused' | 'failed'>(),
  lastErrorCode: text('last_error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const financeInsightTransactionProjectionState = sqliteTable(
  'finance_insight_transaction_projection_state',
  {
    connectorId: text('connector_id')
      .primaryKey()
      .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
    status: text('status').$type<'idle' | 'running' | 'succeeded' | 'failed'>()
      .notNull()
      .default('idle'),
    currentAttemptId: text('current_attempt_id'),
    lastAttemptAt: text('last_attempt_at'),
    lastSuccessfulAt: text('last_successful_at'),
    successfulGenerationId: text('successful_generation_id'),
    sourceAsOf: text('source_as_of'),
    itemCount: integer('item_count'),
    contentDigest: text('content_digest'),
    coverageStart: text('coverage_start'),
    coverageEnd: text('coverage_end'),
    windowCount: integer('window_count'),
    windowsDigest: text('windows_digest'),
    bridgeContractVersion: text('bridge_contract_version'),
    lastErrorCode: text('last_error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_finance_insight_transaction_projection_status')
      .on(table.status, table.updatedAt),
  ],
);

export const financeInsightTransactionProjectionWindows = sqliteTable(
  'finance_insight_transaction_projection_windows',
  {
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
    generationId: text('generation_id').notNull(),
    windowIndex: integer('window_index').notNull(),
    coverageStart: text('coverage_start').notNull(),
    coverageEnd: text('coverage_end').notNull(),
    sourceAsOf: text('source_as_of').notNull(),
    itemCount: integer('item_count').notNull(),
    contentDigest: text('content_digest').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.connectorId, table.generationId, table.windowIndex] }),
    uniqueIndex('idx_finance_insight_transaction_window_coverage')
      .on(table.connectorId, table.generationId, table.coverageStart, table.coverageEnd),
  ],
);

export const financeInsightTransactionProjectionFacts = sqliteTable(
  'finance_insight_transaction_projection_facts',
  {
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
    generationId: text('generation_id').notNull(),
    sourceRef: text('source_ref').notNull(),
    occurredOn: text('occurred_on').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.connectorId, table.generationId, table.sourceRef] }),
    index('idx_finance_insight_transaction_projection_date')
      .on(table.connectorId, table.generationId, table.occurredOn),
  ],
);

export const financeInsightPublications = sqliteTable('finance_insight_publications', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id').notNull(),
  sourceSequence: integer('source_sequence').notNull(),
  generationIdentity: text('generation_identity').notNull(),
  contractVersion: text('contract_version').notNull(),
  providerType: text('provider_type').notNull(),
  sourceAsOf: text('source_as_of').notNull(),
  coverageStart: text('coverage_start').notNull(),
  coverageEnd: text('coverage_end').notNull(),
  currency: text('currency').notNull(),
  bridgeContractVersion: text('bridge_contract_version').notNull(),
  capturedConstituents: text('captured_constituents', { mode: 'json' }).notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull(),
  manifestDigest: text('manifest_digest').notNull(),
  createRequest: text('create_request', { mode: 'json' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  alertCapable: integer('alert_capable', { mode: 'boolean' }).notNull().default(false),
  capturedAt: text('captured_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_insight_publication_connector_sequence')
    .on(table.connectorId, table.sourceSequence),
  uniqueIndex('idx_finance_insight_publication_connector_identity')
    .on(table.connectorId, table.generationIdentity),
  index('idx_finance_insight_publication_connector_captured')
    .on(table.connectorId, table.capturedAt),
]);

export const financeInsightPublicationFacts = sqliteTable('finance_insight_publication_facts', {
  publicationId: text('publication_id')
    .notNull()
    .references(() => financeInsightPublications.id, { onDelete: 'cascade' }),
  kind: text('kind')
    .$type<'transaction' | 'recurring' | 'category' | 'account' | 'tag'>()
    .notNull(),
  sourceRef: text('source_ref').notNull(),
  batchIndex: integer('batch_index').notNull(),
  factIndex: integer('fact_index').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.publicationId, table.kind, table.sourceRef] }),
  uniqueIndex('idx_finance_insight_publication_fact_position')
    .on(table.publicationId, table.kind, table.batchIndex, table.factIndex),
  index('idx_finance_insight_publication_fact_batch')
    .on(table.publicationId, table.kind, table.batchIndex),
]);

export const financeInsightPublicationDelivery = sqliteTable('finance_insight_publication_delivery', {
  publicationId: text('publication_id')
    .primaryKey()
    .references(() => financeInsightPublications.id, { onDelete: 'cascade' }),
  connectorId: text('connector_id').notNull(),
  sourceSequence: integer('source_sequence').notNull(),
  stage: text('stage')
    .$type<'captured' | 'staging' | 'uploading' | 'committed' | 'evaluation-requested'>()
    .notNull()
    .default('captured'),
  nextBatchOrdinal: integer('next_batch_ordinal').notNull().default(0),
  detectorSetVersion: text('detector_set_version'),
  policyVersion: integer('policy_version'),
  evaluationSequence: integer('evaluation_sequence'),
  evaluationState: text('evaluation_state')
    .$type<'queued' | 'evaluating' | 'completed' | 'unavailable' | 'failed'>(),
  evaluationIdempotencyKey: text('evaluation_idempotency_key'),
  lastAttemptAt: text('last_attempt_at'),
  lastSuccessfulAt: text('last_successful_at'),
  lastErrorCode: text('last_error_code'),
  lastErrorRetryable: integer('last_error_retryable', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_insight_delivery_connector_sequence')
    .on(table.connectorId, table.sourceSequence),
  index('idx_finance_insight_delivery_stage')
    .on(table.connectorId, table.stage, table.updatedAt),
]);

export const financeInsightOccurrenceCacheState = sqliteTable('finance_insight_occurrence_cache_state', {
  connectorId: text('connector_id').primaryKey(),
  sourceGeneration: text('source_generation').notNull(),
  sourceSequence: integer('source_sequence').notNull().default(0),
  itemCount: integer('item_count').notNull(),
  sourceAsOf: text('source_as_of').notNull(),
  refreshedAt: text('refreshed_at').notNull(),
  summaryExpiresAt: text('summary_expires_at').notNull(),
  purgeAfter: text('purge_after').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const financeInsightOccurrences = sqliteTable('finance_insight_occurrences', {
  connectorId: text('connector_id').notNull(),
  occurrenceId: text('occurrence_id').notNull(),
  sourceGeneration: text('source_generation').notNull().default(''),
  isTombstone: integer('is_tombstone', { mode: 'boolean' }).notNull().default(false),
  insightId: text('insight_id').notNull(),
  deliveryRevision: integer('delivery_revision').notNull(),
  revisionDigest: text('revision_digest').notNull().default(''),
  sourceSequence: integer('source_sequence').notNull().default(0),
  kind: text('kind')
    .$type<'recurringAmountChange' | 'largeTransaction' | 'categoryVariance' | 'merchantVariance'>()
    .notNull(),
  entityKind: text('entity_kind')
    .$type<'recurring' | 'transaction' | 'category' | 'merchant'>()
    .notNull(),
  entitySourceRef: text('entity_source_ref').notNull(),
  entityLabel: text('entity_label').notNull(),
  analysisState: text('analysis_state')
    .$type<'analyzing' | 'qualified' | 'insufficientBaseline' | 'unavailable'>()
    .notNull(),
  sourceLifecycle: text('source_lifecycle').$type<'open' | 'resolved' | 'superseded'>(),
  severity: text('severity').$type<'info' | 'medium' | 'high'>().notNull(),
  confidence: text('confidence').$type<'low' | 'medium' | 'high'>().notNull(),
  baselineSufficiency: text('baseline_sufficiency')
    .$type<'insufficient' | 'limited' | 'sufficient'>()
    .notNull(),
  headline: text('headline').notNull(),
  freshnessState: text('freshness_state')
    .$type<'fresh' | 'stale' | 'partial' | 'unavailable'>()
    .notNull(),
  sourceAsOf: text('source_as_of'),
  targetDescriptors: text('target_descriptors', { mode: 'json' }).notNull(),
  summaryPayload: text('summary_payload', { mode: 'json' }),
  sourceUpdatedAt: text('source_updated_at').notNull(),
  cachedAt: text('cached_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.connectorId, table.occurrenceId] }),
  index('idx_finance_insight_occurrence_connector_updated')
    .on(table.connectorId, table.sourceUpdatedAt),
  index('idx_finance_insight_occurrence_connector_lifecycle')
    .on(table.connectorId, table.sourceLifecycle, table.sourceUpdatedAt),
  index('idx_finance_insight_occurrence_connector_series')
    .on(table.connectorId, table.insightId, table.sourceUpdatedAt),
]);

export const financeInsightCutovers = sqliteTable('finance_insight_cutovers', {
  connectorId: text('connector_id').primaryKey(),
  cutoverAt: text('cutover_at').notNull(),
  sourceGeneration: text('source_generation').notNull(),
  sourceSequence: integer('source_sequence').notNull(),
  legacyDisabled: integer('legacy_disabled', { mode: 'boolean' }).notNull().default(false),
  deliveryEnabled: integer('delivery_enabled', { mode: 'boolean' }).notNull().default(false),
  legacyExpiredCount: integer('legacy_expired_count').notNull().default(0),
  importedCount: integer('imported_count').notNull().default(0),
  result: text('result', { mode: 'json' }).notNull().default('{}'),
  rolledBackAt: text('rolled_back_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_finance_insight_cutover_delivery')
    .on(table.deliveryEnabled, table.updatedAt),
]);

export const financeInsightCutoverAudit = sqliteTable('finance_insight_cutover_audit', {
  id: text('id').primaryKey(),
  connectorId: text('connector_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  operation: text('operation').$type<'enable' | 'rollback'>().notNull(),
  actorType: text('actor_type').$type<'parent-admin' | 'service'>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  sourceGeneration: text('source_generation'),
  resultCode: text('result_code').notNull(),
  blockerCodes: text('blocker_codes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  legacyExpiredCount: integer('legacy_expired_count').notNull().default(0),
  importedCount: integer('imported_count').notNull().default(0),
  suppressedDeliveryCount: integer('suppressed_delivery_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at').notNull(),
}, (table) => [
  uniqueIndex('idx_finance_insight_cutover_audit_idempotency')
    .on(table.connectorId, table.idempotencyKey),
  index('idx_finance_insight_cutover_audit_connector')
    .on(table.connectorId, table.createdAt),
]);

// ─── KID CARD RULES ─────────────────────────────────────────────────────────

export const kidCardRules = sqliteTable('kid_card_rules', {
  id: text('id').primaryKey(),
  kidId: text('kid_id').notNull(),
  cardLast4: text('card_last4').notNull(),
  accountId: text('account_id'),
  confidence: real('confidence').notNull().default(1.0),
});

// ─── KID MERCHANT RULES ─────────────────────────────────────────────────────

export const kidMerchantRules = sqliteTable('kid_merchant_rules', {
  id: text('id').primaryKey(),
  kidId: text('kid_id').notNull(),
  merchantPattern: text('merchant_pattern').notNull(),
  confidence: real('confidence').notNull().default(0.8),
});

// ─── FINANCE ALERT CONFIGS ──────────────────────────────────────────────────

export const financeAlertConfigs = sqliteTable('finance_alert_configs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'spending_limit' | 'unusual_merchant' | 'large_transaction'
  kidId: text('kid_id'),
  period: text('period'), // 'daily' | 'weekly' | 'monthly'
  thresholdAmount: real('threshold_amount'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  severity: text('severity').notNull().default('heads_up'), // NotificationLevel: 'urgent' | 'action_needed' | 'heads_up' | 'fyi' | 'digest'
});
