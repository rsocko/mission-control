import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createPostgresPool } from '@/db/postgres/connection';
import { resolvePostgresConfig } from '@/db/postgres/config';
import {
  copyAllTables,
  runSqliteToPostgresImport,
} from '../../scripts/lib/sqlite-to-postgres-import';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const sharedPostgresUrl = process.env.MC_TEST_POSTGRES_IMPORT_URL
  ?? process.env.MC_TEST_POSTGRES_URL;
const describePostgresImport = describe.skipIf(!sharedPostgresUrl);

describePostgresImport('SQLite-to-PostgreSQL import integration', () => {
  const databaseName = `mission_control_import_test_${process.pid}_${Date.now()}`;
  let postgresUrl = '';
  let adminPool: ReturnType<typeof createPostgresPool> | undefined;

  beforeAll(async () => {
    if (!sharedPostgresUrl) return;
    if (!/^mission_control_import_test_\d+_\d+$/.test(databaseName)) {
      throw new Error('Generated PostgreSQL importer test database name is unsafe.');
    }
    const adminUrl = new URL(sharedPostgresUrl);
    adminUrl.pathname = '/postgres';
    const targetUrl = new URL(sharedPostgresUrl);
    targetUrl.pathname = `/${databaseName}`;
    postgresUrl = targetUrl.toString();
    assertSafeIntegrationTestTarget(postgresUrl);
    adminPool = createPostgresPool(resolvePostgresConfig({
      MC_POSTGRES_URL: adminUrl.toString(),
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-import-test-admin',
    }));
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  });

  afterAll(async () => {
    if (!adminPool) return;
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      const remaining = await adminPool.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
        [databaseName],
      );
      expect(remaining.rows[0]?.exists).toBe(false);
    } finally {
      await adminPool.end();
    }
  });

  it('imports a synthetic persisted-state fixture and rebuilds derived search state', async () => {
    assertSafeIntegrationTestTarget(postgresUrl);

    const result = await runSqliteToPostgresImport({
      fixtureId: 'v1-0047-durable-sync-queue',
      postgresUrl,
      rehearsal: true,
      resetDisposableRehearsalTarget: true,
    });

    expect(result.evidence.command.activationChanged).toBe(false);
    expect(result.evidence.verdict.ready_for_cutover_planning).toBe(true);
    expect(result.invariants).toMatchObject({
      allCopiedTableCountsMatch: true,
      orphanTaskProjects: 0,
      orphanTaskDependencies: 0,
      orphanSyncJobEvents: 0,
      orphanNotificationTasks: 0,
    });
    expect(result.invariants?.taskSearchDocuments).toBe(
      result.copiedTables.find((count) => count.table === 'tasks')?.sourceRows,
    );
    expect(result.invariants?.notificationSearchDocuments).toBe(
      result.copiedTables.find((count) => count.table === 'notifications')?.sourceRows,
    );

    const pool = createPostgresPool(resolvePostgresConfig({
      MC_POSTGRES_URL: postgresUrl,
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-import-integration-test',
    }));
    try {
      const sequence = await pool.query<{ id: number }>(
        "INSERT INTO task_history_events (task_id, event_type, occurred_at, recorded_at, provenance) VALUES ('fixture-task-0047', 'integration_probe', '2026-01-15T12:00:00.000Z', '2026-01-15T12:00:00.000Z', 'test') RETURNING id",
      );
      expect(sequence.rows[0]?.id).toBeGreaterThan(0);
      const search = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM task_search_documents WHERE search_vector @@ websearch_to_tsquery('english', 'cobaltqueue')",
      );
      expect(Number(search.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it('preserves JSON scalars, containers, nulls, duplicate keys, and large values live', async () => {
    assertSafeIntegrationTestTarget(postgresUrl);
    const pool = createPostgresPool(resolvePostgresConfig({
      MC_POSTGRES_URL: postgresUrl,
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-json-import-integration-test',
    }));
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE json_import_probe (id TEXT PRIMARY KEY, payload)');
    const probeColumns = [
      {
        name: 'id',
        dataType: 'text',
        udtName: 'text',
        nullable: false,
        hasDefault: false,
        generated: false,
      },
      {
        name: 'payload',
        dataType: 'jsonb',
        udtName: 'jsonb',
        nullable: true,
        hasDefault: false,
        generated: false,
      },
    ] as const;
    const values: Array<[string, unknown]> = [
      ['object', '{"safe":true}'],
      ['array', '[1,2,3]'],
      ['string', '"legacy string scalar"'],
      ['unicode', '"café 世界"'],
      ['number', '42'],
      ['precise-number', '123456789012345678901234567890.12345678901234567890'],
      ['max-integer-scale', '1e131071'],
      ['max-fractional-scale', '1e-16383'],
      ['boolean', 'true'],
      ['json-null', 'null'],
      ['sql-null', null],
      ['duplicate', '{"key":1,"key":2}'],
      ['large', JSON.stringify('x'.repeat(1_000_000))],
    ];
    const insert = sqlite.prepare('INSERT INTO json_import_probe VALUES (?, ?)');
    for (const row of values) insert.run(...row);
    try {
      const version = await pool.query<{ server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      expect(version.rows[0]?.server_version_num.startsWith('17')).toBe(true);
      await pool.query('DROP TABLE IF EXISTS json_import_probe');
      await pool.query('CREATE TABLE json_import_probe (id text PRIMARY KEY, payload jsonb)');
      await copyAllTables(
        pool,
        sqlite,
        ['json_import_probe'],
        new Map([['json_import_probe', probeColumns]]),
        [],
        () => undefined,
      );
      const result = await pool.query<{
        id: string;
        payload: unknown;
        payload_text: string | null;
        sql_null: boolean;
      }>(
        `SELECT id, payload, payload::text AS payload_text,
          payload IS NULL AS sql_null
        FROM json_import_probe
        ORDER BY id`,
      );
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      expect(byId.get('object')?.payload).toEqual({ safe: true });
      expect(byId.get('array')?.payload).toEqual([1, 2, 3]);
      expect(byId.get('string')?.payload).toBe('legacy string scalar');
      expect(byId.get('unicode')?.payload).toBe('café 世界');
      expect(byId.get('number')?.payload).toBe(42);
      expect(byId.get('precise-number')?.payload_text).toBe(
        '123456789012345678901234567890.12345678901234567890',
      );
      expect(byId.get('boolean')?.payload).toBe(true);
      expect(byId.get('json-null')).toMatchObject({ payload: null, sql_null: false });
      expect(byId.get('sql-null')).toMatchObject({ payload: null, sql_null: true });
      expect(byId.get('duplicate')?.payload).toEqual({ key: 2 });
      expect(byId.get('large')?.payload).toBe('x'.repeat(1_000_000));

      const rejectedSqlite = new Database(':memory:');
      rejectedSqlite.exec('CREATE TABLE json_import_probe (id TEXT PRIMARY KEY, payload)');
      rejectedSqlite.prepare('INSERT INTO json_import_probe VALUES (?, ?)').run(
        'out-of-range',
        '1e131072',
      );
      try {
        await expect(copyAllTables(
          pool,
          rejectedSqlite,
          ['json_import_probe'],
          new Map([['json_import_probe', probeColumns]]),
          [],
          () => undefined,
        )).rejects.toThrow(
          'json_import_probe.payload (target-jsonb-rejected)',
        );
        const rejectedCount = await pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM json_import_probe WHERE id = 'out-of-range'",
        );
        expect(rejectedCount.rows[0]?.count).toBe('0');
      } finally {
        rejectedSqlite.close();
      }
    } finally {
      await pool.query('DROP TABLE IF EXISTS json_import_probe');
      sqlite.close();
      await pool.end();
    }
  }, 120_000);
});
