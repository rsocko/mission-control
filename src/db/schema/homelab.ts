import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const homelabAlertReceipts = sqliteTable('homelab_alert_receipts', {
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
  applied: integer('applied', { mode: 'boolean' }).notNull().default(true),
}, (table) => [
  uniqueIndex('idx_homelab_alert_receipts_event')
    .on(table.integration, table.source, table.eventId),
  index('idx_homelab_alert_receipts_incident')
    .on(table.integration, table.source, table.fingerprint, table.occurredAt),
  index('idx_homelab_alert_receipts_received')
    .on(table.lastReceivedAt),
]);
