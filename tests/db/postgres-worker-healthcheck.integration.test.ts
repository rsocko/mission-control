import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runPostgresMigrations } from '@/db/postgres/migrations';
import { runWorkerHealthcheck } from '@/lib/runtime/worker-healthcheck';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const integration = connectionString ? describe : describe.skip;
const instanceId = `healthcheck-${process.pid}-${Date.now()}`;
const { Pool } = pg;
let setupPool: pg.Pool;

integration('PostgreSQL worker healthcheck integration', () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
    assertSafeIntegrationTestTarget(connectionString);
    setupPool = new Pool({ connectionString });
    await runPostgresMigrations(setupPool);
  });

  afterAll(async () => {
    if (!setupPool) return;
    await setupPool.query(
      'DELETE FROM runtime_telemetry WHERE role = $1 AND instance_id = $2',
      ['worker', instanceId],
    );
    await setupPool.end();
  });

  it('reads the current worker heartbeat from PostgreSQL without touching SQLite', async () => {
    const heartbeatAt = new Date().toISOString();
    await setupPool.query(
      `
        INSERT INTO runtime_telemetry (
          role, instance_id, pid, started_at, heartbeat_at, metrics
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (role) DO UPDATE SET
          instance_id = EXCLUDED.instance_id,
          pid = EXCLUDED.pid,
          started_at = EXCLUDED.started_at,
          heartbeat_at = EXCLUDED.heartbeat_at,
          metrics = EXCLUDED.metrics
      `,
      ['worker', instanceId, process.pid, heartbeatAt, heartbeatAt, '{}'],
    );
    const openSQLite = vi.fn(() => {
      throw new Error('SQLite must not be loaded for PostgreSQL health');
    });

    await runWorkerHealthcheck(
      {
        MC_DATABASE_BACKEND: 'postgres',
        MC_POSTGRES_URL: connectionString,
        MC_PROCESS_ROLE: 'worker',
        MC_DB_PATH: 'poisoned-and-missing.db',
        MC_WORKER_HEALTH_QUERY_TIMEOUT_MS: '5000',
      },
      {
        readInstanceFile: vi.fn(async () => instanceId),
        openSQLite,
      },
    );

    expect(openSQLite).not.toHaveBeenCalled();
  });

  it('fails closed when the PostgreSQL heartbeat is stale or missing', async () => {
    await setupPool.query(
      `
        UPDATE runtime_telemetry
        SET heartbeat_at = $1
        WHERE role = 'worker' AND instance_id = $2
      `,
      ['2020-01-01T00:00:00.000Z', instanceId],
    );
    const env = {
      MC_DATABASE_BACKEND: 'postgres',
      MC_POSTGRES_URL: connectionString,
      MC_WORKER_HEALTH_STALE_MS: '1000',
    };

    await expect(runWorkerHealthcheck(env, {
      readInstanceFile: vi.fn(async () => instanceId),
    })).rejects.toThrow('stale or invalid');

    await expect(runWorkerHealthcheck(env, {
      readInstanceFile: vi.fn(async () => 'missing-worker'),
    })).rejects.toThrow('telemetry heartbeat for the current worker instance is missing');
  });
});
