import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  parseNotificationEnrichmentPayload,
  type ClaimedNotificationEnrichmentJob,
  type NotificationEnrichmentRepository,
} from '@/db/persistence/notification-enrichment';

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

export function createPostgresNotificationEnrichmentRepository(
  pool: Pool,
): NotificationEnrichmentRepository {
  async function fence(sql: string, values: unknown[]): Promise<boolean> {
    return (await pool.query(sql, values)).rowCount === 1;
  }

  return {
    async claimNext(input) {
      const now = input.now.toISOString();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
      for (let scanned = 0; scanned < 25; scanned += 1) {
        const result = await pool.query<ClaimRow>(
          `
            WITH candidate AS (
              SELECT id
              FROM notification_enrichment_jobs
              WHERE (
                (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
                OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1)
              )
              ORDER BY created_at, id
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
            UPDATE notification_enrichment_jobs job
            SET status = 'processing',
                attempt_count = job.attempt_count + 1,
                next_attempt_at = NULL,
                lease_owner = $2,
                lease_token = $3,
                lease_expires_at = $4,
                updated_at = $1
            FROM candidate
            WHERE job.id = candidate.id
            RETURNING job.*
          `,
          [now, input.owner, randomUUID(), leaseExpiresAt],
        );
        const row = result.rows[0];
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
          await pool.query(
            `
              UPDATE notification_enrichment_jobs
              SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL,
                  lease_expires_at = NULL, next_attempt_at = NULL,
                  last_error = 'invalid_payload', completed_at = $1, updated_at = $1
              WHERE id = $2 AND status = 'processing' AND lease_owner = $3 AND lease_token = $4
            `,
            [now, row.id, row.lease_owner, row.lease_token],
          );
        }
      }
      return null;
    },

    async heartbeat(claim, leaseExpiresAt) {
      return fence(
        `
          UPDATE notification_enrichment_jobs
          SET lease_expires_at = $1, updated_at = $2
          WHERE id = $3 AND status = 'processing' AND lease_owner = $4 AND lease_token = $5
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

    async complete(claim, input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const held = await client.query(
          `
            SELECT id
            FROM notification_enrichment_jobs
            WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_token = $3
            FOR UPDATE
          `,
          [claim.id, claim.leaseOwner, claim.leaseToken],
        );
        if (held.rowCount !== 1) {
          await client.query('ROLLBACK');
          return 'fenced';
        }
        const updated = await client.query(
          `
            UPDATE notifications
            SET metadata = metadata || $1::jsonb
            WHERE id = $2 AND source_id = $3 AND enrichment_revision = $4
              AND enrichment_generation = $5
              AND source_state <> 'deleted'
          `,
          [
            JSON.stringify(input.metadata),
            claim.notificationId,
            claim.sourceId,
            claim.sourceRevision,
            claim.sourceGeneration,
          ],
        );
        const status = updated.rowCount === 1 ? 'completed' : 'superseded';
        await client.query(
          `
            UPDATE notification_enrichment_jobs
            SET status = $1, lease_owner = NULL, lease_token = NULL,
                lease_expires_at = NULL, next_attempt_at = NULL, last_error = NULL,
                completed_at = $2, updated_at = $2
            WHERE id = $3 AND status = 'processing' AND lease_owner = $4 AND lease_token = $5
          `,
          [status, input.completedAt, claim.id, claim.leaseOwner, claim.leaseToken],
        );
        await client.query('COMMIT');
        return status;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async scheduleRetry(claim, input) {
      return fence(
        `
          UPDATE notification_enrichment_jobs
          SET status = 'pending', lease_owner = NULL, lease_token = NULL,
              lease_expires_at = NULL, next_attempt_at = $1, last_error = $2, updated_at = $3
          WHERE id = $4 AND status = 'processing' AND lease_owner = $5 AND lease_token = $6
        `,
        [
          input.nextAttemptAt,
          input.lastError,
          new Date().toISOString(),
          claim.id,
          claim.leaseOwner,
          claim.leaseToken,
        ],
      );
    },

    async deadLetter(claim, input) {
      return fence(
        `
          UPDATE notification_enrichment_jobs
          SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL,
              lease_expires_at = NULL, next_attempt_at = NULL, last_error = $1,
              completed_at = $2, updated_at = $2
          WHERE id = $3 AND status = 'processing' AND lease_owner = $4 AND lease_token = $5
        `,
        [input.lastError, input.completedAt, claim.id, claim.leaseOwner, claim.leaseToken],
      );
    },

    async recoverStaleLeases(input) {
      const now = input.now.toISOString();
      return (await pool.query(
        `
          UPDATE notification_enrichment_jobs
          SET status = 'pending', lease_owner = NULL, lease_token = NULL,
              lease_expires_at = NULL, next_attempt_at = NULL, updated_at = $1
          WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1
        `,
        [now],
      )).rowCount ?? 0;
    },

    async getNextWakeAt() {
      const result = await pool.query<{ wake_at: string | null }>(`
        SELECT MIN(wake_at) AS wake_at
        FROM (
          SELECT COALESCE(next_attempt_at, created_at) AS wake_at
          FROM notification_enrichment_jobs
          WHERE status = 'pending'
          UNION ALL
          SELECT lease_expires_at AS wake_at
          FROM notification_enrichment_jobs
          WHERE status = 'processing' AND lease_expires_at IS NOT NULL
        ) candidates
      `);
      return result.rows[0]?.wake_at ?? null;
    },
  };
}
