import { afterAll, beforeAll, describe } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresNotificationPushRepository } from '@/db/postgres/repositories/notification-push-repository';
import {
  describeNotificationPushRepositoryContract,
  NOTIFICATION_PUSH_TEST_TIME,
  type NotificationPushContractHarness,
} from '../contracts/notification-push-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL ?? process.env.PG_TEST_URL;

describe.skipIf(!connectionString)('PostgreSQL notification push repository', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (!connectionString) throw new Error('PostgreSQL test URL is required');
    assertSafeIntegrationTestTarget(connectionString);
    const { Pool: PostgresPool } = await import('pg');
    pool = new PostgresPool({
      connectionString,
      application_name: 'mission-control-notification-push-test',
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM connector_configs WHERE id LIKE 'calendar-%'`);
    await pool.query(`DELETE FROM push_preferences WHERE id = 'default'`);
    await pool.query(`
      DELETE FROM app_settings
      WHERE key IN ('push_delivery_enabled', 'scheduled_summaries_enabled')
    `);
    await pool.end();
  });

  describeNotificationPushRepositoryContract(async () => ({
    repository: createPostgresNotificationPushRepository(pool),
    async reset() {
      await pool.query(`DELETE FROM connector_configs WHERE id LIKE 'calendar-%'`);
      await pool.query(`DELETE FROM push_preferences WHERE id = 'default'`);
      await pool.query(`
        DELETE FROM app_settings
        WHERE key IN ('push_delivery_enabled', 'scheduled_summaries_enabled')
      `);
    },
    async seedSetting(key, value) {
      await pool.query(
        `
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        `,
        [key, JSON.stringify(value), NOTIFICATION_PUSH_TEST_TIME],
      );
    },
    async seedCalendarConnector(input) {
      await pool.query(
        `
          INSERT INTO connector_configs (
            id, type, name, enabled, sync_mode, capabilities, credentials,
            settings, synced_lists, created_at, updated_at, deleted_at
          ) VALUES ($1, 'outlook-calendar', 'Calendar', $2, 'poll', '{}', $3::jsonb,
                    '{}', '[]', $4, $4, $5)
        `,
        [
          input.id,
          input.enabled !== false,
          JSON.stringify(input.credentials),
          NOTIFICATION_PUSH_TEST_TIME,
          input.deleted ? NOTIFICATION_PUSH_TEST_TIME : null,
        ],
      );
    },
  }));
});
