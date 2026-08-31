import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe } from 'vitest';
import { _runMigrationsIndividually } from '@/db';
import { createSqliteNotificationDeliveryRepository } from '@/db/persistence/sqlite-notification-delivery-repository';
import {
  describeNotificationDeliveryRepositoryContract,
  NOTIFICATION_DELIVERY_BASE_TIME,
  type NotificationDeliveryContractHarness,
} from '../contracts/notification-delivery-repository.contract';

async function createHarness(): Promise<NotificationDeliveryContractHarness> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
  const repository = createSqliteNotificationDeliveryRepository(sqlite);

  return {
    repository,
    async reset() {
      for (const table of [
        'notification_delivery_events',
        'notifications',
        'connector_configs',
        'inbound_webhooks',
        'finance_insight_cutovers',
        'push_preferences',
        'app_settings',
        'push_subscriptions',
        'apns_registrations',
      ]) {
        sqlite.prepare(`DELETE FROM ${table}`).run();
      }
    },
    async seedEvent(input) {
      const connectorType = input.connectorType ?? 'github-issues';
      const connectorId = `${input.id}-connector`;
      const now = NOTIFICATION_DELIVERY_BASE_TIME.toISOString();
      if (connectorType === 'inbound-webhook') {
        sqlite.prepare(`
          INSERT INTO inbound_webhooks (id, name, source_label, enabled, created_at, updated_at)
          VALUES (?, 'Webhook', 'webhook', ?, ?, ?)
        `).run(connectorId, input.webhookEnabled === false ? 0 : 1, now, now);
      } else {
        sqlite.prepare(`
          INSERT INTO connector_configs (
            id, type, name, enabled, sync_mode, capabilities, credentials,
            settings, synced_lists, created_at, updated_at
          ) VALUES (?, ?, 'Contract', ?, 'poll', '{}', '{}', '{}', '[]', ?, ?)
        `).run(connectorId, connectorType, input.connectorEnabled === false ? 0 : 1, now, now);
      }
      if (connectorType === 'finance-manager') {
        sqlite.prepare(`
          INSERT INTO finance_insight_cutovers (
            connector_id, cutover_at, source_generation, source_sequence,
            legacy_disabled, delivery_enabled, created_at, updated_at
          ) VALUES (?, ?, 'generation', 1, 1, ?, ?, ?)
        `).run(connectorId, now, input.financeDeliveryEnabled === false ? 0 : 1, now, now);
      }
      const notificationId = `${input.id}-notification`;
      sqlite.prepare(`
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, title, level, category,
          state, read_state, disposition, source_state, sync_state, received_at, sort_at,
          metadata, presentation
        ) VALUES (?, ?, ?, ?, 'Contract', 'action_needed', 'system', 'unread', ?,
                  'inbox', 'active', 'synced', ?, ?, '{}', '{}')
      `).run(
        notificationId,
        connectorType === 'finance-manager'
          ? `finance-insight:${input.id}`
          : `contract:${input.id}`,
        connectorType,
        connectorId,
        input.readState ?? 'unread',
        now,
        now,
      );
      const payload = input.payload ?? {
        notificationId,
        title: 'Portable notification',
        tag: `mc:${notificationId}`,
        url: `/notifications?id=${notificationId}`,
      };
      sqlite.prepare(`
        INSERT INTO notification_delivery_events (
          id, notification_id, channel, dedupe_key, status, policy_snapshot,
          payload_snapshot, attempt_count, next_attempt_at, lease_expires_at,
          claim_token, created_at
        ) VALUES (?, ?, 'web_push', ?, ?, '{}', ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        notificationId,
        `web_push:${input.id}`,
        input.status ?? 'pending',
        JSON.stringify(payload),
        input.attemptCount ?? 0,
        input.nextAttemptAt ?? null,
        input.leaseExpiresAt ?? null,
        input.claimToken ?? null,
        input.createdAt ?? now,
      );
    },
    async getEvent(id) {
      return sqlite.prepare(`
        SELECT status, attempt_count AS attemptCount, claim_token AS claimToken,
               next_attempt_at AS nextAttemptAt, lease_expires_at AS leaseExpiresAt,
               last_error AS lastError, suppression_reason AS suppressionReason,
               subscriptions_attempted AS subscriptionsAttempted,
               subscriptions_sent AS subscriptionsSent,
               subscriptions_failed AS subscriptionsFailed
        FROM notification_delivery_events WHERE id = ?
      `).get(id) as ReturnType<NotificationDeliveryContractHarness['getEvent']> extends
        Promise<infer T> ? T : never;
    },
    async setDnd(enabled) {
      sqlite.prepare(`
        INSERT INTO push_preferences (
          id, morning_enabled, morning_hour, triage_nudge_enabled,
          triage_nudge_threshold, carry_forward_enabled, carry_forward_hour,
          do_not_disturb, updated_at
        ) VALUES ('default', 1, 8, 1, 5, 1, 18, ?, ?)
      `).run(enabled ? 1 : 0, NOTIFICATION_DELIVERY_BASE_TIME.toISOString());
    },
    async setQuietHours(start, end) {
      sqlite.prepare(`
        INSERT INTO push_preferences (
          id, morning_enabled, morning_hour, triage_nudge_enabled,
          triage_nudge_threshold, carry_forward_enabled, carry_forward_hour,
          quiet_start, quiet_end, do_not_disturb, updated_at
        ) VALUES ('default', 1, 8, 1, 5, 1, 18, ?, ?, 0, ?)
      `).run(start, end, NOTIFICATION_DELIVERY_BASE_TIME.toISOString());
    },
    async setChannelEnabled(enabled) {
      sqlite.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('push_delivery_enabled', ?, ?)
      `).run(JSON.stringify({ enabled }), NOTIFICATION_DELIVERY_BASE_TIME.toISOString());
    },
    async seedWebPushSubscription(id) {
      sqlite.prepare(`
        INSERT INTO push_subscriptions (id, platform, endpoint, keys, created_at)
        VALUES (?, 'web', ?, ?, ?)
      `).run(
        id,
        `https://push.example.test/${id}`,
        JSON.stringify({ p256dh: 'key', auth: 'auth' }),
        NOTIFICATION_DELIVERY_BASE_TIME.toISOString(),
      );
    },
    async hasWebPushSubscription(id) {
      return Boolean(sqlite.prepare(
        'SELECT id FROM push_subscriptions WHERE id = ?',
      ).get(id));
    },
    async seedApnsRegistration(id) {
      const now = NOTIFICATION_DELIVERY_BASE_TIME.toISOString();
      sqlite.prepare(`
        INSERT INTO apns_registrations (
          id, installation_id, token_ciphertext, token_hash, environment, topic,
          app_version, build_number, locale, time_zone, created_at, updated_at, last_seen_at
        ) VALUES (?, ?, 'ciphertext', ?, 'development', 'app.mission-control.test',
                  '1.0', 1, 'en-US', 'UTC', ?, ?, ?)
      `).run(id, `installation-${id}`, `hash-${id}`, now, now, now);
    },
    async getApnsInvalidation(id) {
      const row = sqlite.prepare(
        'SELECT invalidation_reason FROM apns_registrations WHERE id = ?',
      ).get(id) as { invalidation_reason: string | null };
      return row.invalidation_reason;
    },
  };
}

describe('SQLite notification delivery repository', () => {
  describeNotificationDeliveryRepositoryContract(createHarness);
});
