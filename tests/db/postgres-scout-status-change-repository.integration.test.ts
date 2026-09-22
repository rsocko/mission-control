import { afterAll, beforeAll, describe } from 'vitest';
import type { Pool } from 'pg';
import type { ScoutStatusChangeRepository } from '@/lib/connectors/scout/status-change-repository';
import {
  describeScoutStatusChangeRepositoryContract,
  type ScoutStatusChangeContractHarness,
} from '../contracts/scout-status-change-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)('PostgreSQL Scout status-change adapter', () => {
  let pool: Pool;
  let harness: ScoutStatusChangeContractHarness;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [{ Pool }, { createPostgresScoutStatusChangeRepository }] = await Promise.all([
      import('pg'),
      import('@/db/postgres/repositories/scout-status-change-repository'),
    ]);
    pool = new Pool({ connectionString, max: 8 });
    const repository: ScoutStatusChangeRepository =
      createPostgresScoutStatusChangeRepository(pool);
    harness = {
      repository,
      async reset() {
        await pool.query(`
          DELETE FROM tasks;
          DELETE FROM app_settings WHERE key = 'scout_write_back_synced_at';
        `);
      },
      async seed(records) {
        for (const record of records) {
          await pool.query(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, status,
              status_reason, completed_at, snoozed_until, created_at, updated_at,
              last_synced_at, metadata
            ) VALUES ($1, $2, 'scout', 'scout', $3, $4, $5, $6, $7, $8, $8, $8, $9::jsonb)
          `, [
            record.mcTaskId,
            record.sourceId,
            record.title,
            record.status,
            record.statusReason,
            record.completedAt,
            record.snoozedUntil,
            record.updatedAt,
            JSON.stringify(JSON.stringify({ sourceType: record.sourceType })),
          ]);
        }
      },
    };
  });

  afterAll(async () => {
    await harness?.reset();
    await pool?.end();
  });

  describeScoutStatusChangeRepositoryContract('PostgreSQL', () => harness);
});
