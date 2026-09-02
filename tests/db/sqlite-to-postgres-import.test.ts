import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import {
  compareSqliteImportSchema,
  cleanupDisposableRehearsalTarget,
  copyAllTables,
  convertSqliteValueForPostgres,
  dependencySafeRows,
  dependencySafeTableOrder,
  currentPostgresMigrationHashes,
  expectedJsonTargetColumns,
  expectedImportTableNames,
  matchesSupportedSqliteColumnShape,
  openImmutableReadonlySqlite,
  preflightJsonCompatibility,
  prepareTarget,
  runSqliteToPostgresImport,
  validateSqliteMigrationState,
} from '../../scripts/lib/sqlite-to-postgres-import';
import { ImportPreconditionError } from '../../scripts/lib/sqlite-to-postgres-import';
import {
  PERSISTED_STATE_FIXTURES,
  type PersistedStateFixture,
} from '../../scripts/persisted-state-fixture-manifest';
import { SQLITE_SUPERSEDED_MIGRATION_HASHES } from '../../scripts/sqlite-superseded-migration-hashes';
import { parseArgs } from '../../scripts/sqlite-to-postgres-import';
import {
  deriveTrustedTasksColumnOrders,
  TRUSTED_TASK_APPEND_COLUMNS,
  TRUSTED_TASK_COLUMN_APPEND_EVENTS,
  TRUSTED_TASKS_CHRONOLOGIES,
} from '../../scripts/sqlite-task-schema-history';

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
  const productionHistoricalTables = [
    'inbound_webhooks',
    'priority_entities',
    'routines',
    'subtask_templates',
    'sync_log',
    'task_triage_log',
    'tasks',
    'triage_sync_state',
  ] as const;
  const newlySupportedHistoricalTables = productionHistoricalTables.slice(2);
  const productionTasksFixtures = PERSISTED_STATE_FIXTURES.filter(
    (fixture) => fixture.tasksHistoricalOrder !== undefined,
  );

  interface TestSqliteColumn {
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dfltValue: string | null;
    readonly pk: number;
    readonly hidden: number;
  }

  function currentSqlite(): Database.Database {
    const sqlite = new Database(':memory:');
    runOrderedDatabaseBootstrap(sqlite, migrationsDirectory);
    return sqlite;
  }

  function retainedSqliteSource(): {
    readonly directory: string;
    readonly sourcePath: string;
    readonly cleanup: () => void;
  } {
    const fixture = PERSISTED_STATE_FIXTURES.find(({ id }) => id === 'v1-0000-baseline');
    if (!fixture) throw new Error('Missing baseline persisted-state fixture');
    const directory = mkdtempSync(join(tmpdir(), 'mc-import-retained-source-'));
    const sourcePath = join(directory, 'mission-control.db');
    copyFileSync(
      resolve('tests', 'fixtures', 'persisted-state', 'sqlite', fixture.fileName),
      sourcePath,
    );
    const sqlite = new Database(sourcePath);
    try {
      runOrderedDatabaseBootstrap(sqlite, migrationsDirectory);
    } finally {
      sqlite.close();
    }
    return {
      directory,
      sourcePath,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  }

  function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  const productionHistoricalDatabases = new Map<PersistedStateFixture['tasksHistoricalOrder'], Buffer>();

  function productionHistoricalSqlite(
    tasksHistoricalOrder: PersistedStateFixture['tasksHistoricalOrder'] = 'late-migrations-first',
  ): Database.Database {
    let serialized = productionHistoricalDatabases.get(tasksHistoricalOrder);
    if (!serialized) {
      const fixtureDefinition = PERSISTED_STATE_FIXTURES.find(
        (fixture) => fixture.tasksHistoricalOrder === tasksHistoricalOrder,
      );
      if (!fixtureDefinition) throw new Error(`Missing fixture for ${tasksHistoricalOrder}`);
      const directory = mkdtempSync(join(tmpdir(), 'mc-import-history-baseline-'));
      const fixturePath = join(directory, 'production-shaped.sqlite3');
      copyFileSync(resolve(
        process.cwd(),
        'tests',
        'fixtures',
        'persisted-state',
        'sqlite',
        fixtureDefinition.fileName,
      ), fixturePath);
      const fixture = new Database(fixturePath);
      try {
        runOrderedDatabaseBootstrap(fixture, migrationsDirectory);
        serialized = fixture.serialize();
        productionHistoricalDatabases.set(tasksHistoricalOrder, serialized);
      } finally {
        fixture.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
    return new Database(serialized);
  }

  function tableShape(
    sqlite: Database.Database,
    table: string,
  ): readonly TestSqliteColumn[] {
    return sqlite.prepare(`
      SELECT name, type, "notnull", dflt_value AS dfltValue, pk, hidden
      FROM pragma_table_xinfo(?)
      ORDER BY cid
    `).all(table) as TestSqliteColumn[];
  }

  function replaceTable(
    sqlite: Database.Database,
    table: string,
    columns: readonly TestSqliteColumn[],
  ): void {
    const definitions = columns.map((column) => [
      `"${column.name}"`,
      column.type,
      column.pk > 0 ? 'PRIMARY KEY' : '',
      column.notnull > 0 ? 'NOT NULL' : '',
      column.dfltValue === null ? '' : `DEFAULT ${column.dfltValue}`,
    ].filter(Boolean).join(' '));
    sqlite.exec(`
      DROP TABLE "${table}";
      CREATE TABLE "${table}" (${definitions.join(', ')});
    `);
  }

  function replaceHistoricalTable(
    sqlite: Database.Database,
    table: string,
    change: (columns: readonly TestSqliteColumn[]) => readonly TestSqliteColumn[],
  ): void {
    replaceTable(sqlite, table, change(tableShape(sqlite, table)));
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

    expect(tables.sourceTables).toHaveLength(163);
    expect(tables.targetTables).toHaveLength(165);
    expect(tables.sourceTables).toContain('tasks');
    expect(tables.sourceTables).toContain('notifications');
    expect(tables.sourceTables).toContain('event_outbox');
    expect(tables.sourceTables).toContain('event_outbox_deliveries');
    expect(tables.sourceTables).not.toContain('task_search_documents');
    expect(tables.sourceTables).not.toContain('notification_search_documents');
    expect(tables.targetTables).toContain('task_search_documents');
    expect(tables.targetTables).toContain('notification_search_documents');
  });

  it('derives every exact trusted tasks chronology from bounded append events', () => {
    const derived = deriveTrustedTasksColumnOrders();
    expect([...derived.keys()].sort()).toEqual([
      'continuous-production',
      'fresh',
      'late-migrations-first',
      'released-runtime-first',
      'status-after-local-disposition',
      'status-after-push-count',
      'status-after-recurrence',
      'status-after-relative-reminders',
      'status-after-reminder',
    ].sort());
    expect(new Set([...derived.values()].map((order) => JSON.stringify(order))).size).toBe(9);
    expect(TRUSTED_TASKS_CHRONOLOGIES.map(({ origin }) => origin)).toEqual([
      expect.stringContaining('0020_add_task_effort'),
      expect.stringContaining('0022_add_task_reminder'),
      expect.stringContaining('0027_add_bulk_import_flag'),
      expect.stringContaining('0053_add_task_local_disposition'),
      expect.stringContaining('0106_task-delay-insights'),
      expect.stringContaining('0109_relative_task_reminders'),
      expect.stringContaining('0111_completion_anchored_recurrence'),
      expect.stringContaining('0118_add_planning_horizon'),
      expect.stringContaining('recurrence/planning runtimes'),
    ]);

    const current = currentSqlite();
    try {
      expect(tableShape(current, 'tasks').map(({ name }) => name)).toEqual(
        derived.get('fresh'),
      );
    } finally {
      current.close();
    }
  }, 20_000);

  it('covers every repository task-column append in the chronology model', () => {
    const migrationColumns = readdirSync(migrationsDirectory)
      .filter((fileName) => fileName.endsWith('.sql'))
      .flatMap((fileName) => [
        ...readFileSync(resolve(migrationsDirectory, fileName), 'utf8')
          .matchAll(/ALTER TABLE\s+[`"]?tasks[`"]?\s+ADD(?:\s+COLUMN)?\s+[`"]?([a-z_]+)/gi),
      ].map((match) => match[1]));
    const safetyNetColumns = [
      ...readFileSync(
        resolve(process.cwd(), 'src', 'db', 'bootstrap', 'safety-nets', 'tasks.ts'),
        'utf8',
      ).matchAll(/ALTER TABLE tasks ADD COLUMN ([a-z_]+)/g),
    ].map((match) => match[1]);
    const discovered = [...new Set([...migrationColumns, ...safetyNetColumns])].sort();

    expect(discovered).toEqual([...TRUSTED_TASK_APPEND_COLUMNS].sort());
  });

  it('binds every chronology event and checkpoint to committed repository provenance', () => {
    const journal = JSON.parse(
      readFileSync(resolve(migrationsDirectory, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const journalIndexes = new Map(
      journal.entries.map(({ tag }, index) => [tag, index]),
    );
    const normalizedSha256 = (content: string): string => createHash('sha256')
      .update(content.replace(/\r\n?/g, '\n'))
      .digest('hex');
    const hasFullGitHistory = execFileSync(
      'git',
      ['rev-parse', '--is-shallow-repository'],
      { encoding: 'utf8' },
    ).trim() === 'false';

    for (const event of Object.values(TRUSTED_TASK_COLUMN_APPEND_EVENTS)) {
      const source = readFileSync(resolve(process.cwd(), event.provenance.path), 'utf8');
      expect(normalizedSha256(source)).toBe(event.provenance.sha256);
      if (event.provenance.kind === 'migration') {
        expect(journalIndexes.has(event.provenance.tag)).toBe(true);
        const columns = [
          ...source.matchAll(
            /ALTER TABLE\s+[`"]?tasks[`"]?\s+ADD(?:\s+COLUMN)?\s+[`"]?([a-z_]+)/gi,
          ),
        ].map((match) => match[1]);
        expect(columns).toEqual(event.columns);
        expect(event.provenance.firstReachableCommit).toMatch(/^[a-f0-9]{40}$/);
        if (hasFullGitHistory) {
          expect(() => execFileSync(
            'git',
            ['merge-base', '--is-ancestor', event.provenance.firstReachableCommit, 'HEAD'],
            { stdio: 'ignore' },
          )).not.toThrow();
          for (const column of event.columns) {
            expect(() => execFileSync(
              'git',
              ['grep', '-F', '-q', column, event.provenance.firstReachableCommit, '--'],
              { stdio: 'ignore' },
            )).not.toThrow();
          }
        }
      } else {
        for (const marker of event.provenance.sourceMarkers) {
          expect(source).toContain(marker);
        }
        for (const commit of event.provenance.firstReachableCommits) {
          expect(commit).toMatch(/^[a-f0-9]{40}$/);
          if (hasFullGitHistory) {
            expect(() => execFileSync(
              'git',
              ['merge-base', '--is-ancestor', commit, 'HEAD'],
              { stdio: 'ignore' },
            )).not.toThrow();
            for (const marker of event.provenance.sourceMarkers) {
              expect(() => execFileSync(
                'git',
                ['grep', '-F', '-q', marker, commit, '--'],
                { stdio: 'ignore' },
              )).not.toThrow();
            }
          }
        }
      }
    }

    for (const chronology of TRUSTED_TASKS_CHRONOLOGIES) {
      const indexes = chronology.checkpointTags.map((tag) => journalIndexes.get(tag));
      expect(indexes.every((index) => index !== undefined)).toBe(true);
      expect(indexes).toEqual([...indexes].sort((left, right) => left! - right!));
      expect(chronology.events.every(
        (event) => event in TRUSTED_TASK_COLUMN_APPEND_EVENTS,
      )).toBe(true);
    }
    expect(productionTasksFixtures.map(({ tasksHistoricalOrder }) => (
      tasksHistoricalOrder
    )).sort()).toEqual(
      [...deriveTrustedTasksColumnOrders().keys()]
        .filter((id) => id !== 'fresh')
        .sort(),
    );
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
    })).toBe('{"safe":true}');
  });

  it('derives the complete JSON target inventory from the PostgreSQL schema', () => {
    const columns = expectedJsonTargetColumns();

    expect(columns).toHaveLength(117);
    expect(new Set(columns.map(({ table, column }) => `${table}.${column}`))).toHaveLength(117);
    expect(columns).toContainEqual({ table: 'app_settings', column: 'value' });
    expect(columns).toContainEqual({ table: 'tasks', column: 'metadata' });
    expect(columns).toContainEqual({ table: 'worker_health_snapshot', column: 'payload' });
    expect(columns).toContainEqual({ table: 'event_outbox', column: 'payload' });
    expect(columns).toContainEqual({
      table: 'notification_enrichment_jobs',
      column: 'payload',
    });
  });

  it('preserves every valid JSON semantic class as serialized PostgreSQL input', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE json_values (value)');
    const values: unknown[] = [
      '{"object":true}',
      '[1,2,3]',
      '"string scalar"',
      '"ordinary Unicode: café 世界"',
      '"escaped quote: \\" and backslash: \\\\"',
      '{"escaped\\\"key":"backslash \\\\"}',
      '"{\\"doubleEncoded\\":true}"',
      '"1e999999999999999999999"',
      '{"1e999999999999999999999":"numeric-looking key"}',
      '42',
      `1${'0'.repeat(400)}`,
      '1e309',
      '1e131071',
      '1e-16383',
      '-0',
      '-0.000',
      '1.2300e2',
      '0e999',
      'true',
      'false',
      'null',
      ' { "duplicate": 1, "duplicate": 2 } ',
      JSON.stringify('x'.repeat(1_000_000)),
      null,
    ];
    const insert = sqlite.prepare('INSERT INTO json_values (value) VALUES (?)');
    for (const value of values) insert.run(value);
    try {
      const report = preflightJsonCompatibility(sqlite, [
        { table: 'json_values', column: 'value' },
      ]);
      expect(report).toMatchObject({
        targetColumns: [{ table: 'json_values', column: 'value' }],
        rowsScanned: values.length,
        batchesScanned: 1,
        issues: [],
      });
      const jsonColumn = {
        name: 'value',
        dataType: 'jsonb',
        udtName: 'jsonb',
        nullable: true,
        hasDefault: false,
        generated: false,
      };
      expect(values.map((value) => convertSqliteValueForPostgres(
        value,
        jsonColumn,
        'json_values',
      ))).toEqual(values);
    } finally {
      sqlite.close();
    }
  });

  it('aggregates every incompatible JSON category without values or row identifiers', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE first_json (left_value, right_value);
      CREATE TABLE second_json (payload);
    `);
    sqlite.prepare('INSERT INTO first_json VALUES (?, ?)').run(
      'secret plain text',
      Buffer.from('secret bytes'),
    );
    sqlite.prepare('INSERT INTO first_json VALUES (?, ?)').run('', 'secret invalid json');
    sqlite.prepare('INSERT INTO second_json VALUES (?)').run(
      `${'['.repeat(101)}0${']'.repeat(101)}`,
    );
    try {
      const report = preflightJsonCompatibility(sqlite, [
        { table: 'first_json', column: 'left_value' },
        { table: 'first_json', column: 'right_value' },
        { table: 'second_json', column: 'payload' },
      ]);

      expect(report.issues).toEqual([
        { table: 'first_json', column: 'left_value', category: 'invalid-json', count: 2 },
        {
          table: 'first_json',
          column: 'right_value',
          category: 'invalid-json',
          count: 1,
        },
        {
          table: 'first_json',
          column: 'right_value',
          category: 'unsupported-storage-type',
          count: 1,
        },
        {
          table: 'second_json',
          column: 'payload',
          category: 'excessive-nesting',
          count: 1,
        },
      ]);
      expect(JSON.stringify(report)).not.toContain('secret');
      expect(() => convertSqliteValueForPostgres(
        'secret plain text',
        {
          name: 'left_value',
          dataType: 'jsonb',
          udtName: 'jsonb',
          nullable: false,
          hasDefault: false,
          generated: false,
        },
        'first_json',
      )).toThrow(
        'SQLite import value is incompatible with PostgreSQL at first_json.left_value (invalid-json).',
      );
    } finally {
      sqlite.close();
    }
  });

  it('streams JSON preflight in bounded batches', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE json_values (value TEXT NOT NULL)');
    const insertRows = sqlite.transaction(() => {
      const insert = sqlite.prepare('INSERT INTO json_values VALUES (?)');
      for (let index = 0; index < 501; index += 1) insert.run('{"valid":true}');
    });

    insertRows();
    try {
      expect(preflightJsonCompatibility(sqlite, [
        { table: 'json_values', column: 'value' },
      ])).toMatchObject({
        rowsScanned: 501,
        batchesScanned: 2,
        issues: [],
      });
    } finally {
      sqlite.close();
    }
  });

  it('rejects jsonb-incompatible Unicode while accepting valid surrogate pairs', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE json_values (value TEXT NOT NULL)');
    const insert = sqlite.prepare('INSERT INTO json_values VALUES (?)');
    insert.run('"\\u0000"');
    insert.run('{"\\ud800":"value"}');
    insert.run('"\\udc00"');
    insert.run('{"duplicate":"\\u0000","duplicate":"safe"}');
    insert.run('{"duplicate":"\\ud800","duplicate":"safe"}');
    insert.run('{"escaped\\\"key":"safe","next":"\\u0000"}');
    insert.run('"\\ud83d\\ude00"');
    insert.run('"café 世界"');
    try {
      expect(preflightJsonCompatibility(sqlite, [
        { table: 'json_values', column: 'value' },
      ]).issues).toEqual([{
        table: 'json_values',
        column: 'value',
        category: 'unsupported-unicode',
        count: 6,
      }]);
    } finally {
      sqlite.close();
    }
  });

  it('rejects malformed UTF-8 text without exposing replacement-decoded content', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE json_values (value TEXT NOT NULL);
      INSERT INTO json_values VALUES (CAST(X'22C32822' AS TEXT));
    `);
    try {
      expect(preflightJsonCompatibility(sqlite, [
        { table: 'json_values', column: 'value' },
      ])).toMatchObject({
        rowsScanned: 1,
        issues: [{
          table: 'json_values',
          column: 'value',
          category: 'invalid-utf8',
          count: 1,
        }],
      });
    } finally {
      sqlite.close();
    }
  });

  it('applies the deterministic nesting ceiling to arrays and objects, not width', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE json_values (value TEXT NOT NULL)');
    const insert = sqlite.prepare('INSERT INTO json_values VALUES (?)');
    insert.run(JSON.stringify(Array.from({ length: 200_000 }, (_, index) => index)));
    insert.run(`${'['.repeat(101)}0${']'.repeat(101)}`);
    insert.run(`${'{"nested":'.repeat(101)}0${'}'.repeat(101)}`);
    insert.run(`${'[{"nested":'.repeat(51)}0${'}]'.repeat(51)}`);
    insert.run(`{"duplicate":${'['.repeat(101)}0${']'.repeat(101)},"duplicate":"safe"}`);
    try {
      expect(preflightJsonCompatibility(sqlite, [
        { table: 'json_values', column: 'value' },
      ])).toMatchObject({
        rowsScanned: 5,
        issues: [{
          table: 'json_values',
          column: 'value',
          category: 'excessive-nesting',
          count: 4,
        }],
      });
    } finally {
      sqlite.close();
    }
  });

  it('accounts for wide jsonb containers without recursion or spread', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE json_values (value TEXT NOT NULL)');
    sqlite.prepare('INSERT INTO json_values VALUES (?)').run(JSON.stringify(
      Array.from({ length: 200_000 }, (_, index) => (
        index % 4 === 0 ? null : index % 4 === 1 ? true : index % 4 === 2 ? 'value' : index
      )),
    ));
    try {
      expect(preflightJsonCompatibility(sqlite, [
        { table: 'json_values', column: 'value' },
      ])).toMatchObject({
        rowsScanned: 1,
        issues: [],
      });
    } finally {
      sqlite.close();
    }
  });

  it('rejects incompatible source JSON before any PostgreSQL access', async () => {
    const source = retainedSqliteSource();
    try {
      const writable = new Database(source.sourcePath);
      try {
        writable.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('json-preflight-probe', 'ambiguous plain text', '2026-09-01T00:00:00.000Z')
        `).run();
      } finally {
        writable.close();
      }

      await expect(runSqliteToPostgresImport({
        sqliteSourcePath: source.sourcePath,
        confirmWritersStopped: true,
        dryRun: true,
        postgresUrl: 'postgresql://127.0.0.1:1/mission_control_import_rehearsal',
      })).rejects.toThrow(
        'app_settings.value:invalid-json=1',
      );
    } finally {
      source.cleanup();
    }
  }, 30_000);

  it('accepts production-shaped scalar, JSON null, double-encoded, and large settings', async () => {
    vi.stubEnv('MC_POSTGRES_IMPORT_URL', '');
    vi.stubEnv('MC_POSTGRES_URL', '');
    const source = retainedSqliteSource();
    try {
      const writable = new Database(source.sourcePath);
      try {
        const insert = writable.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES (?, ?, '2026-09-01T00:00:00.000Z')
        `);
        insert.run('json-string-scalar', '"historical scalar"');
        insert.run('json-null', 'null');
        insert.run('double-encoded', '"{\\"historical\\":true}"');
        insert.run('large-json-scalar', JSON.stringify('x'.repeat(1_000_000)));
      } finally {
        writable.close();
      }

      const result = await runSqliteToPostgresImport({
        sqliteSourcePath: source.sourcePath,
        confirmWritersStopped: true,
        dryRun: true,
      });

      expect(result.evidence.schema).toMatchObject({
        importTableCount: 163,
        jsonTargetColumnCount: 117,
      });
      expect(result.evidence.schema.jsonRowsScanned).toBeGreaterThan(0);
    } finally {
      source.cleanup();
    }
  }, 30_000);

  it('aggregates production-shaped incompatibilities across tables before target access', async () => {
    const source = retainedSqliteSource();
    try {
      const writable = new Database(source.sourcePath);
      try {
        writable.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('invalid-one', 'ambiguous', '2026-09-01T00:00:00.000Z'),
                 ('invalid-two', '', '2026-09-01T00:00:00.000Z')
        `).run();
        writable.prepare('UPDATE tasks SET metadata = ?').run(Buffer.from('sensitive bytes'));
      } finally {
        writable.close();
      }

      const failure = runSqliteToPostgresImport({
        sqliteSourcePath: source.sourcePath,
        confirmWritersStopped: true,
        dryRun: true,
        postgresUrl: 'postgresql://127.0.0.1:1/mission_control_import_rehearsal',
      });
      await expect(failure).rejects.toThrow('app_settings.value:invalid-json=2');
      await expect(failure).rejects.toThrow('tasks.metadata:unsupported-storage-type=1');
      await expect(failure).rejects.not.toThrow('ambiguous');
      await expect(failure).rejects.not.toThrow('sensitive bytes');
    } finally {
      source.cleanup();
    }
  }, 30_000);

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

    it('imports a consolidated WAL-mode source immutably without creating sidecars', async () => {
      vi.stubEnv('MC_POSTGRES_IMPORT_URL', '');
      vi.stubEnv('MC_POSTGRES_URL', '');
      const source = retainedSqliteSource();
      const sidecarPaths = ['-wal', '-journal', '-shm'].map(
        (suffix) => `${source.sourcePath}${suffix}`,
      );
      try {
        const writable = new Database(source.sourcePath);
        try {
          expect(writable.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
          writable.pragma('wal_checkpoint(TRUNCATE)');
        } finally {
          writable.close();
        }
        expect(sidecarPaths.some(existsSync)).toBe(false);

        const ordinaryReadonly = new Database(source.sourcePath, {
          readonly: true,
          fileMustExist: true,
        });
        let ordinarySidecars: string[];
        try {
          ordinaryReadonly.prepare('SELECT COUNT(*) FROM sqlite_master').get();
          ordinarySidecars = sidecarPaths.filter(existsSync);
        } finally {
          ordinaryReadonly.close();
        }
        for (const sidecarPath of ordinarySidecars) rmSync(sidecarPath, { force: true });

        const sourceHash = sha256(source.sourcePath);
        const result = await runSqliteToPostgresImport({
          sqliteSourcePath: source.sourcePath,
          confirmWritersStopped: true,
          dryRun: true,
        });

        expect(ordinarySidecars).toEqual(expect.arrayContaining([
          `${source.sourcePath}-wal`,
          `${source.sourcePath}-shm`,
        ]));
        expect(result.copiedTables).toHaveLength(163);
        expect(result.evidence.source).toMatchObject({
          walOrJournalPresent: false,
          sidecarsPresent: false,
          openedReadOnly: true,
          immutable: true,
        });
        expect(result.evidence.quiescence).toMatchObject({
          checkedWalAndRollbackJournal: true,
          checkedSidecarsBeforeOpen: true,
        });
        expect(sidecarPaths.some(existsSync)).toBe(false);
        expect(sha256(source.sourcePath)).toBe(sourceHash);
      } finally {
        source.cleanup();
      }
    }, 60_000);

    it.each(['-wal', '-journal', '-shm'])(
      'rejects a preexisting %s sidecar before opening SQLite',
      async (suffix) => {
        const source = retainedSqliteSource();
        try {
          writeFileSync(`${source.sourcePath}${suffix}`, 'preexisting sidecar');
          await expect(runSqliteToPostgresImport({
            sqliteSourcePath: source.sourcePath,
            confirmWritersStopped: true,
            dryRun: true,
          })).rejects.toThrow(
            `SQLite source is not quiescent: mission-control.db${suffix} exists.`,
          );
        } finally {
          source.cleanup();
        }
      },
      30_000,
    );

    it('rejects integrity failures through the immutable source path', async () => {
      const source = retainedSqliteSource();
      try {
        const writable = new Database(source.sourcePath);
        let pageSize: number;
        let rootPage: number;
        try {
          writable.exec(`
            CREATE TABLE corruption_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO corruption_probe (value) VALUES ('must be checked');
          `);
          pageSize = writable.pragma('page_size', { simple: true }) as number;
          rootPage = writable.prepare(
            "SELECT rootpage FROM sqlite_schema WHERE name = 'corruption_probe'",
          ).pluck().get() as number;
        } finally {
          writable.close();
        }
        const corrupted = readFileSync(source.sourcePath);
        corrupted[(rootPage - 1) * pageSize] = 0xff;
        writeFileSync(source.sourcePath, corrupted);

        await expect(runSqliteToPostgresImport({
          sqliteSourcePath: source.sourcePath,
          confirmWritersStopped: true,
          dryRun: true,
        })).rejects.toThrow('SQLite source failed PRAGMA integrity_check.');
      } finally {
        source.cleanup();
      }
    }, 30_000);

    it('enforces read-only query semantics on immutable source handles', () => {
      const source = retainedSqliteSource();
      try {
        const sourceHash = sha256(source.sourcePath);
        const sqlite = openImmutableReadonlySqlite(source.sourcePath);
        try {
          expect(sqlite.readonly).toBe(true);
          expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
          expect(() => sqlite.exec(
            "INSERT INTO app_settings (key, value) VALUES ('immutable.probe', 'blocked')",
          )).toThrow(/readonly database/);
        } finally {
          sqlite.close();
        }
        expect(sha256(source.sourcePath)).toBe(sourceHash);
        expect(['-wal', '-journal', '-shm'].some(
          (suffix) => existsSync(`${source.sourcePath}${suffix}`),
        )).toBe(false);
      } finally {
        source.cleanup();
      }
    }, 30_000);

  it('fails closed when SQLite URI handling was disabled before addon initialization', () => {
    const source = retainedSqliteSource();
    try {
      const importerUrl = pathToFileURL(resolve(
        'scripts',
        'lib',
        'sqlite-to-postgres-import.ts',
      )).href;
      const probe = spawnSync(process.execPath, [
        '--conditions=react-server',
        '--import',
        'tsx',
        '--eval',
        `import(${JSON.stringify(importerUrl)}).then((module) => (module.openImmutableReadonlySqlite ?? module.default?.openImmutableReadonlySqlite)(${JSON.stringify(source.sourcePath)}))`,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, SQLITE_USE_URI: '0' },
      });

      expect(probe.status).not.toBe(0);
      expect(probe.stderr).toContain(
        'SQLITE_USE_URI=1 must be configured before the first better-sqlite3 connection',
      );
      expect(['-wal', '-journal', '-shm'].some(
        (suffix) => existsSync(`${source.sourcePath}${suffix}`),
      )).toBe(false);
    } finally {
      source.cleanup();
    }
  }, 30_000);

  it('rejects source mutation during the immutable read window', async () => {
    vi.stubEnv('MC_POSTGRES_IMPORT_URL', '');
    vi.stubEnv('MC_POSTGRES_URL', '');
    const source = retainedSqliteSource();
    try {
      await expect(runSqliteToPostgresImport({
        sqliteSourcePath: source.sourcePath,
        confirmWritersStopped: true,
        dryRun: true,
        logger: {
          info(message) {
            if (message === 'dry-run-without-target') {
              appendFileSync(source.sourcePath, 'external mutation');
            }
          },
          warn() {},
          error() {},
        },
      })).rejects.toThrow('SQLite source changed after pre-open validation.');
    } finally {
      source.cleanup();
    }
  }, 30_000);

  it('rejects a sidecar that appears during the immutable read window', async () => {
    vi.stubEnv('MC_POSTGRES_IMPORT_URL', '');
    vi.stubEnv('MC_POSTGRES_URL', '');
    const source = retainedSqliteSource();
    try {
      await expect(runSqliteToPostgresImport({
        sqliteSourcePath: source.sourcePath,
        confirmWritersStopped: true,
        dryRun: true,
        logger: {
          info(message) {
            if (message === 'dry-run-without-target') {
              writeFileSync(`${source.sourcePath}-shm`, 'late sidecar');
            }
          },
          warn() {},
          error() {},
        },
      })).rejects.toThrow(
        'SQLite source is not quiescent: mission-control.db-shm exists.',
      );
    } finally {
      source.cleanup();
    }
  }, 30_000);

  it('rolls back copied rows when final source validation fails before commit', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec("CREATE TABLE probe (id TEXT PRIMARY KEY); INSERT INTO probe VALUES ('row-1')");
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    try {
      await expect(copyAllTables(
        pool as never,
        sqlite,
        ['probe'],
        new Map([['probe', [{
          name: 'id',
          dataType: 'text',
          udtName: 'text',
          nullable: false,
          hasDefault: false,
          generated: false,
        }]]]),
        [],
        () => {
          throw new ImportPreconditionError('late source validation failed');
        },
      )).rejects.toThrow('late source validation failed');

      expect(queries).toContain('BEGIN');
      expect(queries).toContain('ROLLBACK');
      expect(queries).not.toContain('COMMIT');
      expect(client.release).toHaveBeenCalledOnce();
    } finally {
      sqlite.close();
    }
  });

  it('isolates target-dependent jsonb rejection without exposing the value', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, payload TEXT)');
    sqlite.prepare('INSERT INTO probe VALUES (?, ?)').run('row-1', '"secret target value"');
    const queries: string[] = [];
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        queries.push(sql);
        if (sql.includes('::jsonb') && values?.includes('"secret target value"')) {
          throw new Error('target detail containing secret target value');
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    try {
      const failure = copyAllTables(
        pool as never,
        sqlite,
        ['probe'],
        new Map([['probe', [
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
        ]]]),
        [],
        () => undefined,
      );
      await expect(failure).rejects.toThrow(
        'probe.payload (target-jsonb-rejected)',
      );
      await expect(failure).rejects.not.toThrow('secret target value');
      expect(queries.some((sql) => sql.includes('COUNT(value::jsonb)'))).toBe(true);
      expect(queries.some((sql) => sql.includes('SELECT value::jsonb'))).toBe(false);
      expect(queries.some((sql) => sql.includes('COUNT($1::jsonb)'))).toBe(true);
      expect(queries.some((sql) => sql === 'SELECT $1::jsonb')).toBe(false);
      expect(queries).toContain('ROLLBACK TO SAVEPOINT validate_jsonb_batch');
      expect(queries).toContain('ROLLBACK TO SAVEPOINT validate_jsonb_value');
      expect(queries).toContain('ROLLBACK');
      expect(queries.join(' ')).not.toContain('secret target value');
    } finally {
      sqlite.close();
    }
  });

  it('cleans and verifies a failed disposable rehearsal schema', async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('FROM information_schema.tables')) return { rows: [] };
        return { rows: [] };
      },
    };

    await cleanupDisposableRehearsalTarget(pool as never);

    expect(queries).toEqual([
      'DROP SCHEMA public CASCADE',
      'CREATE SCHEMA public',
      'DROP SCHEMA IF EXISTS drizzle CASCADE',
      expect.stringContaining('FROM information_schema.tables'),
    ]);
  });

  it('fails closed when disposable rehearsal cleanup cannot be verified', async () => {
    const pool = {
      async query(sql: string) {
        if (sql.includes('FROM information_schema.tables')) {
          return { rows: [{ table_name: 'leftover_table' }] };
        }
        return { rows: [] };
      },
    };

    await expect(cleanupDisposableRehearsalTarget(pool as never)).rejects.toThrow(
      'Disposable rehearsal cleanup left 1 public table(s).',
    );
  });

  it('removes the fixture temp directory when the fixture copy fails', async () => {
    const prefix = 'mc-postgres-import-v1-0000-baseline-';
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix)).sort();

    await expect(runSqliteToPostgresImport({
      fixtureId: 'v1-0000-baseline',
      fixtureDirectory: join(tmpdir(), 'missing-mc-fixture-directory'),
      dryRun: true,
    })).rejects.toThrow();

    expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix)).sort()).toEqual(before);
  });

  it.each(productionTasksFixtures)(
    'emits non-activating full dry-run evidence for $tasksHistoricalOrder tasks history',
    async (fixture) => {
    vi.stubEnv('MC_POSTGRES_IMPORT_URL', '');
    vi.stubEnv('MC_POSTGRES_URL', '');

    const result = await runSqliteToPostgresImport({
      fixtureId: fixture.id,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.rehearsal).toBe(true);
    expect(result.evidence.command.activationChanged).toBe(false);
    expect(result.evidence.source.kind).toBe('persisted-state-fixture');
    expect(result.evidence.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence.schema.sqliteMigrationCount).toBe(229);
    expect(result.evidence.schema.importTableCount).toBe(163);
    expect(result.copiedTables).toHaveLength(163);
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
    },
    60_000,
  );

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

      expect(validateSqliteMigrationState(sqlite, migrationsDirectory)).toBe(129);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it('accepts the historical priority entity layout created before reference_id existed', () => {
    const sqlite = currentSqlite();
    try {
      replacePriorityEntityTable(sqlite, historicalPriorityEntityColumns);

      expect(validateSqliteMigrationState(sqlite, migrationsDirectory)).toBe(128);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it.each(productionTasksFixtures)(
    'reports the exact raw mismatch set for $tasksHistoricalOrder tasks history',
    (fixtureDefinition) => {
    const fixture = productionHistoricalSqlite(fixtureDefinition.tasksHistoricalOrder);
    try {
      const mismatches = compareSqliteImportSchema(fixture, migrationsDirectory);
      expect(mismatches.map(({ table }) => table)).toEqual(productionHistoricalTables);
      expect(mismatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'inbound_webhooks', supportedHistoricalShape: true }),
        expect.objectContaining({ table: 'priority_entities', supportedHistoricalShape: true }),
        expect.objectContaining({
          table: 'routines',
          columnMismatches: [
            { column: 'is_active', properties: ['default'] },
            { column: 'is_archived', properties: ['default'] },
          ],
          columnOrderMismatch: false,
          supportedHistoricalShape: true,
        }),
        expect.objectContaining({
          table: 'subtask_templates',
          columnMismatches: [{ column: 'is_built_in', properties: ['default'] }],
          columnOrderMismatch: true,
          supportedHistoricalShape: true,
        }),
        expect.objectContaining({
          table: 'sync_log',
          columnMismatches: [],
          columnOrderMismatch: true,
          supportedHistoricalShape: true,
        }),
        expect.objectContaining({
          table: 'task_triage_log',
          columnMismatches: [],
          columnOrderMismatch: true,
          supportedHistoricalShape: true,
        }),
        expect.objectContaining({
          table: 'tasks',
          columnMismatches: [],
          columnOrderMismatch: true,
          supportedHistoricalShape: true,
        }),
        expect.objectContaining({
          table: 'triage_sync_state',
          columnMismatches: [{ column: 'id', properties: ['nullability'] }],
          columnOrderMismatch: false,
          supportedHistoricalShape: true,
        }),
      ]));
      expect(validateSqliteMigrationState(fixture, migrationsDirectory)).toBe(229);
    } finally {
      fixture.close();
    }
    },
    20_000,
  );

  it('accepts the exact released-runtime tasks order created before late migrations arrived', () => {
    const fixture = productionHistoricalSqlite('released-runtime-first');
    try {
      const mismatches = compareSqliteImportSchema(
        fixture,
        migrationsDirectory,
      );
      expect(mismatches.map(({ table }) => table)).toEqual(productionHistoricalTables);
      expect(mismatches.every(({ supportedHistoricalShape }) => (
        supportedHistoricalShape
      ))).toBe(true);
      const tasksMismatch = mismatches.find(({ table }) => table === 'tasks');
      expect(tasksMismatch).toMatchObject({
        columnMismatches: [],
        columnOrderMismatch: true,
        supportedHistoricalShape: true,
      });
      expect(tasksMismatch?.actualColumnOrder.slice(-7)).toEqual([
        'push_retry_count',
        'local_disposition',
        'recurrence_generated_from_task_id',
        'planning_horizon',
        'push_count',
        'reminder_relative',
        'reminder_due_time',
      ]);
      expect(validateSqliteMigrationState(fixture, migrationsDirectory)).toBe(229);
    } finally {
      fixture.close();
    }
  }, 20_000);

  it('accepts the exact continuously upgraded production tasks order', () => {
    const fixture = productionHistoricalSqlite('continuous-production');
    try {
      const tasksMismatch = compareSqliteImportSchema(
        fixture,
        migrationsDirectory,
      ).find(({ table }) => table === 'tasks');
      expect(tasksMismatch).toEqual(expect.objectContaining({
        columnMismatches: [],
        columnOrderMismatch: true,
        expectedColumnOrder: deriveTrustedTasksColumnOrders().get('fresh'),
        actualColumnOrder: deriveTrustedTasksColumnOrders().get('continuous-production'),
        supportedHistoricalShape: true,
      }));
      expect(validateSqliteMigrationState(fixture, migrationsDirectory)).toBe(229);
    } finally {
      fixture.close();
    }
  }, 20_000);

  it('checks all planned source tables with one aggregate pragma_table_xinfo query', () => {
    const sqlite = productionHistoricalSqlite('released-runtime-first');
    const prepare = vi.spyOn(sqlite, 'prepare');
    try {
      const mismatches = compareSqliteImportSchema(sqlite, migrationsDirectory);
      expect(expectedImportTableNames().sourceTables).toHaveLength(163);
      expect(mismatches.every(({ missingTable }) => !missingTable)).toBe(true);
      const aggregateCalls = prepare.mock.calls.filter(
        ([sql]) => String(sql).includes('CROSS JOIN pragma_table_xinfo'),
      );
      expect(aggregateCalls).toHaveLength(1);
      expect(String(aggregateCalls[0]?.[0]).match(/\?/g)).toHaveLength(163);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it.each([
    'declared type',
    'nullability',
    'default',
    'primary key',
    'near-neighbor order',
    'missing column',
    'unexpected column',
    'hidden generated column',
  ])('rejects every trusted retained tasks history with a %s perturbation', (mismatch) => {
    for (const fixtureDefinition of productionTasksFixtures) {
      const sqlite = productionHistoricalSqlite(fixtureDefinition.tasksHistoricalOrder);
    try {
      if (mismatch === 'hidden generated column') {
        sqlite.exec(`
          ALTER TABLE tasks
          ADD COLUMN generated_probe TEXT
          GENERATED ALWAYS AS (title) VIRTUAL
        `);
      } else {
        replaceHistoricalTable(sqlite, 'tasks', (columns) => {
          if (mismatch === 'declared type') {
            return columns.map((column) => (
              column.name === 'description' ? { ...column, type: 'BLOB' } : column
            ));
          }
          if (mismatch === 'nullability') {
            return columns.map((column) => (
              column.name === 'description' ? { ...column, notnull: 1 } : column
            ));
          }
          if (mismatch === 'default') {
            return columns.map((column) => (
              column.name === 'status' ? { ...column, dfltValue: "'unexpected'" } : column
            ));
          }
          if (mismatch === 'primary key') {
            return columns.map((column) => (
              column.name === 'id' ? { ...column, pk: 0 } : column
            ));
          }
          if (mismatch === 'near-neighbor order') {
            const relative = columns.findIndex((column) => column.name === 'reminder_relative');
            const reordered = [...columns];
            [reordered[relative], reordered[relative + 1]] = [
              reordered[relative + 1],
              reordered[relative],
            ];
            return reordered;
          }
          if (mismatch === 'missing column') return columns.slice(0, -1);
          if (mismatch === 'unexpected column') {
            return [...columns, {
              name: 'unknown_future_column',
              type: 'TEXT',
              notnull: 0,
              dfltValue: null,
              pk: 0,
              hidden: 0,
            }];
          }
          throw new Error(`Unhandled released-runtime mismatch: ${mismatch}`);
        });
      }

      expect(() => validateSqliteMigrationState(
        sqlite,
        migrationsDirectory,
      )).toThrow(/tasks/);
    } finally {
      sqlite.close();
    }
    }
  }, 20_000);

  it('reports secret-safe expected and actual sequences for unsupported task orders', () => {
    const sqlite = productionHistoricalSqlite('released-runtime-first');
    try {
      replaceHistoricalTable(sqlite, 'tasks', (columns) => [
        columns[1],
        columns[0],
        ...columns.slice(2),
      ]);
      let message = '';
      try {
        validateSqliteMigrationState(sqlite, migrationsDirectory);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(
        /column-order expected=\[id,source_id,.*planning_horizon,status_reason,push_retry_count\] actual=\[source_id,id,.*reminder_due_time\]/,
      );
      expect(message).not.toMatch(/CREATE TABLE|DEFAULT|Synthetic|saffronruntime/);
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it('rejects historical allowlists that do not cover a future expected column', () => {
    const current = currentSqlite();
    const historical = productionHistoricalSqlite();
    try {
      const futureColumn: TestSqliteColumn = {
        name: 'future_required_column',
        type: 'TEXT',
        notnull: 1,
        dfltValue: null,
        pk: 0,
        hidden: 0,
      };
      expect(matchesSupportedSqliteColumnShape(
        'routines',
        [...tableShape(current, 'routines'), futureColumn],
        tableShape(historical, 'routines'),
      )).toBe(false);
    } finally {
      current.close();
      historical.close();
    }
  }, 20_000);

  const exactHistoricalRejectionCases = newlySupportedHistoricalTables.flatMap((table) => [
    { table, mismatch: 'declared type' },
    { table, mismatch: 'nullability' },
    { table, mismatch: 'primary key' },
    { table, mismatch: 'column order' },
    { table, mismatch: 'missing column' },
    { table, mismatch: 'unexpected column' },
    { table, mismatch: 'hidden generated column' },
    ...(table !== 'task_triage_log'
      ? [{ table, mismatch: 'alternate historical default' }]
      : []),
  ]);

  it.each(exactHistoricalRejectionCases)(
    'rejects the $table historical shape with a $mismatch perturbation',
    ({ table, mismatch }) => {
      const sqlite = productionHistoricalSqlite();
      try {
        if (mismatch === 'hidden generated column') {
          sqlite.exec(`
            ALTER TABLE "${table}"
            ADD COLUMN generated_probe TEXT
            GENERATED ALWAYS AS (id) VIRTUAL
          `);
        } else {
          replaceHistoricalTable(sqlite, table, (columns) => {
            if (mismatch === 'declared type') {
              const index = columns.findIndex((column) => column.pk === 0);
              return columns.map((column, columnIndex) => (
                columnIndex === index ? { ...column, type: 'BLOB' } : column
              ));
            }
            if (mismatch === 'nullability') {
              const index = columns.findIndex(
                (column) => column.pk === 0 && column.notnull === 0,
              );
              return columns.map((column, columnIndex) => (
                columnIndex === index ? { ...column, notnull: 1 } : column
              ));
            }
            if (mismatch === 'primary key') {
              return columns.map((column) => (
                column.pk > 0 ? { ...column, pk: 0 } : column
              ));
            }
            if (mismatch === 'column order') {
              return [columns[1], columns[0], ...columns.slice(2)];
            }
            if (mismatch === 'missing column') {
              return columns.slice(0, -1);
            }
            if (mismatch === 'unexpected column') {
              return [...columns, {
                name: 'unknown_future_column',
                type: 'TEXT',
                notnull: 0,
                dfltValue: null,
                pk: 0,
                hidden: 0,
              }];
            }
            if (mismatch === 'alternate historical default') {
              const defaultColumn = {
                routines: 'is_active',
                subtask_templates: 'is_built_in',
                sync_log: 'tasks_added',
                tasks: 'status',
                triage_sync_state: 'total_imported',
              }[table];
              return columns.map((column) => (
                column.name === defaultColumn
                  ? {
                      ...column,
                      dfltValue: column.type === 'TEXT' ? "'unexpected'" : '2',
                    }
                  : column
              ));
            }
            throw new Error(`Unhandled historical mismatch: ${mismatch}`);
          });
        }

        expect(() => validateSqliteMigrationState(
          sqlite,
          migrationsDirectory,
        )).toThrow(new RegExp(table));
      } finally {
        sqlite.close();
      }
    },
    20_000,
  );

  it('accepts only the exact historical inbound webhook default representation', () => {
    const sqlite = currentSqlite();
    try {
      replaceInboundWebhookTable(sqlite, historicalInboundWebhookColumns);
      expect(validateSqliteMigrationState(sqlite, migrationsDirectory)).toBe(128);
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

  it('summarizes every incompatible production-history table and field in one secret-safe error', () => {
    const sqlite = productionHistoricalSqlite();
    try {
      replaceHistoricalTable(sqlite, 'routines', (columns) => columns.map((column) => (
        column.name === 'is_active' ? { ...column, dfltValue: '2' } : column
      )));
      sqlite.exec('ALTER TABLE tasks ADD COLUMN unknown_future_column TEXT');
      replaceHistoricalTable(sqlite, 'triage_sync_state', (columns) => columns.map((column) => (
        column.name === 'last_cursor' ? { ...column, notnull: 1 } : column
      )));

      expect(() => validateSqliteMigrationState(
        sqlite,
        migrationsDirectory,
      )).toThrow(
        /3 table\(s\): routines .*is_active:default.*tasks .*unexpected: unknown_future_column.*triage_sync_state .*last_cursor:nullability/,
      );
    } finally {
      sqlite.close();
    }
  }, 20_000);

  it('rejects an unexpected generated column omitted by pragma_table_info', () => {
    const sqlite = currentSqlite();
    try {
      sqlite.exec(`
        ALTER TABLE tasks
        ADD COLUMN generated_probe TEXT
        GENERATED ALWAYS AS (title) VIRTUAL
      `);

      expect(
        (sqlite.prepare(
          "SELECT name FROM pragma_table_info('tasks') WHERE name = 'generated_probe'",
        ).get()),
      ).toBeUndefined();
      expect(
        (sqlite.prepare(
          "SELECT hidden FROM pragma_table_xinfo('tasks') WHERE name = 'generated_probe'",
        ).get()),
      ).toEqual({ hidden: 2 });
      expect(compareSqliteImportSchema(
        sqlite,
        migrationsDirectory,
      )).toEqual([
        expect.objectContaining({
          table: 'tasks',
          unexpectedColumns: ['generated_probe'],
          supportedHistoricalShape: false,
        }),
      ]);
      expect(() => validateSqliteMigrationState(
        sqlite,
        migrationsDirectory,
      )).toThrow(
        /1 table\(s\): tasks .*unexpected: generated_probe/,
      );
    } finally {
      sqlite.close();
    }
  }, 20_000);
});
