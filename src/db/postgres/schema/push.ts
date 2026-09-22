import { boolean, jsonb } from 'drizzle-orm/pg-core';
import { pgTable, text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { notifications } from './notifications';

// ─── PUSH SUBSCRIPTIONS ─────────────────────────────────────────────────────

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: text('id').primaryKey(),
  /** 'web' (VAPID); native APNs registrations use apns_registrations */
  platform: text('platform').notNull().default('web'),
  /** The push subscription endpoint URL */
  endpoint: text('endpoint').notNull(),
  /** JSON-encoded PushSubscription keys (p256dh, auth) */
  keys: jsonb('keys').notNull(),
  /** User agent string for device identification */
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
});

// ─── PUSH NOTIFICATION PREFERENCES ─────────────────────────────────────────

export const pushPreferences = pgTable('push_preferences', {
  id: text('id').primaryKey().default('default'),
  /** Enable morning "Start My Day" notification */
  morningEnabled: boolean('morning_enabled').notNull().default(true),
  /** Hour (0-23) for morning notification */
  morningHour: integer('morning_hour').notNull().default(8),
  /** Enable midday triage queue nudge */
  triageNudgeEnabled: boolean('triage_nudge_enabled').notNull().default(true),
  /** Queue threshold to trigger midday nudge */
  triageNudgeThreshold: integer('triage_nudge_threshold').notNull().default(5),
  /** Enable end-of-day carry-forward reminder */
  carryForwardEnabled: boolean('carry_forward_enabled').notNull().default(true),
  /** Hour (0-23) for carry-forward reminder */
  carryForwardHour: integer('carry_forward_hour').notNull().default(18),
  /** Quiet hours start (0-23), notifications suppressed during quiet window */
  quietStart: integer('quiet_start'),
  /** Quiet hours end (0-23) */
  quietEnd: integer('quiet_end'),
  /** Do-not-disturb override — suppresses ALL notifications when enabled */
  doNotDisturb: boolean('do_not_disturb').notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

// ─── CONNECTOR PUSH RULES ───────────────────────────────────────────────────

export const notificationPushRules = pgTable('notification_push_rules', {
  id: text('id').primaryKey(),
  connectorInstanceId: text('connector_instance_id').notNull(),
  templateKey: text('template_key').notNull(),
  enabled: boolean('enabled').notNull(),
  minLevel: text('min_level').notNull(),
  preview: text('preview').notNull(),
  maxPerHour: integer('max_per_hour'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  connectorIdx: index('idx_notification_push_rules_connector').on(table.connectorInstanceId),
  connectorTemplateUnique: uniqueIndex('idx_notification_push_rules_connector_template')
    .on(table.connectorInstanceId, table.templateKey),
}));

// ─── DURABLE PUSH DELIVERY OUTBOX ───────────────────────────────────────────

export const notificationDeliveryEvents = pgTable('notification_delivery_events', {
  id: text('id').primaryKey(),
  notificationId: text('notification_id').notNull()
    .references(() => notifications.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull().default('web_push'),
  dedupeKey: text('dedupe_key').notNull(),
  status: text('status').notNull().default('pending'),
  suppressionReason: text('suppression_reason'),
  policySnapshot: jsonb('policy_snapshot').notNull(),
  payloadSnapshot: jsonb('payload_snapshot').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  leaseExpiresAt: text('lease_expires_at'),
  claimToken: text('claim_token'),
  subscriptionsAttempted: integer('subscriptions_attempted').notNull().default(0),
  subscriptionsSent: integer('subscriptions_sent').notNull().default(0),
  subscriptionsFailed: integer('subscriptions_failed').notNull().default(0),
  createdAt: text('created_at').notNull(),
  sentAt: text('sent_at'),
  lastError: text('last_error'),
}, (table) => ({
  dedupeUnique: uniqueIndex('idx_notification_delivery_events_dedupe').on(table.dedupeKey),
  dispatchIdx: index('idx_notification_delivery_events_dispatch')
    .on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
  notificationIdx: index('idx_notification_delivery_events_notification')
    .on(table.notificationId),
  createdAtIdx: index('idx_notification_delivery_events_created_at')
    .on(table.createdAt),
}));

// ─── DURABLE CONNECTOR WRITEBACK OUTBOX ─────────────────────────────────────

export const notificationWritebackJobs = pgTable('notification_writeback_jobs', {
  id: text('id').primaryKey(),
  notificationId: text('notification_id').notNull()
    .references(() => notifications.id, { onDelete: 'cascade' }),
  connectorInstanceId: text('connector_instance_id').notNull(),
  connectorType: text('connector_type').notNull(),
  sourceId: text('source_id').notNull(),
  actionType: text('action_type').notNull().default('mark_done'),
  dedupeKey: text('dedupe_key').notNull(),
  status: text('status').notNull().default('pending'),
  retryable: boolean('retryable').notNull().default(true),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  nextAttemptAt: text('next_attempt_at').notNull(),
  leaseExpiresAt: text('lease_expires_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  dedupeUnique: uniqueIndex('idx_notification_writeback_jobs_dedupe').on(table.dedupeKey),
  dispatchIdx: index('idx_notification_writeback_jobs_dispatch')
    .on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
  connectorIdx: index('idx_notification_writeback_jobs_connector')
    .on(table.connectorInstanceId, table.status),
  notificationIdx: index('idx_notification_writeback_jobs_notification')
    .on(table.notificationId, table.status),
}));
