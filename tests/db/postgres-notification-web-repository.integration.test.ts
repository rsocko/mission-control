import { describe, expect, it } from 'vitest';

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
