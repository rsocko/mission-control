import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  eventSubscriptionMatches,
  parseEventOutboxPayload,
  parseEventTypes,
  type ClaimedEventDelivery,
  type EventDeliveryRepositories,
  type EventOutboxEnqueueRequest,
  type EventOutboxEnqueueResult,
  type EventSubscriptionRecord,
} from '@/db/persistence/event-outbox';

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  event_types: unknown;
  enabled: boolean;
}

interface ClaimRow {
  id: string;
  event_sequence: number;
  attempt_count: number;
  lease_owner: string;
  lease_token: string;
  lease_expires_at: string;
  stable_key: string;
  event_type: string;
  payload: unknown;
  occurred_at: string;
  webhook_id: string;
  webhook_name: string;
  webhook_url: string;
  webhook_secret: string | null;
  webhook_event_types: unknown;
  webhook_enabled: boolean;
}

function toSubscription(row: WebhookRow): EventSubscriptionRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret,
    eventTypes: parseEventTypes(row.event_types),
    enabled: row.enabled === true,
  };
}

/**
 * Transaction-scoped enqueue for PostgreSQL. Runs on a caller-supplied client
 * so the outbox write commits (or rolls back) with the terminal sync-job
 * transition that produced it. Re-enqueueing an existing `stableKey` is a
 * no-op, which is what makes sync-job retries non-duplicating.
 */
export async function enqueuePostgresEventOutbox(
  client: PoolClient,
  request: EventOutboxEnqueueRequest,
): Promise<EventOutboxEnqueueResult> {
  const now = new Date().toISOString();
  // PostgreSQL sequences are allocated before commit. Serialize outbox inserts
  // through commit so sequence order is also observable delivery order.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('mission-control:event-outbox-sequence'))`,
  );
  const inserted = await client.query<{ sequence: number }>(
    `
      INSERT INTO event_outbox (stable_key, event_type, payload, occurred_at, created_at)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (stable_key) DO NOTHING
      RETURNING sequence
    `,
    [
      request.stableKey,
      request.eventType,
      JSON.stringify(request.payload),
      request.occurredAt,
      now,
    ],
  );

  if ((inserted.rowCount ?? 0) === 0) {
    const existing = await client.query<{ sequence: number }>(
      'SELECT sequence FROM event_outbox WHERE stable_key = $1',
      [request.stableKey],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error('Event outbox enqueue conflicted without a resolvable existing row');
    }
    return { created: false, sequence: row.sequence, deliveryCount: 0 };
  }

  const sequence = inserted.rows[0].sequence;
  const webhooks = await client.query<WebhookRow>(`
    SELECT id, name, url, secret, event_types, enabled
    FROM outbound_webhooks
    WHERE enabled = true
  `);
  const matching = webhooks.rows
    .map(toSubscription)
    .filter((subscription) => eventSubscriptionMatches(subscription, request.eventType));

  const nextDeliveryId = request.deliveryIdFactory ?? randomUUID;
  let deliveryCount = 0;
  for (const subscription of matching) {
    const result = await client.query(
      `
        INSERT INTO event_outbox_deliveries (
          id, event_sequence, webhook_id, status, attempt_count, created_at, updated_at
        )
        VALUES ($1, $2, $3, 'pending', 0, $4, $4)
        ON CONFLICT (event_sequence, webhook_id) DO NOTHING
      `,
      [nextDeliveryId(), sequence, subscription.id, now],
    );
    deliveryCount += result.rowCount ?? 0;
  }

  return { created: true, sequence, deliveryCount };
}

export function createPostgresEventDeliveryRepositories(pool: Pool): EventDeliveryRepositories {
  async function fence(sql: string, values: unknown[]): Promise<boolean> {
    const result = await pool.query(sql, values);
    return (result.rowCount ?? 0) === 1;
  }

  return {
    subscriptions: {
      async listMatching(eventType) {
        const result = await pool.query<WebhookRow>(`
          SELECT id, name, url, secret, event_types, enabled
          FROM outbound_webhooks
          WHERE enabled = true
        `);
        return result.rows
          .map(toSubscription)
          .filter((subscription) => eventSubscriptionMatches(subscription, eventType));
      },

      async recordDeliveryOutcome(input) {
        await pool.query(
          `
            UPDATE outbound_webhooks
            SET last_triggered_at = $1, last_status = $2
            WHERE id = $3
          `,
          [input.triggeredAt, input.status, input.webhookId],
        );
      },
    },

    outbox: {
      async enqueue(request) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await enqueuePostgresEventOutbox(client, request);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },

      /**
       * `FOR UPDATE SKIP LOCKED` lets concurrent dispatchers claim distinct
       * deliveries without blocking. The `NOT EXISTS` guard keeps per-webhook
       * ordering deterministic by making a webhook claimable only at its lowest
       * outstanding sequence.
       */
      async claimNext(input) {
        const now = input.now.toISOString();
        const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
        for (let scanned = 0; scanned < 25; scanned += 1) {
          const client = await pool.connect();
          let row: ClaimRow | undefined;
          try {
            await client.query('BEGIN');
            const claimed = await client.query<ClaimRow>(
              `
                WITH candidate AS (
                  SELECT d.id
                  FROM event_outbox_deliveries d
                  WHERE (
                      (d.status = 'pending'
                        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= $1))
                      OR (d.status = 'delivering'
                        AND d.lease_expires_at IS NOT NULL
                        AND d.lease_expires_at <= $1)
                    )
                    AND EXISTS (
                      SELECT 1
                      FROM outbound_webhooks active_webhook
                      WHERE active_webhook.id = d.webhook_id
                        AND active_webhook.enabled = true
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM event_outbox_deliveries earlier
                      WHERE earlier.webhook_id = d.webhook_id
                        AND earlier.event_sequence < d.event_sequence
                        AND earlier.status IN ('pending', 'delivering')
                    )
                  ORDER BY d.event_sequence, d.id
                  LIMIT 1
                  FOR UPDATE SKIP LOCKED
                )
                UPDATE event_outbox_deliveries delivery
                SET status = 'delivering',
                    attempt_count = delivery.attempt_count + 1,
                    lease_owner = $2,
                    lease_token = $3,
                    lease_expires_at = $4,
                    next_attempt_at = NULL,
                    updated_at = $1
                FROM candidate, event_outbox e, outbound_webhooks w
                WHERE delivery.id = candidate.id
                  AND e.sequence = delivery.event_sequence
                  AND w.id = delivery.webhook_id
                RETURNING delivery.id, delivery.event_sequence, delivery.attempt_count,
                          delivery.lease_owner, delivery.lease_token, delivery.lease_expires_at,
                          e.stable_key, e.event_type, e.payload, e.occurred_at,
                          w.id AS webhook_id, w.name AS webhook_name, w.url AS webhook_url,
                          w.secret AS webhook_secret, w.event_types AS webhook_event_types,
                          w.enabled AS webhook_enabled
              `,
              [now, input.owner, randomUUID(), leaseExpiresAt],
            );
            row = claimed.rows[0];
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
          } finally {
            client.release();
          }

          if (!row) return null;
          let payload: Record<string, unknown>;
          try {
            payload = parseEventOutboxPayload(row.payload);
          } catch {
            await pool.query(
              `
                UPDATE event_outbox_deliveries
                SET status = 'dead_letter',
                    lease_owner = NULL,
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    next_attempt_at = NULL,
                    last_error = 'invalid_payload',
                    completed_at = $1,
                    updated_at = $1
                WHERE id = $2 AND status = 'delivering' AND lease_token = $3
              `,
              [now, row.id, row.lease_token],
            );
            continue;
          }
          return {
            id: row.id,
            eventSequence: row.event_sequence,
            eventType: row.event_type,
            stableKey: row.stable_key,
            payload,
            occurredAt: row.occurred_at,
            attemptCount: row.attempt_count,
            webhook: toSubscription({
              id: row.webhook_id,
              name: row.webhook_name,
              url: row.webhook_url,
              secret: row.webhook_secret,
              event_types: row.webhook_event_types,
              enabled: row.webhook_enabled,
            }),
            leaseOwner: row.lease_owner,
            leaseToken: row.lease_token,
            leaseExpiresAt: row.lease_expires_at,
          } satisfies ClaimedEventDelivery;
        }
        return null;
      },

      async heartbeat(claim, leaseExpiresAt) {
        return fence(
          `
            UPDATE event_outbox_deliveries
            SET lease_expires_at = $1, updated_at = $2
            WHERE id = $3 AND status = 'delivering' AND lease_owner = $4 AND lease_token = $5
          `,
          [
            leaseExpiresAt,
            new Date().toISOString(),
            claim.id,
            claim.leaseOwner,
            claim.leaseToken,
          ],
        );
      },

      async markDelivered(claim, input) {
        return fence(
          `
            UPDATE event_outbox_deliveries
            SET status = 'delivered',
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = NULL,
                last_error = NULL,
                last_status = $1,
                completed_at = $2,
                updated_at = $2
            WHERE id = $3 AND status = 'delivering' AND lease_owner = $4 AND lease_token = $5
          `,
          [input.lastStatus, input.deliveredAt, claim.id, claim.leaseOwner, claim.leaseToken],
        );
      },

      async scheduleRetry(claim, input) {
        return fence(
          `
            UPDATE event_outbox_deliveries
            SET status = 'pending',
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = $1,
                last_error = $2,
                last_status = $3,
                updated_at = $4
            WHERE id = $5 AND status = 'delivering' AND lease_owner = $6 AND lease_token = $7
          `,
          [
            input.nextAttemptAt,
            input.lastError,
            input.lastStatus ?? null,
            new Date().toISOString(),
            claim.id,
            claim.leaseOwner,
            claim.leaseToken,
          ],
        );
      },

      async deadLetter(claim, input) {
        const now = new Date().toISOString();
        return fence(
          `
            UPDATE event_outbox_deliveries
            SET status = 'dead_letter',
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = NULL,
                last_error = $1,
                last_status = $2,
                completed_at = $3,
                updated_at = $3
            WHERE id = $4 AND status = 'delivering' AND lease_owner = $5 AND lease_token = $6
          `,
          [
            input.lastError,
            input.lastStatus ?? null,
            now,
            claim.id,
            claim.leaseOwner,
            claim.leaseToken,
          ],
        );
      },

      async recoverStaleLeases(input) {
        const now = input.now.toISOString();
        const result = await pool.query(
          `
            UPDATE event_outbox_deliveries
            SET status = 'pending',
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = NULL,
                updated_at = $1
            WHERE status = 'delivering'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= $1
          `,
          [now],
        );
        return result.rowCount ?? 0;
      },

      async getNextWakeAt() {
        const result = await pool.query<{ wake_at: string | null }>(`
          SELECT MIN(wake_at) AS wake_at
          FROM (
            SELECT COALESCE(next_attempt_at, created_at) AS wake_at
            FROM event_outbox_deliveries delivery
            WHERE status = 'pending'
              AND EXISTS (
                SELECT 1
                FROM outbound_webhooks active_webhook
                WHERE active_webhook.id = delivery.webhook_id
                  AND active_webhook.enabled = true
              )
              AND NOT EXISTS (
                SELECT 1
                FROM event_outbox_deliveries earlier
                WHERE earlier.webhook_id = delivery.webhook_id
                  AND earlier.event_sequence < delivery.event_sequence
                  AND earlier.status IN ('pending', 'delivering')
              )
            UNION ALL
            SELECT lease_expires_at AS wake_at
            FROM event_outbox_deliveries delivery
            WHERE status = 'delivering'
              AND lease_expires_at IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM outbound_webhooks active_webhook
                WHERE active_webhook.id = delivery.webhook_id
                  AND active_webhook.enabled = true
              )
              AND NOT EXISTS (
                SELECT 1
                FROM event_outbox_deliveries earlier
                WHERE earlier.webhook_id = delivery.webhook_id
                  AND earlier.event_sequence < delivery.event_sequence
                  AND earlier.status IN ('pending', 'delivering')
              )
          ) candidates
        `);
        return result.rows[0]?.wake_at ?? null;
      },
    },
  };
}
