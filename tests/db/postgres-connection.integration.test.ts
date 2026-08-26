import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresDatabaseHealthProbe } from '@/db/postgres/health';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL connection integration', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const config = resolvePostgresConfig({
      MC_POSTGRES_URL: connectionString,
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-integration-test',
    });
    pool = new pg.Pool(config.pool);
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('connects and reports healthy pool state', async () => {
    const probe = new PostgresDatabaseHealthProbe(pool);
    const snapshot = await probe.inspect();

    expect(snapshot.connected).toBe(true);
    expect(snapshot.severity).toBe('healthy');
    expect(snapshot.backend.kind).toBe('postgres');
    expect(snapshot.sizeBytes).toBeGreaterThan(0);
  });

  it('supports rollback through an asynchronous transaction', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMPORARY TABLE mc_transaction_probe (
          id integer PRIMARY KEY
        ) ON COMMIT DROP
      `);
      await client.query('INSERT INTO mc_transaction_probe (id) VALUES (1)');
      await client.query('ROLLBACK');

      await expect(
        client.query('SELECT * FROM mc_transaction_probe'),
      ).rejects.toMatchObject({ code: '42P01' });
    } finally {
      client.release();
    }
  });
});
