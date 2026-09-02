import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  eventSubscriptionMatches,
  parseEventOutboxPayload,
  parseEventTypes,
  type ClaimedEventDelivery,
  type EventDeliveryRepositories,
  type EventOutboxEnqueueRequest,
  type EventOutboxEnqueueResult,
  type EventSubscriptionRecord,
} from './event-outbox';

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  event_types: unknown;
  enabled: number;
}

interface ClaimRow {
  id: string;
  event_sequence: number;
  attempt_count: number;
  lease_owner: string;
  lease_token: string;
  lease_expires_at: string;
}

interface ClaimContextRow {
  stable_key: string;
  event_type: string;
  payload: unknown;
  occurred_at: string;
  webhook_id: string;
  webhook_name: string;
  webhook_url: string;
  webhook_secret: string | null;
  webhook_event_types: unknown;
  webhook_enabled: number;
}

function toSubscription(row: WebhookRow): EventSubscriptionRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret,
    eventTypes: parseEventTypes(row.event_types),
    enabled: row.enabled === 1,
  };
}

/**
 * Transaction-scoped enqueue. Deliberately synchronous so it can be invoked
 * from inside a `better-sqlite3` transaction (for example the terminal sync-job
 * finalizer), making the outbox write atomic with the state transition that
 * justifies it. Re-enqueueing an existing `stableKey` is a no-op.
 */
export function enqueueSqliteEventOutbox(
  sqlite: Database.Database,
  request: EventOutboxEnqueueRequest,
): EventOutboxEnqueueResult {
  const now = new Date().toISOString();
  const inserted = sqlite.prepare(`
    INSERT INTO event_outbox (stable_key, event_type, payload, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (stable_key) DO NOTHING
    RETURNING sequence
  `).get(
    request.stableKey,
    request.eventType,
    JSON.stringify(request.payload),
    request.occurredAt,
    now,
  ) as { sequence: number } | undefined;

  if (!inserted) {
    const existing = sqlite.prepare(
      'SELECT sequence FROM event_outbox WHERE stable_key = ?',
    ).get(request.stableKey) as { sequence: number } | undefined;
    if (!existing) {
      throw new Error('Event outbox enqueue conflicted without a resolvable existing row');
    }
    return { created: false, sequence: existing.sequence, deliveryCount: 0 };
  }

  const webhooks = sqlite.prepare(`
    SELECT id, name, url, secret, event_types, enabled
    FROM outbound_webhooks
    WHERE enabled = 1
  `).all() as WebhookRow[];
  const matching = webhooks
    .map(toSubscription)
    .filter((subscription) => eventSubscriptionMatches(subscription, request.eventType));

  const insertDelivery = sqlite.prepare(`
    INSERT INTO event_outbox_deliveries (
      id, event_sequence, webhook_id, status, attempt_count, created_at, updated_at
    )
    VALUES (?, ?, ?, 'pending', 0, ?, ?)
    ON CONFLICT (event_sequence, webhook_id) DO NOTHING
  `);
  const nextDeliveryId = request.deliveryIdFactory ?? randomUUID;
  let deliveryCount = 0;
  for (const subscription of matching) {
    const result = insertDelivery.run(
      nextDeliveryId(),
      inserted.sequence,
      subscription.id,
      now,
      now,
    );
    deliveryCount += result.changes;
  }

  return { created: true, sequence: inserted.sequence, deliveryCount };
}

export function createSqliteEventDeliveryRepositories(
  sqlite: Database.Database,
): EventDeliveryRepositories {
  const enqueueTransaction = sqlite.transaction(
    (request: EventOutboxEnqueueRequest) => enqueueSqliteEventOutbox(sqlite, request),
  );

  /**
   * Claims the oldest claimable delivery. The `NOT EXISTS` guard enforces
   * deterministic per-webhook ordering: a webhook only becomes claimable at its
   * lowest outstanding sequence, so a receiver never observes event N+1 before
   * event N. Expired `delivering` rows are reclaimable in the same statement,
   * which is the SQLite equivalent of PostgreSQL's `FOR UPDATE SKIP LOCKED`
   * single-row claim.
   */
  const claimNext = sqlite.prepare(`
    UPDATE event_outbox_deliveries
    SET status = 'delivering',
        attempt_count = attempt_count + 1,
        lease_owner = @owner,
        lease_token = @token,
        lease_expires_at = @leaseExpiresAt,
        next_attempt_at = NULL,
        updated_at = @now
    WHERE id = (
      SELECT d.id
      FROM event_outbox_deliveries d
      WHERE (
          (d.status = 'pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= @now))
          OR (
            d.status = 'delivering'
            AND d.lease_expires_at IS NOT NULL
            AND d.lease_expires_at <= @now
          )
        )
        AND EXISTS (
          SELECT 1
          FROM outbound_webhooks active_webhook
          WHERE active_webhook.id = d.webhook_id
            AND active_webhook.enabled = 1
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
    )
      AND (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= @now))
        OR (
          status = 'delivering'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= @now
        )
      )
    RETURNING id, event_sequence, attempt_count, lease_owner, lease_token, lease_expires_at
  `);

  const loadClaimContext = sqlite.prepare(`
    SELECT e.stable_key, e.event_type, e.payload, e.occurred_at,
           w.id AS webhook_id, w.name AS webhook_name, w.url AS webhook_url,
           w.secret AS webhook_secret, w.event_types AS webhook_event_types,
           w.enabled AS webhook_enabled
    FROM event_outbox_deliveries d
    JOIN event_outbox e ON e.sequence = d.event_sequence
    JOIN outbound_webhooks w ON w.id = d.webhook_id
    WHERE d.id = ?
  `);

  const rejectPoisoned = sqlite.prepare(`
    UPDATE event_outbox_deliveries
    SET status = 'dead_letter',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'delivering' AND lease_token = ?
  `);

  return {
    subscriptions: {
      async listMatching(eventType) {
        const rows = sqlite.prepare(`
          SELECT id, name, url, secret, event_types, enabled
          FROM outbound_webhooks
          WHERE enabled = 1
        `).all() as WebhookRow[];
        return rows
          .map(toSubscription)
          .filter((subscription) => eventSubscriptionMatches(subscription, eventType));
      },

      async recordDeliveryOutcome(input) {
        sqlite.prepare(`
          UPDATE outbound_webhooks
          SET last_triggered_at = ?, last_status = ?
          WHERE id = ?
        `).run(input.triggeredAt, input.status, input.webhookId);
      },
    },

    outbox: {
      async enqueue(request) {
        return enqueueTransaction(request);
      },

      async claimNext(input) {
        const now = input.now.toISOString();
        const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
        for (let scanned = 0; scanned < 25; scanned += 1) {
          const row = claimNext.get({
            now,
            owner: input.owner,
            token: randomUUID(),
            leaseExpiresAt,
          }) as ClaimRow | undefined;
          if (!row) return null;

          const context = loadClaimContext.get(row.id) as ClaimContextRow | undefined;
          if (!context) {
            rejectPoisoned.run('missing_event_context', now, now, row.id, row.lease_token);
            continue;
          }
          let payload: Record<string, unknown>;
          try {
            payload = parseEventOutboxPayload(context.payload);
          } catch {
            rejectPoisoned.run('invalid_payload', now, now, row.id, row.lease_token);
            continue;
          }
          return {
            id: row.id,
            eventSequence: row.event_sequence,
            eventType: context.event_type,
            stableKey: context.stable_key,
            payload,
            occurredAt: context.occurred_at,
            attemptCount: row.attempt_count,
            webhook: toSubscription({
              id: context.webhook_id,
              name: context.webhook_name,
              url: context.webhook_url,
              secret: context.webhook_secret,
              event_types: context.webhook_event_types,
              enabled: context.webhook_enabled,
            }),
            leaseOwner: row.lease_owner,
            leaseToken: row.lease_token,
            leaseExpiresAt: row.lease_expires_at,
          } satisfies ClaimedEventDelivery;
        }
        return null;
      },

      async heartbeat(claim, leaseExpiresAt) {
        const result = sqlite.prepare(`
          UPDATE event_outbox_deliveries
          SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'delivering' AND lease_owner = ? AND lease_token = ?
        `).run(
          leaseExpiresAt,
          new Date().toISOString(),
          claim.id,
          claim.leaseOwner,
          claim.leaseToken,
        );
        return result.changes === 1;
      },

      async markDelivered(claim, input) {
        const result = sqlite.prepare(`
          UPDATE event_outbox_deliveries
          SET status = 'delivered',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              next_attempt_at = NULL,
              last_error = NULL,
              last_status = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ? AND status = 'delivering' AND lease_owner = ? AND lease_token = ?
        `).run(
          input.lastStatus,
          input.deliveredAt,
          input.deliveredAt,
          claim.id,
          claim.leaseOwner,
          claim.leaseToken,
        );
        return result.changes === 1;
      },

      async scheduleRetry(claim, input) {
        const result = sqlite.prepare(`
          UPDATE event_outbox_deliveries
          SET status = 'pending',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              next_attempt_at = ?,
              last_error = ?,
              last_status = ?,
              updated_at = ?
          WHERE id = ? AND status = 'delivering' AND lease_owner = ? AND lease_token = ?
        `).run(
          input.nextAttemptAt,
          input.lastError,
          input.lastStatus ?? null,
          new Date().toISOString(),
          claim.id,
          claim.leaseOwner,
          claim.leaseToken,
        );
        return result.changes === 1;
      },

      async deadLetter(claim, input) {
        const now = new Date().toISOString();
        const result = sqlite.prepare(`
          UPDATE event_outbox_deliveries
          SET status = 'dead_letter',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              next_attempt_at = NULL,
              last_error = ?,
              last_status = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ? AND status = 'delivering' AND lease_owner = ? AND lease_token = ?
        `).run(
          input.lastError,
          input.lastStatus ?? null,
          now,
          now,
          claim.id,
          claim.leaseOwner,
          claim.leaseToken,
        );
        return result.changes === 1;
      },

      async recoverStaleLeases(input) {
        const now = input.now.toISOString();
        const result = sqlite.prepare(`
          UPDATE event_outbox_deliveries
          SET status = 'pending',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              next_attempt_at = NULL,
              updated_at = ?
          WHERE status = 'delivering'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
        `).run(now, now);
        return result.changes;
      },

      async getNextWakeAt() {
        const row = sqlite.prepare(`
          SELECT MIN(wake_at) AS wake_at
          FROM (
            SELECT COALESCE(next_attempt_at, created_at) AS wake_at
            FROM event_outbox_deliveries delivery
            WHERE status = 'pending'
              AND EXISTS (
                SELECT 1
                FROM outbound_webhooks active_webhook
                WHERE active_webhook.id = delivery.webhook_id
                  AND active_webhook.enabled = 1
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
                  AND active_webhook.enabled = 1
              )
              AND NOT EXISTS (
                SELECT 1
                FROM event_outbox_deliveries earlier
                WHERE earlier.webhook_id = delivery.webhook_id
                  AND earlier.event_sequence < delivery.event_sequence
                  AND earlier.status IN ('pending', 'delivering')
              )
          )
        `).get() as { wake_at: string | null } | undefined;
        return row?.wake_at ?? null;
      },
    },
  };
}
