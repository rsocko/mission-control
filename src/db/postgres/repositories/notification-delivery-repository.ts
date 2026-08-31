import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  parseNotificationDeliveryPayload,
  type ApnsRegistrationRecord,
  type NotificationDeliveryRepository,
  type WebPushSubscriptionRecord,
} from '@/db/persistence/notification-delivery';
import { needsAttention } from '@/lib/notifications/lifecycle';
import { isQuietHour } from '@/lib/notifications/quiet-hours-window';

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
  connector_enabled: boolean | null;
  connector_deleted_at: string | null;
  webhook_enabled: boolean | null;
  finance_delivery_enabled: boolean | null;
}

function parseBooleanSetting(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).enabled === true
  );
}

function parseKeys(value: unknown): WebPushSubscriptionRecord['keys'] {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>).p256dh !== 'string'
    || typeof (value as Record<string, unknown>).auth !== 'string'
  ) {
    throw new Error('Stored Web Push subscription keys are invalid');
  }
  return {
    p256dh: (value as Record<string, string>).p256dh,
    auth: (value as Record<string, string>).auth,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}

export function createPostgresNotificationDeliveryRepository(
  pool: Pool,
): NotificationDeliveryRepository {
  return {
    async claimNext(input) {
      const nowIso = input.now.toISOString();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
      for (let scanned = 0; scanned < 25; scanned += 1) {
        const client = await pool.connect();
        let row: RawClaim | undefined;
        try {
          await client.query('BEGIN');
          const exhausted = await client.query<{ id: string }>(
            `
              WITH candidate AS (
                SELECT id
                FROM notification_delivery_events
                WHERE channel IN ('web_push', 'apns')
                  AND attempt_count >= $1
                  AND (
                    (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $2))
                    OR
                    (status = 'sending' AND lease_expires_at IS NOT NULL
                      AND lease_expires_at <= $2)
                  )
                ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
              )
              UPDATE notification_delivery_events event
              SET status = 'failed',
                  claim_token = NULL,
                  lease_expires_at = NULL,
                  next_attempt_at = NULL,
                  last_error = 'retry_limit_exhausted'
              FROM candidate
              WHERE event.id = candidate.id
              RETURNING event.id
            `,
            [input.maxAttempts, nowIso],
          );
          if ((exhausted.rowCount ?? 0) > 0) {
            await client.query('COMMIT');
            continue;
          }

          const claimToken = randomUUID();
          const claimed = await client.query<RawClaim>(
            `
              WITH candidate AS (
                SELECT id
                FROM notification_delivery_events
                WHERE channel IN ('web_push', 'apns')
                  AND attempt_count < $1
                  AND (
                    (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $2))
                    OR
                    (status = 'sending' AND lease_expires_at IS NOT NULL
                      AND lease_expires_at <= $2)
                  )
                ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
              )
              UPDATE notification_delivery_events event
              SET status = 'sending',
                  attempt_count = event.attempt_count + 1,
                  lease_expires_at = $3,
                  claim_token = $4,
                  last_error = NULL
              FROM candidate
              WHERE event.id = candidate.id
              RETURNING event.id, event.notification_id, event.channel, event.dedupe_key,
                        event.attempt_count, event.payload_snapshot, event.lease_expires_at,
                        event.claim_token
            `,
            [input.maxAttempts, nowIso, leaseExpiresAt, claimToken],
          );
          row = claimed.rows[0];
          await client.query('COMMIT');
        } catch (error) {
          await rollback(client);
          throw error;
        } finally {
          client.release();
        }

        if (!row) return null;
        if (row.channel !== 'web_push' && row.channel !== 'apns') {
          await pool.query(
            `
              UPDATE notification_delivery_events
              SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
                  next_attempt_at = NULL, last_error = 'invalid_payload'
              WHERE id = $1 AND status = 'sending' AND claim_token = $2
            `,
            [row.id, row.claim_token],
          );
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
          await pool.query(
            `
              UPDATE notification_delivery_events
              SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
                  next_attempt_at = NULL, last_error = 'invalid_payload'
              WHERE id = $1 AND status = 'sending' AND claim_token = $2
            `,
            [row.id, row.claim_token],
          );
        }
      }
      return null;
    },

    async resolveSuppression(claim, input) {
      if (!input.channelConfigured) return 'channel_unconfigured';
      const setting = await pool.query<{ value: unknown }>(
        `SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'`,
      );
      if (setting.rows[0] && !parseBooleanSetting(setting.rows[0].value)) {
        return 'channel_disabled';
      }
      const preferences = await pool.query<{
        do_not_disturb: boolean;
        quiet_start: number | null;
        quiet_end: number | null;
      }>(`
        SELECT do_not_disturb, quiet_start, quiet_end
        FROM push_preferences WHERE id = 'default'
      `);
      const preference = preferences.rows[0];
      if (preference?.do_not_disturb) return 'dnd';
      if (
        preference
        && isQuietHour(input.currentHour, preference.quiet_start, preference.quiet_end)
      ) {
        return 'quiet_hours';
      }

      const eligibility = await pool.query<EligibilityRow>(
        `
          SELECT n.source_id, n.connector_type, n.connector_instance_id,
                 n.disposition, n.source_state, n.read_state, n.snoozed_until, n.level,
                 c.enabled AS connector_enabled, c.deleted_at AS connector_deleted_at,
                 w.enabled AS webhook_enabled,
                 f.delivery_enabled AS finance_delivery_enabled
          FROM notifications n
          LEFT JOIN connector_configs c ON c.id = n.connector_instance_id
          LEFT JOIN inbound_webhooks w ON w.id = n.connector_instance_id
          LEFT JOIN finance_insight_cutovers f ON f.connector_id = n.connector_instance_id
          WHERE n.id = $1
        `,
        [claim.notificationId],
      );
      const row = eligibility.rows[0];
      if (!row) return 'not_attention_eligible';
      if (
        row.connector_type === 'finance-manager'
        && (
          row.source_id.startsWith('finance-insight:')
          || row.source_id.startsWith('finance-insight-digest:')
        )
        && row.finance_delivery_enabled !== true
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
        return row.webhook_enabled ? null : 'connector_disabled';
      }
      if (row.connector_enabled === null || row.connector_deleted_at !== null) {
        return 'connector_deleted';
      }
      return row.connector_enabled ? null : 'connector_disabled';
    },

    async finalize(claim, values) {
      const result = await pool.query(
        `
          UPDATE notification_delivery_events
          SET status = $1,
              suppression_reason = $2,
              next_attempt_at = NULL,
              lease_expires_at = NULL,
              claim_token = NULL,
              subscriptions_attempted = $3,
              subscriptions_sent = $4,
              subscriptions_failed = $5,
              sent_at = $6,
              last_error = $7
          WHERE id = $8 AND status = 'sending' AND claim_token = $9
        `,
        [
          values.status,
          values.suppressionReason ?? null,
          values.counters?.attempted ?? 0,
          values.counters?.sent ?? 0,
          values.counters?.failed ?? 0,
          values.sentAt ?? null,
          values.lastError ?? null,
          claim.id,
          claim.claimToken,
        ],
      );
      return result.rowCount === 1;
    },

    async scheduleRetry(claim, input) {
      const result = await pool.query(
        `
          UPDATE notification_delivery_events
          SET status = 'pending',
              next_attempt_at = $1,
              lease_expires_at = NULL,
              claim_token = NULL,
              subscriptions_attempted = $2,
              subscriptions_sent = $3,
              subscriptions_failed = $4,
              last_error = $5
          WHERE id = $6 AND status = 'sending' AND claim_token = $7
        `,
        [
          input.nextAttemptAt,
          input.counters?.attempted ?? 0,
          input.counters?.sent ?? 0,
          input.counters?.failed ?? 0,
          input.lastError,
          claim.id,
          claim.claimToken,
        ],
      );
      return result.rowCount === 1;
    },

    async getNextWakeAt() {
      const result = await pool.query<{ due_at: string | null }>(`
        SELECT MIN(
          CASE
            WHEN status = 'pending' THEN COALESCE(next_attempt_at, created_at)
            WHEN status = 'sending' THEN lease_expires_at
          END
        ) AS due_at
        FROM notification_delivery_events
        WHERE channel IN ('web_push', 'apns') AND status IN ('pending', 'sending')
      `);
      return result.rows[0]?.due_at ?? null;
    },

    async listWebPushSubscriptions() {
      const result = await pool.query<{ id: string; endpoint: string; keys: unknown }>(`
        SELECT id, endpoint, keys FROM push_subscriptions WHERE platform = 'web'
      `);
      return result.rows.map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        keys: parseKeys(row.keys),
      }));
    },

    async retireWebPushSubscription(id) {
      const result = await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
      return result.rowCount === 1;
    },

    async listApnsRegistrations(input) {
      const result = await pool.query<ApnsRegistrationRecord>(
        `
          SELECT id, token_ciphertext AS "tokenCiphertext", environment, topic
          FROM apns_registrations
          WHERE environment = $1 AND topic = $2 AND invalidated_at IS NULL
        `,
        [input.environment, input.topic],
      );
      return result.rows;
    },

    async invalidateApnsRegistration(input) {
      const result = await pool.query(
        `
          UPDATE apns_registrations
          SET invalidated_at = $1, invalidation_reason = $2, updated_at = $1
          WHERE id = $3 AND invalidated_at IS NULL
        `,
        [input.invalidatedAt, input.reason, input.id],
      );
      return result.rowCount === 1;
    },
  };
}
