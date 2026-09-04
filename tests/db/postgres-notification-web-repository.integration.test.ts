import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  notificationWebRepositoryContractSuite,
  type ContractSeedNotificationAction,
  type ContractSeedNotification,
  type ContractSeedWritebackJob,
  type ContractSeededJob,
  type ContractSeededNotification,
  type NotificationWebContractSeed,
} from '../contracts/notification-web-repository.contract';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

/**
 * PostgreSQL integration tests for NotificationWebPersistence.
 * Requires a live PostgreSQL connection (skipped in CI without PG_TEST_URL).
 */
describe('PostgreSQL NotificationWebPersistence integration', () => {
  const PG_URL = process.env.PG_TEST_URL;

  it.skipIf(!PG_URL)('connects to PostgreSQL and creates the repository', async () => {
    const { createPostgresNotificationWebRepository } = await import(
      '@/db/postgres/repositories/notification-web-repository'
    );
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: PG_URL });
    try {
      const repo = createPostgresNotificationWebRepository(pool);
      expect(repo).toBeDefined();
      const views = await repo.listSavedViews();
      expect(Array.isArray(views)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it.skipIf(!PG_URL)('subscription idempotency', async () => {
    const { createPostgresNotificationWebRepository } = await import(
      '@/db/postgres/repositories/notification-web-repository'
    );
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: PG_URL });
    try {
      const repo = createPostgresNotificationWebRepository(pool);
      const endpoint = `https://fcm.googleapis.com/test-${Date.now()}`;
      const id = await repo.registerSubscription({
        endpoint,
        keys: { p256dh: 'key1', auth: 'auth1' },
        userAgent: null,
      });
      expect(typeof id).toBe('string');
      const found = await repo.findSubscriptionByEndpoint(endpoint);
      expect(found?.id).toBe(id);
      await repo.removeSubscription(endpoint);
      const gone = await repo.findSubscriptionByEndpoint(endpoint);
      expect(gone).toBeNull();
    } finally {
      await pool.end();
    }
  });
});

// Run the shared backend-parity contract suite against a live PostgreSQL
// connection so that ordering, lifecycle, writeback claim/lease/retry, and
// JSONB/boolean/null marshalling are verified identically to the SQLite adapter.
describe.skipIf(!process.env.PG_TEST_URL)('PostgreSQL NotificationWebPersistence contract', () => {
  const PG_URL = process.env.PG_TEST_URL;
  let pool: import('pg').Pool;
  let repo: NotificationWebPersistence;
  let seed: NotificationWebContractSeed;

  beforeAll(async () => {
    const { createPostgresNotificationWebRepository } = await import(
      '@/db/postgres/repositories/notification-web-repository'
    );
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: PG_URL });
    repo = createPostgresNotificationWebRepository(pool);
    seed = createPostgresContractSeed(pool);
    // Start the shared-database interface tests from a clean slate.
    await seed.reset();
  });

  afterAll(async () => {
    await seed?.reset();
    await pool?.end();
  });

  notificationWebRepositoryContractSuite(
    () => 'PostgreSQL',
    () => repo,
    () => seed,
  );
});

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function createPostgresContractSeed(pool: import('pg').Pool): NotificationWebContractSeed {
  return {
    async reset() {
      await pool.query('DELETE FROM notification_writeback_jobs');
      await pool.query('DELETE FROM notification_saved_views');
      await pool.query('DELETE FROM push_subscriptions');
      await pool.query('DELETE FROM notification_actions');
      await pool.query('DELETE FROM notifications');
    },
    async insertNotification(row: ContractSeedNotification) {
      await pool.query(
        `INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id,
          title, received_at, sort_at, metadata, presentation, is_actionable
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id, row.sourceId, row.connectorType, row.connectorInstanceId,
          row.title, row.receivedAt, row.sortAt,
          JSON.stringify(row.metadata ?? {}),
          JSON.stringify(row.presentation ?? {}),
          row.isActionable ?? false,
        ],
      );
    },
    async insertNotificationAction(row: ContractSeedNotificationAction) {
      await pool.query(
        `INSERT INTO notification_actions (
          id, notification_id, action_type, label, is_primary, payload,
          opens_external, requires_confirmation
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.id,
          row.notificationId,
          row.actionType,
          row.label,
          row.isPrimary ?? false,
          JSON.stringify(row.payload ?? {}),
          row.opensExternal ?? false,
          row.requiresConfirmation ?? false,
        ],
      );
    },
    async insertWritebackJob(row: ContractSeedWritebackJob) {
      await pool.query(
        `INSERT INTO notification_writeback_jobs (
          id, notification_id, connector_instance_id, connector_type, source_id,
          action_type, dedupe_key, status, retryable, attempt_count, max_attempts,
          next_attempt_at, lease_expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.id, row.notificationId, row.connectorInstanceId, row.connectorType, row.sourceId,
          row.actionType, row.dedupeKey, row.status, row.retryable,
          row.attemptCount, row.maxAttempts, row.nextAttemptAt, row.leaseExpiresAt,
          row.createdAt, row.updatedAt,
        ],
      );
    },
    async getNotification(id: string): Promise<ContractSeededNotification | null> {
      const { rows } = await pool.query(
        `SELECT read_state AS "readState", disposition, sync_state AS "syncState",
                muted_at AS "mutedAt", presentation
         FROM notifications WHERE id = $1`,
        [id],
      );
      const row = rows[0] as (ContractSeededNotification & { mutedAt: unknown }) | undefined;
      if (!row) return null;
      return { ...row, mutedAt: toIso(row.mutedAt) };
    },
    async listWritebackJobs(notificationId?: string): Promise<ContractSeededJob[]> {
      const { rows } = await pool.query(
        `SELECT id, notification_id AS "notificationId", status,
                retryable, attempt_count AS "attemptCount", max_attempts AS "maxAttempts",
                next_attempt_at AS "nextAttemptAt", lease_expires_at AS "leaseExpiresAt",
                last_error AS "lastError"
         FROM notification_writeback_jobs
         ${notificationId ? 'WHERE notification_id = $1' : ''}
         ORDER BY created_at ASC, id ASC`,
        notificationId ? [notificationId] : [],
      );
      return (rows as Array<ContractSeededJob & { retryable: boolean; nextAttemptAt: unknown; leaseExpiresAt: unknown }>).map(row => ({
        ...row,
        retryable: row.retryable === true,
        nextAttemptAt: toIso(row.nextAttemptAt),
        leaseExpiresAt: toIso(row.leaseExpiresAt),
      }));
    },
  };
}
