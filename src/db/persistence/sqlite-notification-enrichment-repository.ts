import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  parseNotificationEnrichmentPayload,
  type ClaimedNotificationEnrichmentJob,
  type NotificationEnrichmentRepository,
} from './notification-enrichment';

interface ClaimRow {
  id: string;
  notification_id: string;
  source_id: string;
  source_revision: string;
  source_generation: number;
  payload: unknown;
  attempt_count: number;
  lease_owner: string;
  lease_token: string;
  lease_expires_at: string;
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored notification metadata must be an object');
  }
  return parsed as Record<string, unknown>;
}

export function createSqliteNotificationEnrichmentRepository(
  sqlite: Database.Database,
): NotificationEnrichmentRepository {
  const claimNext = sqlite.prepare(`
    UPDATE notification_enrichment_jobs
    SET status = 'processing',
        attempt_count = attempt_count + 1,
        next_attempt_at = NULL,
        lease_owner = @owner,
        lease_token = @token,
        lease_expires_at = @leaseExpiresAt,
        updated_at = @now
    WHERE id = (
      SELECT id
      FROM notification_enrichment_jobs
      WHERE (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= @now))
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
      )
      ORDER BY created_at, id
      LIMIT 1
    )
      AND (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= @now))
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
      )
    RETURNING *
  `);
  const poison = sqlite.prepare(`
    UPDATE notification_enrichment_jobs
    SET status = 'dead_letter',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error = 'invalid_payload',
        completed_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_owner = ? AND lease_token = ?
  `);

  return {
    async claimNext(input) {
      const now = input.now.toISOString();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
      for (let scanned = 0; scanned < 25; scanned += 1) {
        const row = claimNext.get({
          owner: input.owner,
          token: randomUUID(),
          leaseExpiresAt,
          now,
        }) as ClaimRow | undefined;
        if (!row) return null;
        try {
          const payload = parseNotificationEnrichmentPayload(row.payload);
          if (payload.notificationId !== row.notification_id) {
            throw new Error('Stored notification enrichment payload has a mismatched notification');
          }
          return {
            id: row.id,
            notificationId: row.notification_id,
            sourceId: row.source_id,
            sourceRevision: row.source_revision,
            sourceGeneration: row.source_generation,
            payload,
            attemptCount: row.attempt_count,
            leaseOwner: row.lease_owner,
            leaseToken: row.lease_token,
            leaseExpiresAt: row.lease_expires_at,
          } satisfies ClaimedNotificationEnrichmentJob;
        } catch {
          poison.run(now, now, row.id, row.lease_owner, row.lease_token);
        }
      }
      return null;
    },

    async heartbeat(claim, leaseExpiresAt) {
      return sqlite.prepare(`
        UPDATE notification_enrichment_jobs
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ? AND lease_token = ?
      `).run(
        leaseExpiresAt,
        new Date().toISOString(),
        claim.id,
        claim.leaseOwner,
        claim.leaseToken,
      ).changes === 1;
    },

    async complete(claim, input) {
      return sqlite.transaction(() => {
        const job = sqlite.prepare(`
          SELECT id
          FROM notification_enrichment_jobs
          WHERE id = ? AND status = 'processing' AND lease_owner = ? AND lease_token = ?
        `).get(claim.id, claim.leaseOwner, claim.leaseToken);
        if (!job) return 'fenced' as const;
        const notification = sqlite.prepare(`
          SELECT metadata
          FROM notifications
          WHERE id = ? AND source_id = ? AND enrichment_revision = ?
            AND enrichment_generation = ?
            AND source_state <> 'deleted'
        `).get(
          claim.notificationId,
          claim.sourceId,
          claim.sourceRevision,
          claim.sourceGeneration,
        ) as { metadata: unknown } | undefined;
        const status = notification ? 'completed' : 'superseded';
        if (notification) {
          sqlite.prepare(`
            UPDATE notifications
            SET metadata = ?
            WHERE id = ? AND source_id = ? AND enrichment_revision = ?
              AND enrichment_generation = ?
              AND source_state <> 'deleted'
          `).run(
            JSON.stringify({ ...parseObject(notification.metadata), ...input.metadata }),
            claim.notificationId,
            claim.sourceId,
            claim.sourceRevision,
            claim.sourceGeneration,
          );
        }
        sqlite.prepare(`
          UPDATE notification_enrichment_jobs
          SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              next_attempt_at = NULL, last_error = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ? AND lease_token = ?
        `).run(
          status,
          input.completedAt,
          input.completedAt,
          claim.id,
          claim.leaseOwner,
          claim.leaseToken,
        );
        return status;
      }).immediate();
    },

    async scheduleRetry(claim, input) {
      return sqlite.prepare(`
        UPDATE notification_enrichment_jobs
        SET status = 'pending', lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ? AND lease_token = ?
      `).run(
        input.nextAttemptAt,
        input.lastError,
        new Date().toISOString(),
        claim.id,
        claim.leaseOwner,
        claim.leaseToken,
      ).changes === 1;
    },

    async deadLetter(claim, input) {
      return sqlite.prepare(`
        UPDATE notification_enrichment_jobs
        SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, next_attempt_at = NULL, last_error = ?,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ? AND lease_token = ?
      `).run(
        input.lastError,
        input.completedAt,
        input.completedAt,
        claim.id,
        claim.leaseOwner,
        claim.leaseToken,
      ).changes === 1;
    },

    async recoverStaleLeases(input) {
      const now = input.now.toISOString();
      return sqlite.prepare(`
        UPDATE notification_enrichment_jobs
        SET status = 'pending', lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(now, now).changes;
    },

    async getNextWakeAt() {
      const row = sqlite.prepare(`
        SELECT MIN(wake_at) AS wake_at
        FROM (
          SELECT COALESCE(next_attempt_at, created_at) AS wake_at
          FROM notification_enrichment_jobs
          WHERE status = 'pending'
          UNION ALL
          SELECT lease_expires_at AS wake_at
          FROM notification_enrichment_jobs
          WHERE status = 'processing' AND lease_expires_at IS NOT NULL
        )
      `).get() as { wake_at: string | null } | undefined;
      return row?.wake_at ?? null;
    },
  };
}
