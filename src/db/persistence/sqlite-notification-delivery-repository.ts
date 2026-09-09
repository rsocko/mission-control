import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import {
  parseNotificationDeliveryPayload,
  type ApnsRegistrationRecord,
  type NotificationDeliveryRepository,
  type NotificationPushRule,
  type WebPushSubscriptionRecord,
} from './notification-delivery';
import { needsAttention } from '@/lib/notifications/lifecycle';
import { isQuietHour } from '@/lib/notifications/quiet-hours-window';
import { createSqliteNotificationWebRepository } from './sqlite-notification-web-repository';
import { createSqliteNotificationPushRepository } from './sqlite-notification-push-repository';
import {
  createSqliteNotificationCreation,
  createSqliteStoredNotificationPushPolicyResolver,
  installSqliteNotificationCreationTransactionCompatibility,
} from './sqlite-notification-creation';

interface RawClaim {
  id: string;
  notification_id: string;
  channel: string;
  dedupe_key: string;
  attempt_count: number;
  payload_snapshot: unknown;
  lease_expires_at: string;
  claim_token: string;
}

interface EligibilityRow {
  source_id: string;
  connector_type: string;
  connector_instance_id: string;
  disposition: string;
  source_state: string;
  read_state: string;
  snoozed_until: string | null;
  level: string;
  connector_enabled: number | null;
  connector_deleted_at: string | null;
  webhook_enabled: number | null;
  finance_delivery_enabled: number | null;
}

function parseBooleanSetting(value: unknown): boolean {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  if (typeof parsed === 'boolean') return parsed;
  return Boolean(
    parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).enabled === true
  );
}

function parseKeys(value: unknown): WebPushSubscriptionRecord['keys'] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || typeof (parsed as Record<string, unknown>).p256dh !== 'string'
    || typeof (parsed as Record<string, unknown>).auth !== 'string'
  ) {
    throw new Error('Stored Web Push subscription keys are invalid');
  }
  return {
    p256dh: (parsed as Record<string, string>).p256dh,
    auth: (parsed as Record<string, string>).auth,
  };
}

function parseTriageNudgeCount(
  row: { source_id: string; metadata: unknown },
  sourcePrefix: string,
): number | null {
  let metadata = row.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      metadata = {};
    }
  }
  const metadataCount = metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).queueSize
    : undefined;
  if (typeof metadataCount === 'number' && Number.isInteger(metadataCount) && metadataCount >= 0) {
    return metadataCount;
  }
  const sourceCount = Number(row.source_id.slice(sourcePrefix.length));
  return Number.isInteger(sourceCount) && sourceCount >= 0 ? sourceCount : null;
}

export function createSqliteNotificationDeliveryRepository(
  sqlite: Database.Database,
): NotificationDeliveryRepository {
  const database = drizzle(sqlite, { schema });
  installSqliteNotificationCreationTransactionCompatibility(database);
  const creation = createSqliteNotificationCreation(database);
  const terminalizeExhausted = sqlite.prepare(`
    UPDATE notification_delivery_events
    SET status = 'failed',
        claim_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error = 'retry_limit_exhausted'
    WHERE id = (
      SELECT id
      FROM notification_delivery_events
      WHERE channel IN ('web_push', 'apns')
        AND attempt_count >= ?
        AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR
          (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
      ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
      LIMIT 1
    )
  `);
  const claimNext = sqlite.prepare(`
    UPDATE notification_delivery_events
    SET status = 'sending',
        attempt_count = attempt_count + 1,
        lease_expires_at = ?,
        claim_token = ?,
        last_error = NULL
    WHERE id = (
      SELECT id
      FROM notification_delivery_events
      WHERE channel IN ('web_push', 'apns')
        AND attempt_count < ?
        AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR
          (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
      ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
      LIMIT 1
    )
      AND (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR
        (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
    RETURNING id, notification_id, channel, dedupe_key, attempt_count,
              payload_snapshot, lease_expires_at, claim_token
  `);
  const rejectMalformed = sqlite.prepare(`
    UPDATE notification_delivery_events
    SET status = 'failed',
        claim_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error = 'invalid_payload'
    WHERE id = ? AND status = 'sending' AND claim_token = ?
  `);

  return {
    async enqueueCustomDeliveries(input) {
      const now = new Date().toISOString();
      let created = 0;
      for (const channel of ['web_push', 'apns'] as const) {
        const result = sqlite.prepare(`
          INSERT OR IGNORE INTO notification_delivery_events (
            id, notification_id, channel, dedupe_key, status, suppression_reason,
            policy_snapshot, payload_snapshot, attempt_count, next_attempt_at,
            lease_expires_at, claim_token, subscriptions_attempted,
            subscriptions_sent, subscriptions_failed, created_at, sent_at, last_error
          ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, 0, ?, NULL, NULL, 0, 0, 0, ?, NULL, NULL)
        `).run(
          randomUUID(),
          input.notificationId,
          channel,
          `${channel}:${input.dedupeKey}`,
          JSON.stringify({
            version: 1,
            channel,
            connectorType: 'home-assistant',
            templateKey: 'home_assistant_update_summary',
            source: 'connector',
            sourceDetail: 'scheduled_summary',
            decision: 'pending',
          }),
          JSON.stringify(input.payload),
          input.nextAttemptAt,
          now,
        );
        created += result.changes;
      }
      return created;
    },

    async claimNext(input) {
      const nowIso = input.now.toISOString();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
      for (let scanned = 0; scanned < 25; scanned += 1) {
        const exhausted = terminalizeExhausted.run(input.maxAttempts, nowIso, nowIso);
        if (exhausted.changes > 0) continue;

        const claimToken = randomUUID();
        const row = claimNext.get(
          leaseExpiresAt,
          claimToken,
          input.maxAttempts,
          nowIso,
          nowIso,
          nowIso,
          nowIso,
        ) as RawClaim | undefined;
        if (!row) return null;
        if (row.channel !== 'web_push' && row.channel !== 'apns') {
          rejectMalformed.run(row.id, row.claim_token);
          continue;
        }
        try {
          return {
            id: row.id,
            notificationId: row.notification_id,
            channel: row.channel,
            dedupeKey: row.dedupe_key,
            attemptCount: row.attempt_count,
            payloadSnapshot: parseNotificationDeliveryPayload(row.payload_snapshot),
            leaseExpiresAt: row.lease_expires_at,
            claimToken: row.claim_token,
          };
        } catch {
          rejectMalformed.run(row.id, row.claim_token);
        }
      }
      return null;
    },

    async resolveSuppression(claim, input) {
      if (!input.channelConfigured) return 'channel_unconfigured';
      const setting = sqlite.prepare(`
        SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'
      `).get() as { value: unknown } | undefined;
      if (setting && !parseBooleanSetting(setting.value)) return 'channel_disabled';
      const preferences = sqlite.prepare(`
        SELECT do_not_disturb, quiet_start, quiet_end
        FROM push_preferences WHERE id = 'default'
      `).get() as {
        do_not_disturb: number;
        quiet_start: number | null;
        quiet_end: number | null;
      } | undefined;
      if (preferences?.do_not_disturb) return 'dnd';
      if (
        preferences
        && isQuietHour(input.currentHour, preferences.quiet_start, preferences.quiet_end)
      ) {
        return 'quiet_hours';
      }

      const row = sqlite.prepare(`
        SELECT n.source_id, n.connector_type, n.connector_instance_id,
               n.disposition, n.source_state, n.read_state, n.snoozed_until, n.level,
               c.enabled AS connector_enabled, c.deleted_at AS connector_deleted_at,
               w.enabled AS webhook_enabled,
               f.delivery_enabled AS finance_delivery_enabled
        FROM notifications n
        LEFT JOIN connector_configs c ON c.id = n.connector_instance_id
        LEFT JOIN inbound_webhooks w ON w.id = n.connector_instance_id
        LEFT JOIN finance_insight_cutovers f ON f.connector_id = n.connector_instance_id
        WHERE n.id = ?
      `).get(claim.notificationId) as EligibilityRow | undefined;
      if (!row) return 'not_attention_eligible';
      if (
        row.connector_type === 'finance-manager'
        && (
          row.source_id.startsWith('finance-insight:')
          || row.source_id.startsWith('finance-insight-digest:')
        )
        && row.finance_delivery_enabled !== 1
      ) {
        return 'connector_disabled';
      }
      if (!needsAttention({
        disposition: row.disposition,
        sourceState: row.source_state,
        readState: row.read_state,
        snoozedUntil: row.snoozed_until,
        level: row.level,
      }, input.now)) {
        return 'not_attention_eligible';
      }
      if (row.connector_type === 'system') return null;
      if (row.connector_type === 'inbound-webhook') {
        if (row.webhook_enabled === null) return 'connector_deleted';
        return row.webhook_enabled === 1 ? null : 'connector_disabled';
      }
      if (row.connector_enabled === null || row.connector_deleted_at !== null) {
        return 'connector_deleted';
      }
      return row.connector_enabled === 1 ? null : 'connector_disabled';
    },

    async finalize(claim, values) {
      const result = sqlite.prepare(`
        UPDATE notification_delivery_events
        SET status = ?,
            suppression_reason = ?,
            next_attempt_at = NULL,
            lease_expires_at = NULL,
            claim_token = NULL,
            subscriptions_attempted = ?,
            subscriptions_sent = ?,
            subscriptions_failed = ?,
            sent_at = ?,
            last_error = ?
        WHERE id = ? AND status = 'sending' AND claim_token = ?
      `).run(
        values.status,
        values.suppressionReason ?? null,
        values.counters?.attempted ?? 0,
        values.counters?.sent ?? 0,
        values.counters?.failed ?? 0,
        values.sentAt ?? null,
        values.lastError ?? null,
        claim.id,
        claim.claimToken,
      );
      return result.changes === 1;
    },

    async scheduleRetry(claim, input) {
      const result = sqlite.prepare(`
        UPDATE notification_delivery_events
        SET status = 'pending',
            next_attempt_at = ?,
            lease_expires_at = NULL,
            claim_token = NULL,
            subscriptions_attempted = ?,
            subscriptions_sent = ?,
            subscriptions_failed = ?,
            last_error = ?
        WHERE id = ? AND status = 'sending' AND claim_token = ?
      `).run(
        input.nextAttemptAt,
        input.counters?.attempted ?? 0,
        input.counters?.sent ?? 0,
        input.counters?.failed ?? 0,
        input.lastError,
        claim.id,
        claim.claimToken,
      );
      return result.changes === 1;
    },

    async getNextWakeAt() {
      const row = sqlite.prepare(`
        SELECT MIN(
          CASE
            WHEN status = 'pending' THEN COALESCE(next_attempt_at, created_at)
            WHEN status = 'sending' THEN lease_expires_at
          END
        ) AS due_at
        FROM notification_delivery_events
        WHERE channel IN ('web_push', 'apns') AND status IN ('pending', 'sending')
      `).get() as { due_at: string | null };
      return row.due_at;
    },

    async listWebPushSubscriptions() {
      const rows = sqlite.prepare(`
        SELECT id, endpoint, keys FROM push_subscriptions WHERE platform = 'web'
      `).all() as Array<{ id: string; endpoint: string; keys: unknown }>;
      return rows.map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        keys: parseKeys(row.keys),
      }));
    },

    async retireWebPushSubscription(id) {
      return sqlite.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes === 1;
    },

    async listApnsRegistrations(input) {
      return sqlite.prepare(`
        SELECT id, token_ciphertext AS tokenCiphertext,
               environment, topic
        FROM apns_registrations
        WHERE environment = ? AND topic = ? AND invalidated_at IS NULL
      `).all(input.environment, input.topic) as ApnsRegistrationRecord[];
    },

    async invalidateApnsRegistration(input) {
      return sqlite.prepare(`
        UPDATE apns_registrations
        SET invalidated_at = ?, invalidation_reason = ?, updated_at = ?
        WHERE id = ? AND invalidated_at IS NULL
      `).run(
        input.invalidatedAt,
        input.reason,
        input.invalidatedAt,
        input.id,
      ).changes === 1;
    },

    push: createSqliteNotificationPushRepository(sqlite),
    web: createSqliteNotificationWebRepository(sqlite),
    creation,
    pushRules: {
      async save(input) {
        const now = new Date().toISOString();
        const id = input.id ?? randomUUID();
        sqlite.prepare(`
          INSERT INTO notification_push_rules (
            id, connector_instance_id, template_key, enabled, min_level,
            preview, max_per_hour, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connector_instance_id, template_key) DO UPDATE SET
            enabled = excluded.enabled,
            min_level = excluded.min_level,
            preview = excluded.preview,
            max_per_hour = excluded.max_per_hour,
            updated_at = excluded.updated_at
        `).run(
          id,
          input.connectorInstanceId,
          input.templateKey,
          input.enabled ? 1 : 0,
          input.minLevel,
          input.preview,
          input.maxPerHour ?? null,
          now,
          now,
        );
        const saved = sqlite.prepare(`
          SELECT id, connector_instance_id AS connectorInstanceId,
                 template_key AS templateKey, enabled, min_level AS minLevel,
                 preview, max_per_hour AS maxPerHour,
                 created_at AS createdAt, updated_at AS updatedAt
          FROM notification_push_rules
          WHERE connector_instance_id = ? AND template_key = ?
        `).get(input.connectorInstanceId, input.templateKey) as
          | (Omit<NotificationPushRule, 'enabled'> & { enabled: number })
          | undefined;
        if (!saved) throw new Error('Notification push rule was not persisted');
        return { ...saved, enabled: Boolean(saved.enabled) };
      },

      async listOverrides(connectorInstanceId, templateKey) {
        const rows = sqlite.prepare(`
          SELECT id, connector_instance_id AS connectorInstanceId,
                 template_key AS templateKey, enabled, min_level AS minLevel,
                 preview, max_per_hour AS maxPerHour,
                 created_at AS createdAt, updated_at AS updatedAt
          FROM notification_push_rules
          WHERE connector_instance_id = ?
            AND (? IS NULL OR template_key IN (?, '*'))
        `).all(
          connectorInstanceId,
          templateKey ?? null,
          templateKey ?? null,
        ) as Array<Omit<NotificationPushRule, 'enabled'> & { enabled: number }>;
        return rows.map(row => ({ ...row, enabled: Boolean(row.enabled) }));
      },

      async reset(connectorInstanceId, templateKey) {
        sqlite.prepare(`
          DELETE FROM notification_push_rules
          WHERE connector_instance_id = ? AND template_key = ?
        `).run(connectorInstanceId, templateKey);
      },
    },
    policy: {
      async resolve(input) {
        return createSqliteStoredNotificationPushPolicyResolver(database).resolve(input);
      },
    },
    scheduledTriggers: {
      async getMorningSnapshot(localDate) {
        const planned = sqlite.prepare(`
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE id IN (
            SELECT task_id FROM my_day_items WHERE date = ? LIMIT 50
          )
            AND status NOT IN ('done', 'cancelled')
        `).get(localDate) as { count: number };
        const overdue = sqlite.prepare(`
          SELECT COUNT(*) AS count
          FROM (
            SELECT id FROM tasks
            WHERE due_date < ? AND status NOT IN ('done', 'cancelled')
            LIMIT 100
          )
        `).get(localDate) as { count: number };
        return {
          plannedCount: Number(planned.count),
          overdueCount: Number(overdue.count),
        };
      },

      async getTriageSnapshot(localDate) {
        const count = sqlite.prepare(`
          SELECT COUNT(*) AS count FROM triage_items WHERE status = 'pending'
        `).get() as { count: number };
        const sourcePrefix = `push:triage_nudge:${localDate}:`;
        const prior = sqlite.prepare(`
          SELECT source_id, metadata
          FROM notifications
          WHERE connector_type = 'system'
            AND connector_instance_id = 'push-triggers'
            AND template_key = 'triage_nudge'
            AND source_id LIKE ? ESCAPE '\\'
        `).all(`${sourcePrefix.replace(/[%_\\]/g, '\\$&')}%`) as Array<{
          source_id: string;
          metadata: unknown;
        }>;
        let highWater: number | null = null;
        for (const row of prior) {
          const value = parseTriageNudgeCount(row, sourcePrefix);
          if (value !== null && (highWater === null || value > highWater)) highWater = value;
        }
        return { pendingCount: Number(count.count), highWater };
      },

      async getCarryForwardSnapshot(localDate) {
        const rows = sqlite.prepare(`
          SELECT title
          FROM tasks
          WHERE id IN (
            SELECT task_id FROM my_day_items WHERE date = ? LIMIT 50
          )
            AND status NOT IN ('done', 'cancelled')
        `).all(localDate) as Array<{ title: string }>;
        return { incompleteTaskTitles: rows.map(row => row.title) };
      },
    },
  };
}
