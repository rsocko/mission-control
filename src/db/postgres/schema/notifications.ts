import { boolean, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tsvector } from './search';
import { pgTable, text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ─── NOTIFICATIONS ──────────────────────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull(),
  connectorType: text('connector_type').notNull(),
  connectorInstanceId: text('connector_instance_id').notNull(),

  title: text('title').notNull(),
  body: text('body'),
  searchVector: tsvector('search_vector').generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')`,
  ),
  level: text('level').notNull().default('fyi'),
  levelRank: integer('level_rank').notNull().default(3),
  category: text('category').notNull().default('system'),
  templateKey: text('template_key'),

  state: text('state').notNull().default('unread'),
  readState: text('read_state').notNull().default('unread'),
  disposition: text('disposition').notNull().default('inbox'),
  sourceState: text('source_state').notNull().default('active'),
  syncState: text('sync_state').notNull().default('synced'),
  readAt: text('read_at'),
  handledAt: text('handled_at'),
  dismissedAt: text('dismissed_at'),
  resolvedAt: text('resolved_at'),
  archivedAt: text('archived_at'),
  mutedAt: text('muted_at'),
  snoozedUntil: text('snoozed_until'),
  sourceResolvedAt: text('source_resolved_at'),
  lastSourceActivityAt: text('last_source_activity_at'),
  lastSourceActivityKey: text('last_source_activity_key'),
  handledSourceActivityAt: text('handled_source_activity_at'),
  handledSourceActivityKey: text('handled_source_activity_key'),
  lastSourceSyncedAt: text('last_source_synced_at'),

  isActionable: boolean('is_actionable').notNull().default(false),
  primaryActionId: text('primary_action_id'),
  aiSuggestedActionId: text('ai_suggested_action_id'),

  receivedAt: text('received_at').notNull(),
  sortAt: text('sort_at').notNull(),
  expiresAt: text('expires_at'),
  groupKey: text('group_key'),
  dedupeKey: text('dedupe_key'),

  relatedTaskId: text('related_task_id'),
  relatedProjectId: text('related_project_id'),
  relatedEntityType: text('related_entity_type'),
  relatedEntityId: text('related_entity_id'),
  navigationTarget: text('navigation_target'),

  reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  lastReconciledAt: text('last_reconciled_at'),
  staleSince: text('stale_since'),
  autoResolveReason: text('auto_resolve_reason'),

  metadata: jsonb('metadata').notNull().default({}),
  presentation: jsonb('presentation').notNull().default({}),
  enrichmentRevision: text('enrichment_revision'),
  enrichmentGeneration: integer('enrichment_generation').notNull().default(0),
}, (table) => ({
  searchVectorIdx: index('idx_notifications_search_vector').using('gin', table.searchVector),
  sourceIdIdx: uniqueIndex('idx_notifications_source_id').on(table.sourceId),
  stateIdx: index('idx_notifications_state').on(table.state),
  stateSortIdx: index('idx_notifications_sort_at').on(table.state, table.sortAt),
  inboxIdx: index('idx_notifications_inbox').on(
    table.disposition,
    table.sourceState,
    table.snoozedUntil,
    table.sortAt,
  ),
  attentionIdx: index('idx_notifications_attention').on(
    table.disposition,
    table.sourceState,
    table.readState,
    table.level,
  ),
  levelIdx: index('idx_notifications_level').on(table.level),
  categoryIdx: index('idx_notifications_category').on(table.category),
  receivedAtIdx: index('idx_notifications_received_at').on(table.receivedAt),
  connectorIdx: index('idx_notifications_connector').on(table.connectorType),
  dedupeIdx: index('idx_notifications_dedupe').on(table.dedupeKey),
  reconcileIdx: index('idx_notifications_reconcile_source').on(
    table.connectorInstanceId,
    table.sourceState,
    table.lastReconciledAt,
  ),
  relatedTaskIdx: index('idx_notifications_related_task_id').on(table.relatedTaskId),
}));

export const notificationEnrichmentJobs = pgTable('notification_enrichment_jobs', {
  id: text('id').primaryKey(),
  notificationId: text('notification_id').notNull()
    .references(() => notifications.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  sourceRevision: text('source_revision').notNull(),
  sourceGeneration: integer('source_generation').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status')
    .$type<'pending' | 'processing' | 'completed' | 'superseded' | 'dead_letter'>()
    .notNull()
    .default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  lastError: text('last_error'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  generationIdx: uniqueIndex('idx_notification_enrichment_generation')
    .on(table.notificationId, table.sourceGeneration),
  claimIdx: index('idx_notification_enrichment_claim')
    .on(table.status, table.nextAttemptAt, table.createdAt),
  leaseIdx: index('idx_notification_enrichment_lease')
    .on(table.status, table.leaseExpiresAt),
}));

// ─── NOTIFICATION ACTIONS ───────────────────────────────────────────────────

export const notificationActions = pgTable('notification_actions', {
  id: text('id').primaryKey(),
  notificationId: text('notification_id').notNull(),
  actionType: text('action_type').notNull(),
  label: text('label').notNull(),
  icon: text('icon'),
  variant: text('variant').notNull().default('secondary'),
  isPrimary: boolean('is_primary').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  payload: jsonb('payload').notNull().default({}),
  opensExternal: boolean('opens_external').notNull().default(false),
  requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
  createdBy: text('created_by').notNull().default('system'),
  executionState: text('execution_state').notNull().default('pending'),
  claimedAt: text('claimed_at'),
  completedAt: text('completed_at'),
  lastError: text('last_error'),
}, (table) => ({
  notificationIdx: index('idx_notification_actions_notification').on(table.notificationId),
}));

export const notificationSavedViews = pgTable('notification_saved_views', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  query: jsonb('query').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  nameUnique: uniqueIndex('idx_notification_saved_views_name').on(table.name),
  updatedAtIdx: index('idx_notification_saved_views_updated_at').on(table.updatedAt),
}));
