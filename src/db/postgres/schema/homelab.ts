import { boolean } from 'drizzle-orm/pg-core';
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

export const homelabAlertReceipts = pgTable('homelab_alert_receipts', {
  id: text('id').primaryKey(),
  integration: text('integration').notNull(),
  source: text('source').notNull(),
  eventId: text('event_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  status: text('status').notNull(),
  occurredAt: text('occurred_at').notNull(),
  notificationId: text('notification_id').notNull(),
  firstReceivedAt: text('first_received_at').notNull(),
  lastReceivedAt: text('last_received_at').notNull(),
  deliveryCount: integer('delivery_count').notNull().default(1),
  applied: boolean('applied').notNull().default(true),
}, (table) => [
  uniqueIndex('idx_homelab_alert_receipts_event')
    .on(table.integration, table.source, table.eventId),
  index('idx_homelab_alert_receipts_incident')
    .on(table.integration, table.source, table.fingerprint, table.occurredAt),
  index('idx_homelab_alert_receipts_received')
    .on(table.lastReceivedAt),
]);

export const alertmanagerIntegrationEvents = pgTable('alertmanager_integration_events', {
  id: text('id').primaryKey(),
  integration: text('integration').notNull(),
  kind: text('kind')
    .$type<'webhook_request' | 'operator_action' | 'synthetic_test'>()
    .notNull(),
  outcome: text('outcome').notNull(),
  authenticated: boolean('authenticated').notNull().default(false),
  httpStatus: integer('http_status').notNull(),
  accepted: integer('accepted').notNull().default(0),
  applied: integer('applied').notNull().default(0),
  created: integer('created').notNull().default(0),
  updated: integer('updated').notNull().default(0),
  stale: integer('stale').notNull().default(0),
  duplicateReceipts: integer('duplicate_receipts').notNull().default(0),
  detail: text('detail'),
  occurredAt: text('occurred_at').notNull(),
}, (table) => [
  index('idx_alertmanager_integration_events_history')
    .on(table.integration, table.occurredAt),
  index('idx_alertmanager_integration_events_outcome')
    .on(table.integration, table.kind, table.outcome, table.occurredAt),
]);
