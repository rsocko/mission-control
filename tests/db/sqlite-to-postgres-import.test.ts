import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import {
  compareSqliteImportSchema,
  convertSqliteValueForPostgres,
  dependencySafeRows,
  dependencySafeTableOrder,
  currentPostgresMigrationHashes,
  expectedImportTableNames,
  prepareTarget,
  runSqliteToPostgresImport,
  validateSqliteMigrationState,
} from '../../scripts/lib/sqlite-to-postgres-import';
import { ImportPreconditionError } from '../../scripts/lib/sqlite-to-postgres-import';
import { SQLITE_SUPERSEDED_MIGRATION_HASHES } from '../../scripts/sqlite-superseded-migration-hashes';
import { parseArgs } from '../../scripts/sqlite-to-postgres-import';

describe('SQLite-to-PostgreSQL import tooling', () => {
  const migrationsDirectory = resolve(process.cwd(), 'drizzle');
  const priorityEntityColumns = [
    'id TEXT PRIMARY KEY',
    'name TEXT NOT NULL',
    'type TEXT NOT NULL',
    'reference_id TEXT',
    'description TEXT',
    "tier TEXT NOT NULL DEFAULT 'standard'",
    "color TEXT NOT NULL DEFAULT '#64748b'",
    'rank INTEGER NOT NULL DEFAULT 0',
    'active_task_count INTEGER NOT NULL DEFAULT 0',
    'last_touched_at TEXT',
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ] as const;
  const historicalPriorityEntityColumns = [
    ...priorityEntityColumns.filter((column) => column !== 'reference_id TEXT'),
    'reference_id TEXT',
  ] as const;
  const inboundWebhookColumns = [
    'id TEXT PRIMARY KEY NOT NULL',
    'name TEXT NOT NULL',
    "source_label TEXT NOT NULL DEFAULT 'webhook'",
    'secret TEXT',
    'enabled INTEGER NOT NULL DEFAULT true',
    "default_action TEXT NOT NULL DEFAULT 'auto'",
    "field_mappings TEXT NOT NULL DEFAULT '{}'",
    'total_received INTEGER NOT NULL DEFAULT 0',
    'last_received_at TEXT',
    'last_status INTEGER',
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ] as const;
  const historicalInboundWebhookColumns = inboundWebhookColumns.map((column) => (
    column === 'enabled INTEGER NOT NULL DEFAULT true'
      ? 'enabled INTEGER NOT NULL DEFAULT 1'
      : column
  ));

  function currentSqlite(): Database.Database {
    const sqlite = new Database(':memory:');
    runOrderedDatabaseBootstrap(sqlite, migrationsDirectory);
    return sqlite;
  }

  function replacePriorityEntityTable(
    sqlite: Database.Database,
    columns: readonly string[],
  ): void {
    sqlite.exec(`
      DROP TABLE priority_entities;
      CREATE TABLE priority_entities (${columns.join(', ')});
    `);
  }

  function replaceInboundWebhookTable(
    sqlite: Database.Database,
    columns: readonly string[],
  ): void {
    sqlite.exec(`
      DROP TABLE inbound_webhooks;
      CREATE TABLE inbound_webhooks (${columns.join(', ')});
    `);
  }

  function targetPreparationPool(options: {
    readonly tables: readonly string[];
    readonly counts?: Readonly<Record<string, number>>;
    readonly migrationJournal?: 'missing' | 'stale' | 'current';
  }) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM information_schema.tables') && sql.includes("table_schema = 'public'")) {
        return { rows: options.tables.map((table_name) => ({ table_name })) };
      }
      if (sql.includes('FROM information_schema.tables') && sql.includes("table_schema = 'drizzle'")) {
        return { rows: [{ exists: options.migrationJournal !== 'missing' }] };
      }
      if (sql.includes('FROM drizzle.__drizzle_migrations')) {
        return {
          rows: options.migrationJournal === 'current'
            ? currentPostgresMigrationHashes().map((hash) => ({ hash }))
            : [{ hash: 'stale-postgres-migration-hash' }],
        };
      }
      const countTable = sql.match(/FROM "([^"]+)"/)?.[1];
      if (countTable) {
        return { rows: [{ count: String(options.counts?.[countTable] ?? 0) }] };
      }
      throw new Error(`Unexpected mocked PostgreSQL query: ${sql}`);
    });
    return { query } as never;
  }

  it('plans only SQLite-backed tables and leaves PostgreSQL search projections derived', () => {
    const tables = expectedImportTableNames();

    expect(tables.sourceTables).toHaveLength(160);
    expect(tables.targetTables).toHaveLength(162);
    expect(tables.sourceTables).toContain('tasks');
    expect(tables.sourceTables).toContain('notifications');
    expect(tables.sourceTables).not.toContain('task_search_documents');
    expect(tables.sourceTables).not.toContain('notification_search_documents');
    expect(tables.targetTables).toContain('task_search_documents');
    expect(tables.targetTables).toContain('notification_search_documents');
  });

  it('rejects existing empty targets without a current PostgreSQL migration journal', async () => {
    const { targetTables } = expectedImportTableNames();

    await expect(prepareTarget(
      targetPreparationPool({ tables: targetTables, migrationJournal: 'missing' }),
      { dryRun: false, rehearsal: false, resetDisposableRehearsalTarget: false },
      'postgres://user:secret@localhost/mission_control_import_test',
      targetTables,
      'drizzle/postgres',
    )).rejects.toThrow('missing drizzle.__drizzle_migrations');

    await expect(prepareTarget(
      targetPreparationPool({ tables: targetTables, migrationJournal: 'stale' }),
      { dryRun: false, rehearsal: false, resetDisposableRehearsalTarget: false },
      'postgres://user:secret@localhost/mission_control_import_test',
      targetTables,
      'drizzle/postgres',
    )).rejects.toThrow('migration journal is not current');
  });

  it('accepts existing empty targets only when the PostgreSQL migration journal is current', async () => {
    const { targetTables } = expectedImportTableNames();

    await expect(prepareTarget(
      targetPreparationPool({ tables: targetTables, migrationJournal: 'current' }),
      { dryRun: false, rehearsal: false, resetDisposableRehearsalTarget: false },
      'postgres://user:secret@localhost/mission_control_import_test',
      targetTables,
      'drizzle/postgres',
    )).resolves.toEqual({
      initialized: false,
      reset: false,
      emptyAttestation: 'empty-existing-schema',
    });
  });

  it('orders table and self-referential row copies by dependency', () => {
    expect(dependencySafeTableOrder(['child', 'parent', 'leaf'], [
      {
        table: 'child',
        columns: ['parent_id'],
        referencedTable: 'parent',
        referencedColumns: ['id'],
      },
      {
        table: 'leaf',
        columns: ['child_id'],
        referencedTable: 'child',
        referencedColumns: ['id'],
      },
    ])).toEqual(['parent', 'child', 'leaf']);

    expect(dependencySafeRows([
      { id: 'child', parent_id: 'root' },
      { id: 'root', parent_id: null },
      { id: 'grandchild', parent_id: 'child' },
    ], [
      {
        table: 'tasks',
        columns: ['parent_id'],
        referencedTable: 'tasks',
        referencedColumns: ['id'],
      },
    ])).toEqual([
      { id: 'root', parent_id: null },
      { id: 'child', parent_id: 'root' },
      { id: 'grandchild', parent_id: 'child' },
    ]);
  });

  it('converts SQLite booleans and JSON into PostgreSQL-native values', () => {
    expect(convertSqliteValueForPostgres(1, {
      name: 'enabled',
      dataType: 'boolean',
      udtName: 'bool',
      nullable: false,
      hasDefault: false,
      generated: false,
    })).toBe(true);
    expect(convertSqliteValueForPostgres('0', {
      name: 'enabled',
      dataType: 'boolean',
      udtName: 'bool',
      nullable: false,
      hasDefault: false,
      generated: false,
    })).toBe(false);
    expect(convertSqliteValueForPostgres('{"safe":true}', {
      name: 'metadata',
      dataType: 'jsonb',
      udtName: 'jsonb',
      nullable: false,
      hasDefault: false,
      generated: false,
    })).toEqual({ safe: true });
  });

  it('parses operator flags and rejects unsafe source/target combinations', () => {
    expect(parseArgs([
      '--sqlite-source',
      'source.sqlite3',
      '--postgres-url',
      'postgres://user:secret@localhost/mission_control_import_test',
      '--confirm-writers-stopped',
      '--dry-run',
    ])).toMatchObject({
      sqliteSourcePath: 'source.sqlite3',
      postgresUrl: 'postgres://user:secret@localhost/mission_control_import_test',
      confirmWritersStopped: true,
      dryRun: true,
    });

    expect(() => parseArgs([
      '--sqlite-source',
      'source.sqlite3',
      '--fixture',
      'v1-0000-baseline',
    ])).toThrow(ImportPreconditionError);
    expect(() => parseArgs([
      '--reset-disposable-rehearsal-target',
    ])).toThrow(ImportPreconditionError);
  });

  it('emits non-activating cutover-planning evidence for fixture dry-runs without a target', async () => {
    vi.stubEnv('MC_POSTGRES_IMPORT_URL', '');
    vi.stubEnv('MC_POSTGRES_URL', '');

    const result = await runSqliteToPostgresImport({
      fixtureId: 'v1-0047-durable-sync-queue',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.rehearsal).toBe(true);
    expect(result.evidence.command.activationChanged).toBe(false);
    expect(result.evidence.source.kind).toBe('persisted-state-fixture');
    expect(result.evidence.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence.schema.sqliteMigrationCount).toBe(227);
    expect(result.evidence.quiescence.acceptedForSyntheticFixture).toBe(true);
    expect(result.evidence.derivedState.droppedFromImport).toEqual(
      expect.arrayContaining(['sqlite_fts_virtual_tables']),
    );
    expect(result.evidence.derivedState.rebuilt).toEqual([
      'task_search_documents',
      'notification_search_documents',
    ]);
    expect(result.evidence.verdict.ready_for_cutover_planning).toBe(false);
    expect(result.evidence.verdict.reason).toContain('dry-run only');
  }, 20_000);

  it('rejects a source missing current terminal migration evidence', () => {
    const sqlite = currentSqlite();
    try {
      sqlite.prepare(
        'DELETE FROM __drizzle_migrations WHERE id = (SELECT MAX(id) FROM __drizzle_migrations)',
      ).run();
      expect(() => validateSqliteMigrationState(sqlite, migrationsDirectory)).toThrow(
        /missing 1 current migration/,
      );
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it('accepts an explicitly trusted repository-history migration hash', () => {
    const sqlite = currentSqlite();
    try {
      const historicalTimestamp = sqlite.prepare(
        'SELECT MIN(created_at) FROM __drizzle_migrations',
      ).pluck().get() as number;
      sqlite.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      ).run(SQLITE_SUPERSEDED_MIGRATION_HASHES[0], historicalTimestamp);

      expect(validateSqliteMigrationState(sqlite, migrationsDirectory)).toBe(127);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it('accepts the historical priority entity layout created before reference_id existed', () => {
    const sqlite = currentSqlite();
    try {
      replacePriorityEntityTable(sqlite, historicalPriorityEntityColumns);

      expect(validateSqliteMigrationState(sqlite, migrationsDirectory)).toBe(126);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it('reports every production-shaped historical difference and accepts exact equivalents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mc-import-schema-'));
    const fixturePath = join(directory, 'production-shaped.sqlite3');
    copyFileSync(resolve(
      process.cwd(),
      'tests',
      'fixtures',
      'persisted-state',
      'sqlite',
      'v1-0047-isolate-sync-worker.sqlite3',
    ), fixturePath);
    const fixture = new Database(fixturePath);
    try {
      runOrderedDatabaseBootstrap(fixture, migrationsDirectory);
      expect(compareSqliteImportSchema(fixture, migrationsDirectory)).toEqual([
        expect.objectContaining({
          table: 'inbound_webhooks',
          columnMismatches: [{ column: 'enabled', properties: ['default'] }],
          columnOrderMismatch: false,
          supportedHistoricalShape: true,
        }),
        expect.objectContaining({
          table: 'priority_entities',
          columnMismatches: [],
          columnOrderMismatch: true,
          supportedHistoricalShape: true,
        }),
      ]);
      expect(validateSqliteMigrationState(fixture, migrationsDirectory)).toBe(227);
    } finally {
      fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('accepts only the exact historical inbound webhook default representation', () => {
    const sqlite = currentSqlite();
    try {
      replaceInboundWebhookTable(sqlite, historicalInboundWebhookColumns);
      expect(validateSqliteMigrationState(sqlite, migrationsDirectory)).toBe(126);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it.each([
    {
      mismatch: 'declared type',
      columns: historicalInboundWebhookColumns.map((column) => (
        column === 'enabled INTEGER NOT NULL DEFAULT 1'
          ? 'enabled TEXT NOT NULL DEFAULT 1'
          : column
      )),
    },
    {
      mismatch: 'nullability',
      columns: historicalInboundWebhookColumns.map((column) => (
        column === 'name TEXT NOT NULL' ? 'name TEXT' : column
      )),
    },
    {
      mismatch: 'primary key',
      columns: historicalInboundWebhookColumns.map((column) => (
        column === 'id TEXT PRIMARY KEY NOT NULL' ? 'id TEXT NOT NULL' : column
      )),
    },
    {
      mismatch: 'different default',
      columns: historicalInboundWebhookColumns.map((column) => (
        column === 'enabled INTEGER NOT NULL DEFAULT 1'
          ? 'enabled INTEGER NOT NULL DEFAULT 0'
          : column
      )),
    },
    {
      mismatch: 'column order',
      columns: [
        historicalInboundWebhookColumns[1],
        historicalInboundWebhookColumns[0],
        ...historicalInboundWebhookColumns.slice(2),
      ],
    },
    {
      mismatch: 'missing column',
      columns: historicalInboundWebhookColumns.filter((column) => column !== 'secret TEXT'),
    },
    {
      mismatch: 'unexpected column',
      columns: [...historicalInboundWebhookColumns, 'unknown_future_column TEXT'],
    },
  ])('rejects a historical inbound webhook $mismatch mismatch', ({ columns }) => {
    const sqlite = currentSqlite();
    try {
      replaceInboundWebhookTable(sqlite, columns);
      expect(() => validateSqliteMigrationState(
        sqlite,
        migrationsDirectory,
      )).toThrow(/inbound_webhooks/);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it.each([
    {
      mismatch: 'declared type',
      columns: historicalPriorityEntityColumns.map((column) => (
        column === 'rank INTEGER NOT NULL DEFAULT 0'
          ? 'rank TEXT NOT NULL DEFAULT 0'
          : column
      )),
    },
    {
      mismatch: 'nullability',
      columns: historicalPriorityEntityColumns.map((column) => (
        column === 'name TEXT NOT NULL' ? 'name TEXT' : column
      )),
    },
    {
      mismatch: 'primary key',
      columns: historicalPriorityEntityColumns.map((column) => (
        column === 'id TEXT PRIMARY KEY' ? 'id TEXT NOT NULL' : column
      )),
    },
    {
      mismatch: 'default',
      columns: historicalPriorityEntityColumns.map((column) => (
        column === "tier TEXT NOT NULL DEFAULT 'standard'"
          ? "tier TEXT NOT NULL DEFAULT 'high'"
          : column
      )),
    },
    {
      mismatch: 'different column order',
      columns: [
        historicalPriorityEntityColumns[1],
        historicalPriorityEntityColumns[0],
        ...historicalPriorityEntityColumns.slice(2),
      ],
    },
    {
      mismatch: 'missing column',
      columns: historicalPriorityEntityColumns.filter(
        (column) => column !== 'description TEXT',
      ),
    },
    {
      mismatch: 'unexpected column',
      columns: [...historicalPriorityEntityColumns, 'unknown_future_column TEXT'],
    },
  ])('rejects a priority entity $mismatch mismatch', ({ columns }) => {
    const sqlite = currentSqlite();
    try {
      replacePriorityEntityTable(sqlite, columns);

      expect(() => validateSqliteMigrationState(
        sqlite,
        migrationsDirectory,
      )).toThrow(/priority_entities/);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it('rejects backdated unknown journal rows and incompatible current schema shapes', () => {
    const unknownNewer = currentSqlite();
    const incompatible = currentSqlite();
    try {
      const historicalTimestamp = unknownNewer.prepare(
        'SELECT MIN(created_at) FROM __drizzle_migrations',
      ).pluck().get() as number;
      unknownNewer.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      ).run('f'.repeat(64), historicalTimestamp);
      expect(() => validateSqliteMigrationState(
        unknownNewer,
        migrationsDirectory,
      )).toThrow(/unrecognized migration hash/);

      incompatible.exec('ALTER TABLE tasks ADD COLUMN unknown_future_column TEXT');
      expect(() => validateSqliteMigrationState(
        incompatible,
        migrationsDirectory,
      )).toThrow(/tasks .*unexpected: unknown_future_column/);
    } finally {
      unknownNewer.close();
      incompatible.close();
    }
  }, 20_000);

  it('summarizes every incompatible table and field in one secret-safe error', () => {
    const sqlite = currentSqlite();
    try {
      sqlite.exec('ALTER TABLE tasks ADD COLUMN unknown_future_column TEXT');
      replaceInboundWebhookTable(
        sqlite,
        historicalInboundWebhookColumns.map((column) => (
          column === 'enabled INTEGER NOT NULL DEFAULT 1'
            ? 'enabled INTEGER NOT NULL DEFAULT 0'
            : column
        )),
      );
      replacePriorityEntityTable(
        sqlite,
        historicalPriorityEntityColumns.map((column) => (
          column === 'rank INTEGER NOT NULL DEFAULT 0'
            ? 'rank TEXT NOT NULL DEFAULT 0'
            : column
        )),
      );

      expect(() => validateSqliteMigrationState(
        sqlite,
        migrationsDirectory,
      )).toThrow(
        /3 table\(s\): inbound_webhooks .*enabled:default.*priority_entities .*rank:type.*tasks .*unexpected: unknown_future_column/,
      );
    } finally {
      sqlite.close();
    }
  }, 20_000);
});
