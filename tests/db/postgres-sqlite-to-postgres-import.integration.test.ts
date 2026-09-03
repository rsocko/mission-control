import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createPostgresPool } from '@/db/postgres/connection';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { runPostgresMigrations } from '@/db/postgres/migrations';
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

      const semanticVersions = await pool.query<{
        column_name: string;
        column_default: string | null;
        is_nullable: string;
      }>(`
        SELECT column_name, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('semantic_intents', 'semantic_runs')
          AND column_name = 'idempotency_key_version'
        ORDER BY table_name
      `);
      expect(semanticVersions.rows).toHaveLength(2);
      expect(semanticVersions.rows).toEqual([
        expect.objectContaining({
          column_name: 'idempotency_key_version',
          column_default: expect.stringMatching(/^0(?:::integer)?$/),
          is_nullable: 'NO',
        }),
        expect.objectContaining({
          column_name: 'idempotency_key_version',
          column_default: expect.stringMatching(/^0(?:::integer)?$/),
          is_nullable: 'NO',
        }),
      ]);

      const migrationCount = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM drizzle.__drizzle_migrations
        WHERE created_at = 1788486400000
      `);
      expect(migrationCount.rows[0]?.count).toBe('1');
      await runPostgresMigrations(pool);
      const rerunMigrationCount = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM drizzle.__drizzle_migrations
        WHERE created_at = 1788486400000
      `);
      expect(rerunMigrationCount.rows[0]?.count).toBe('1');
    } finally {
      await pool.end();
    }
  }, 120_000);

  it('imports legacy semantic rows without PostgreSQL-only columns as version zero', async () => {
    assertSafeIntegrationTestTarget(postgresUrl);
    const pool = createPostgresPool(resolvePostgresConfig({
      MC_POSTGRES_URL: postgresUrl,
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-semantic-import-integration-test',
    }));
    const sqlite = new Database(':memory:');
    const identityId = `semantic-import-${process.pid}-${Date.now()}`;
    const intentId = `${identityId}-intent`;
    const runId = `${identityId}-run`;
    const legacyIntentKey = `mc-semantic-key:v1:${
      Buffer.from(`${identityId}:intent`, 'utf16le').toString('base64url')
    }`;
    const legacyRunKey = `mc-semantic-key:v1:${
      Buffer.from(`${identityId}:run`, 'utf16le').toString('base64url')
    }`;
    const now = new Date().toISOString();
    sqlite.exec(`
      CREATE TABLE semantic_intents (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        index_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        source_revision TEXT,
        content_fingerprint TEXT,
        projection_version INTEGER,
        requested_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        retry_after TEXT,
        last_error TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE semantic_runs (
        id TEXT PRIMARY KEY,
        index_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        checkpoint TEXT,
        processed_count INTEGER NOT NULL,
        failed_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
    `);
    sqlite.prepare(`
      INSERT INTO semantic_intents
      VALUES (?, ?, ?, 'upsert', 'task', 'legacy-task', '1', 'fingerprint', 1, ?,
        'queued', 0, 5, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
    `).run(intentId, legacyIntentKey, identityId, now, now, now, now);
    sqlite.prepare(`
      INSERT INTO semantic_runs
      VALUES (?, ?, 'backfill', ?, 'queued', NULL, 0, 0, 0, 0, 3, ?,
        NULL, NULL, NULL, ?, ?, NULL, NULL)
    `).run(runId, identityId, legacyRunKey, now, now, now);

    const validateSource = vi.fn();
    try {
      await pool.query(
        `INSERT INTO semantic_index_identities
          (id, provider, model, dimensions, projection_version, status,
           document_count, vector_count, created_at, updated_at)
         VALUES ($1, 'test', 'test', 3, 1, 'building', 0, 0, $2, $2)`,
        [identityId, now],
      );
      const columnResult = await pool.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        is_generated: string;
      }>(`
        SELECT table_name, column_name, data_type, udt_name, is_nullable,
          column_default, is_generated
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('semantic_intents', 'semantic_runs')
        ORDER BY ordinal_position
      `);
      const columnsByTable = new Map(
        ['semantic_intents', 'semantic_runs'].map((table) => [
          table,
          columnResult.rows
            .filter((column) => column.table_name === table)
            .map((column) => ({
              name: column.column_name,
              dataType: column.data_type,
              udtName: column.udt_name,
              nullable: column.is_nullable === 'YES',
              hasDefault: column.column_default !== null,
              generated: column.is_generated !== 'NEVER',
            })),
        ]),
      );

      const counts = await copyAllTables(
        pool,
        sqlite,
        ['semantic_intents', 'semantic_runs'],
        columnsByTable,
        [],
        validateSource,
      );
      expect(counts).toEqual([
        { table: 'semantic_intents', sourceRows: 1, targetRows: 1 },
        { table: 'semantic_runs', sourceRows: 1, targetRows: 1 },
      ]);
      expect(validateSource).toHaveBeenCalledOnce();

      const intent = await pool.query<{
        idempotency_key: string;
        idempotency_key_version: number;
      }>(
        `SELECT idempotency_key, idempotency_key_version
         FROM semantic_intents WHERE id = $1`,
        [intentId],
      );
      expect(intent.rows[0]).toEqual({
        idempotency_key: legacyIntentKey,
        idempotency_key_version: 0,
      });
      const run = await pool.query<{
        idempotency_key: string;
        idempotency_key_version: number;
      }>(
        `SELECT idempotency_key, idempotency_key_version
         FROM semantic_runs WHERE id = $1`,
        [runId],
      );
      expect(run.rows[0]).toEqual({
        idempotency_key: legacyRunKey,
        idempotency_key_version: 0,
      });

      const planClient = await pool.connect();
      try {
        await planClient.query('BEGIN');
        await planClient.query('SET LOCAL enable_seqscan = off');
        const intentLookupPlan = await planClient.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id FROM semantic_intents
           WHERE status = 'queued'
             AND idempotency_key_version = 0
             AND idempotency_key = $1`,
          [legacyIntentKey],
        );
        expect(JSON.stringify(intentLookupPlan.rows))
          .toContain('idx_semantic_intents_pending');
        const runLookupPlan = await planClient.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id FROM semantic_runs
           WHERE idempotency_key_version = 0
             AND idempotency_key = $1`,
          [legacyRunKey],
        );
        expect(JSON.stringify(runLookupPlan.rows))
          .toContain('idx_semantic_runs_idempotency');
        const intentClaimPlan = await planClient.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id FROM semantic_intents
           WHERE index_id = $1 AND status = 'queued' AND available_at <= $2
           ORDER BY requested_at, created_at, id
           LIMIT 1`,
          [identityId, now],
        );
        const intentClaimPlanText = JSON.stringify(intentClaimPlan.rows);
        expect(intentClaimPlanText).toContain('Index Scan');
        // Tiny imported fixtures can make PostgreSQL prefer the partial pending
        // index; either plan proves the claim stays index-backed.
        expect(intentClaimPlanText)
         .toMatch(/idx_semantic_intents_(?:claim|pending)/);
        const runClaimPlan = await planClient.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id FROM semantic_runs
           WHERE status = 'queued' AND available_at <= $1
           ORDER BY available_at, created_at, id
           LIMIT 1`,
          [now],
        );
        expect(JSON.stringify(runClaimPlan.rows))
          .toContain('idx_semantic_runs_claim');
        await planClient.query('ROLLBACK');
      } finally {
        planClient.release();
      }
    } finally {
      await pool.query(
        'DELETE FROM semantic_index_identities WHERE id = $1',
        [identityId],
      );
      sqlite.close();
      await pool.end();
    }
  }, 120_000);

  it('rolls back a failed additive migration and records it only after success', async () => {
    assertSafeIntegrationTestTarget(postgresUrl);
    const pool = createPostgresPool(resolvePostgresConfig({
      MC_POSTGRES_URL: postgresUrl,
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-migration-atomicity-test',
    }));
    const migrationDirectory = mkdtempSync(join(tmpdir(), 'mc-pg-migrations-'));
    try {
      cpSync(resolve(process.cwd(), 'drizzle', 'postgres'), migrationDirectory, {
        recursive: true,
      });
      const journalPath = join(migrationDirectory, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }>;
      };
      journal.entries.push({
        idx: 4,
        version: '7',
        when: 1788486400001,
        tag: '0004_atomicity_probe',
        breakpoints: true,
      });
      writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      writeFileSync(
        join(migrationDirectory, '0004_atomicity_probe.sql'),
        'CREATE TABLE "migration_atomicity_probe" ("id" integer);--> statement-breakpoint\nSELECT missing_atomicity_probe_function();\n',
      );

      await expect(runPostgresMigrations(pool, {
        migrationsFolder: migrationDirectory,
      })).rejects.toThrow();
      const rolledBack = await pool.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.migration_atomicity_probe')::text AS table_name",
      );
      expect(rolledBack.rows[0]?.table_name).toBeNull();
      const failedHistory = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM drizzle.__drizzle_migrations
        WHERE created_at = 1788486400001
      `);
      expect(failedHistory.rows[0]?.count).toBe('0');

      writeFileSync(
        join(migrationDirectory, '0004_atomicity_probe.sql'),
        'CREATE TABLE "migration_atomicity_probe" ("id" integer);\n',
      );
      await runPostgresMigrations(pool, { migrationsFolder: migrationDirectory });
      await runPostgresMigrations(pool, { migrationsFolder: migrationDirectory });
      const appliedHistory = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM drizzle.__drizzle_migrations
        WHERE created_at = 1788486400001
      `);
      expect(appliedHistory.rows[0]?.count).toBe('1');
    } finally {
      await pool.query('DROP TABLE IF EXISTS migration_atomicity_probe');
      rmSync(migrationDirectory, { recursive: true, force: true });
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
