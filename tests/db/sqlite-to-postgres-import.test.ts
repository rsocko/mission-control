import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
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
  matchesSupportedSqliteColumnShape,
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

    expect(tables.sourceTables).toHaveLength(160);
    expect(tables.targetTables).toHaveLength(162);
    expect(tables.sourceTables).toContain('tasks');
    expect(tables.sourceTables).toContain('notifications');
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
    expect(result.evidence.schema.sqliteMigrationCount).toBe(227);
    expect(result.evidence.schema.importTableCount).toBe(160);
    expect(result.copiedTables).toHaveLength(160);
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
      expect(validateSqliteMigrationState(fixture, migrationsDirectory)).toBe(227);
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
      expect(validateSqliteMigrationState(fixture, migrationsDirectory)).toBe(227);
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
      expect(validateSqliteMigrationState(fixture, migrationsDirectory)).toBe(227);
    } finally {
      fixture.close();
    }
  }, 20_000);

  it('checks all planned source tables with one aggregate pragma_table_xinfo query', () => {
    const sqlite = productionHistoricalSqlite('released-runtime-first');
    const prepare = vi.spyOn(sqlite, 'prepare');
    try {
      const mismatches = compareSqliteImportSchema(sqlite, migrationsDirectory);
      expect(expectedImportTableNames().sourceTables).toHaveLength(160);
      expect(mismatches.every(({ missingTable }) => !missingTable)).toBe(true);
      const aggregateCalls = prepare.mock.calls.filter(
        ([sql]) => String(sql).includes('CROSS JOIN pragma_table_xinfo'),
      );
      expect(aggregateCalls).toHaveLength(1);
      expect(String(aggregateCalls[0]?.[0]).match(/\?/g)).toHaveLength(160);
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
