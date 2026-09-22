import './configure-sqlite-uri';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import pg from 'pg';
import { getTableColumns } from 'drizzle-orm/utils';
import { getTableName, isTable, type Table } from 'drizzle-orm/table';
import { runOrderedDatabaseBootstrap } from '../../src/db/bootstrap/registry';
import { resolvePostgresConfig } from '../../src/db/postgres/config';
import { createPostgresPool } from '../../src/db/postgres/connection';
import { runPostgresMigrations } from '../../src/db/postgres/migrations';
import { PostgresKeywordSearchRepository } from '../../src/db/postgres/search';
import * as postgresSchema from '../../src/db/postgres/schema';
import * as sqliteSchema from '../../src/db/schema';
import {
  PERSISTED_STATE_FIXTURES,
  type PersistedStateFixture,
} from '../persisted-state-fixture-manifest';
import { trustedRetainedMigrationHashes } from '../sqlite-migration-history';
import { trustedHistoricalTasksColumnOrders } from '../sqlite-task-schema-history';

const { Pool } = pg;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_SQLITE_MIGRATIONS_DIRECTORY = join(REPOSITORY_ROOT, 'drizzle');
const DEFAULT_POSTGRES_MIGRATIONS_DIRECTORY = join(REPOSITORY_ROOT, 'drizzle', 'postgres');
const DEFAULT_FIXTURE_DIRECTORY = join(
  REPOSITORY_ROOT,
  'tests',
  'fixtures',
  'persisted-state',
  'sqlite',
);

const POSTGRES_SEARCH_PROJECTION_TABLES = new Set([
  'task_search_documents',
  'notification_search_documents',
]);

const QUIESCENT_SYNC_JOB_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'succeeded',
  'skipped',
]);
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-journal', '-shm'] as const;
const JSON_PREFLIGHT_BATCH_SIZE = 500;
// PostgreSQL's parser limit depends on server stack settings. A fixed conservative ceiling makes
// source-only acceptance deterministic and prevents environment-specific failures after writes.
const JSON_MAX_NESTING_DEPTH = 100;
const JSON_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const REPRESENTATIVE_TABLES = [
  'tasks',
  'hub_projects',
  'connector_configs',
  'sync_jobs',
  'sync_job_events',
  'sync_log',
  'notifications',
  'app_settings',
  'task_projects',
  'task_dependencies',
] as const;

export interface ImportLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SqliteToPostgresImportOptions {
  sqliteSourcePath?: string;
  fixtureId?: string;
  postgresUrl?: string;
  dryRun?: boolean;
  rehearsal?: boolean;
  resetDisposableRehearsalTarget?: boolean;
  confirmWritersStopped?: boolean;
  sqliteMigrationsDirectory?: string;
  postgresMigrationsDirectory?: string;
  fixtureDirectory?: string;
  logger?: ImportLogger;
}

export interface ImportTableCount {
  table: string;
  sourceRows: number;
  targetRows?: number;
}

export interface ImportInvariantReport {
  allCopiedTableCountsMatch: boolean;
  representativeCounts: readonly ImportTableCount[];
  taskSearchDocuments: number;
  notificationSearchDocuments: number;
  orphanTaskProjects: number;
  orphanTaskDependencies: number;
  orphanSyncJobEvents: number;
  orphanNotificationTasks: number;
}

export interface ImportEvidence {
  readonly command: {
    readonly mode: 'dry-run' | 'import';
    readonly rehearsal: boolean;
    readonly resetDisposableRehearsalTarget: boolean;
    readonly activationChanged: false;
  };
  readonly source: {
    readonly kind: 'sqlite-file' | 'persisted-state-fixture';
    readonly label: string;
    readonly identity: string;
    readonly sha256: string;
    readonly retainedArtifact: boolean;
    readonly walOrJournalPresent: boolean;
    readonly sidecarsPresent: false;
    readonly openedReadOnly: true;
    readonly immutable: true;
    readonly integrityCheck: 'ok';
    readonly foreignKeyViolations: number;
  };
  readonly target: {
    readonly identity: string;
    readonly initializedSchema: boolean;
    readonly resetDisposableTarget: boolean;
    readonly emptyAttestation: TargetState['emptyAttestation'] | 'not-checked';
  };
  readonly schema: {
    readonly sqliteMigrationCount: number;
    readonly importTableCount: number;
    readonly targetTableCount: number;
    readonly jsonTargetColumnCount: number;
    readonly jsonRowsScanned: number;
  };
  readonly quiescence: {
    readonly writersStoppedConfirmed: boolean;
    readonly checkedWalAndRollbackJournal: boolean;
    readonly checkedSidecarsBeforeOpen: true;
    readonly activeSyncJobs: number;
    readonly acceptedForSyntheticFixture: boolean;
  };
  readonly derivedState: {
    readonly droppedFromImport: readonly string[];
    readonly rebuilt: readonly string[];
    readonly semanticVectorCheck: 'not-applicable-to-relational-import';
  };
  readonly workerReadinessHooks: {
    readonly queueRowsCopied: number;
    readonly smokeAfterActivationRequired: true;
  };
  readonly rollback: {
    readonly sqliteSourceRetained: boolean;
    readonly activationGateRequired: true;
    readonly cleanupRequiredOnFailure: string;
  };
  readonly observability: {
    readonly logsSecretSafe: true;
    readonly recommendedSignals: readonly string[];
  };
  readonly verdict: {
    readonly ready_for_cutover_planning: boolean;
    readonly reason: string;
  };
}

export interface SqliteToPostgresImportResult {
  dryRun: boolean;
  rehearsal: boolean;
  sourceKind: 'sqlite-file' | 'persisted-state-fixture';
  sourceLabel: string;
  copiedTables: readonly ImportTableCount[];
  initializedTarget: boolean;
  resetDisposableTarget: boolean;
  evidence: ImportEvidence;
  invariants?: ImportInvariantReport;
}

interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when?: number;
}

interface MigrationJournal {
  readonly entries: readonly MigrationJournalEntry[];
}

interface SourceHandle {
  readonly sqlite: Database.Database;
  readonly path: string;
  readonly label: string;
  readonly kind: 'sqlite-file' | 'persisted-state-fixture';
  readonly sha256: string;
  readonly cleanup: () => void;
}

interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly udtName: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
}

export type JsonCompatibilityCategory =
  | 'invalid-json'
  | 'invalid-utf8'
  | 'excessive-nesting'
  | 'target-jsonb-rejected'
  | 'unsupported-unicode'
  | 'unsupported-storage-type';

export interface JsonTargetColumn {
  readonly table: string;
  readonly column: string;
}

export interface JsonCompatibilityIssue extends JsonTargetColumn {
  readonly category: JsonCompatibilityCategory;
  readonly count: number;
}

export interface JsonPreflightReport {
  readonly targetColumns: readonly JsonTargetColumn[];
  readonly rowsScanned: number;
  readonly batchesScanned: number;
  readonly issues: readonly JsonCompatibilityIssue[];
}

export interface SqliteColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dfltValue: string | null;
  readonly pk: number;
  readonly hidden: number;
}

interface SqliteTableColumnInfo extends SqliteColumnInfo {
  readonly tableName: string;
}

export interface SqliteColumnMismatch {
  readonly column: string;
  readonly properties: readonly (
    'type' | 'nullability' | 'default' | 'primary-key' | 'hidden'
  )[];
}

export interface SqliteSchemaMismatch {
  readonly table: string;
  readonly missingTable: boolean;
  readonly missingColumns: readonly string[];
  readonly unexpectedColumns: readonly string[];
  readonly columnMismatches: readonly SqliteColumnMismatch[];
  readonly columnOrderMismatch: boolean;
  readonly expectedColumnOrder: readonly string[];
  readonly actualColumnOrder: readonly string[];
  readonly supportedHistoricalShape: boolean;
}

interface ForeignKeyInfo {
  readonly table: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
}

interface SequenceInfo {
  readonly sequenceName: string;
  readonly table: string;
  readonly column: string;
}

interface TargetState {
  readonly initialized: boolean;
  readonly reset: boolean;
  readonly emptyAttestation:
    | 'empty'
    | 'empty-after-disposable-reset'
    | 'dry-run-empty'
    | 'dry-run-would-reset'
    | 'empty-existing-schema';
}

export class ImportPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportPreconditionError';
  }
}

export class ImportInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportInvariantError';
  }
}

export class ImportValueCompatibilityError extends ImportPreconditionError {
  constructor(
    readonly table: string,
    readonly column: string,
    readonly category: JsonCompatibilityCategory,
  ) {
    super(`SQLite import value is incompatible with PostgreSQL at ${table}.${column} (${category}).`);
    this.name = 'ImportValueCompatibilityError';
  }
}

function noopLogger(): ImportLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function exportedTableNames(schema: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (isTable(value)) {
      names.add(getTableName(value as Table));
    }
  }
  return names;
}

export function expectedImportTableNames(): {
  readonly sourceTables: readonly string[];
  readonly targetTables: readonly string[];
} {
  const sqliteTables = exportedTableNames(sqliteSchema);
  const postgresTables = exportedTableNames(postgresSchema);
  const targetTables = [...postgresTables].sort();
  const sourceTables = targetTables
    .filter((table) => sqliteTables.has(table))
    .filter((table) => !POSTGRES_SEARCH_PROJECTION_TABLES.has(table))
    .sort();
  return { sourceTables, targetTables };
}

export function expectedJsonTargetColumns(
  sourceTables = expectedImportTableNames().sourceTables,
): readonly JsonTargetColumn[] {
  const sourceTableSet = new Set(sourceTables);
  const sqliteTables = new Map(
    Object.values(sqliteSchema)
      .filter(isTable)
      .map((table) => [getTableName(table as Table), table as Table]),
  );
  const columns: JsonTargetColumn[] = [];
  for (const value of Object.values(postgresSchema)) {
    if (!isTable(value)) continue;
    const table = getTableName(value as Table);
    if (!sourceTableSet.has(table)) continue;
    const sqliteTable = sqliteTables.get(table);
    const sqliteColumns = sqliteTable
      ? new Map(Object.values(getTableColumns(sqliteTable)).map((column) => [column.name, column]))
      : new Map();
    for (const column of Object.values(getTableColumns(value as Table))) {
      if (column.dataType === 'json') {
        if (column.getSQLType() !== 'jsonb') {
          throw new ImportPreconditionError(
            `PostgreSQL JSON import target ${table}.${column.name} has unsupported type ${column.getSQLType()}.`,
          );
        }
        if (sqliteColumns.get(column.name)?.dataType !== 'json') {
          throw new ImportPreconditionError(
            `SQLite JSON source mapping is missing for PostgreSQL target ${table}.${column.name}.`,
          );
        }
        columns.push({ table, column: column.name });
      }
    }
  }
  return columns.sort((left, right) => (
    left.table.localeCompare(right.table) || left.column.localeCompare(right.column)
  ));
}

function readMigrationJournal(migrationsDirectory: string): MigrationJournal {
  return JSON.parse(
    readFileSync(join(migrationsDirectory, 'meta', '_journal.json'), 'utf8'),
  ) as MigrationJournal;
}

export function currentSqliteMigrationHashes(
  migrationsDirectory = DEFAULT_SQLITE_MIGRATIONS_DIRECTORY,
): readonly string[] {
  return readMigrationJournal(migrationsDirectory).entries
    .map((entry) => createHash('sha256')
      .update(
        readFileSync(join(migrationsDirectory, `${entry.tag}.sql`), 'utf8')
          .replace(/\r\n?/g, '\n'),
      )
      .digest('hex'))
    .sort();
}

function currentSqliteMigrationEvidence(
  migrationsDirectory: string,
): readonly {
  readonly tag: string;
  readonly when: number;
  readonly hashes: readonly [string, string];
}[] {
  return readMigrationJournal(migrationsDirectory).entries.map((entry) => {
    if (typeof entry.when !== 'number') {
      throw new ImportPreconditionError(
        `SQLite migration metadata is missing a timestamp for ${entry.tag}.`,
      );
    }
    const normalizedSql = readFileSync(
      join(migrationsDirectory, `${entry.tag}.sql`),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    return {
      tag: entry.tag,
      when: entry.when,
      hashes: [
        createHash('sha256').update(normalizedSql).digest('hex'),
        createHash('sha256').update(normalizedSql.replace(/\n/g, '\r\n')).digest('hex'),
      ],
    };
  });
}

export function currentPostgresMigrationHashes(
  migrationsDirectory = DEFAULT_POSTGRES_MIGRATIONS_DIRECTORY,
): readonly string[] {
  return readMigrationJournal(migrationsDirectory).entries
    .map((entry) => createHash('sha256')
      .update(readFileSync(join(migrationsDirectory, `${entry.tag}.sql`), 'utf8'))
      .digest('hex'))
    .sort();
}

function sqliteTableExists(sqlite: Database.Database, table: string): boolean {
  return sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(table) !== undefined;
}

function sqliteColumnShape(
  sqlite: Database.Database,
  table: string,
): readonly SqliteColumnInfo[] {
  return (sqlite.prepare(`
    SELECT name, type, "notnull", dflt_value AS dfltValue, pk, hidden
    FROM pragma_table_xinfo(?)
    ORDER BY cid
  `).all(table) as SqliteColumnInfo[]);
}

function sqliteImportSchemaColumns(
  sqlite: Database.Database,
  sourceTables: readonly string[],
): ReadonlyMap<string, readonly SqliteColumnInfo[]> {
  if (sourceTables.length === 0) return new Map();
  const placeholders = sourceTables.map(() => '?').join(', ');
  const rows = sqlite.prepare(`
    SELECT tables.name AS tableName, columns.name, columns.type,
      columns."notnull", columns.dflt_value AS dfltValue,
      columns.pk, columns.hidden
    FROM sqlite_schema AS tables
    CROSS JOIN pragma_table_xinfo(tables.name) AS columns
    WHERE tables.type = 'table'
      AND tables.name IN (${placeholders})
    ORDER BY tables.name, columns.cid
  `).all(...sourceTables) as SqliteTableColumnInfo[];
  const columnsByTable = new Map<string, SqliteColumnInfo[]>();
  for (const { tableName, ...column } of rows) {
    const tableColumns = columnsByTable.get(tableName) ?? [];
    tableColumns.push(column);
    columnsByTable.set(tableName, tableColumns);
  }
  return columnsByTable;
}

function sqliteWritableColumnNames(
  sqlite: Database.Database,
  table: string,
): readonly string[] {
  return sqliteColumnShape(sqlite, table)
    .filter((column) => column.hidden === 0)
    .map((column) => column.name);
}

export function matchesSupportedSqliteColumnShape(
  table: string,
  expected: readonly SqliteColumnInfo[],
  actual: readonly SqliteColumnInfo[],
): boolean {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return true;
  const withExactOrder = (
    columnNames: readonly string[],
    overrides: Readonly<Record<string, Partial<SqliteColumnInfo>>> = {},
  ): readonly SqliteColumnInfo[] | undefined => {
    const expectedByName = new Map(expected.map((column) => [column.name, column]));
    if (
      columnNames.length !== expected.length
      || new Set(columnNames).size !== expected.length
      || columnNames.some((name) => !expectedByName.has(name))
    ) {
      return undefined;
    }
    return columnNames.map((name) => {
      const column = expectedByName.get(name);
      if (!column) {
        throw new ImportPreconditionError(
          `Historical SQLite schema definition references unknown column ${name}.`,
        );
      }
      return { ...column, ...overrides[name] };
    });
  };
  if (table === 'priority_entities') {
    const referenceColumnIndex = expected.findIndex((column) => column.name === 'reference_id');
    if (referenceColumnIndex < 0) return false;
    const historical = [
      ...expected.slice(0, referenceColumnIndex),
      ...expected.slice(referenceColumnIndex + 1),
      expected[referenceColumnIndex],
    ];
    return JSON.stringify(historical) === JSON.stringify(actual);
  }
  if (table === 'inbound_webhooks') {
    const historical = expected.map((column) => (
      column.name === 'enabled'
        ? { ...column, dfltValue: '1' }
        : column
    ));
    return JSON.stringify(historical) === JSON.stringify(actual);
  }
  if (table === 'routines') {
    const historical = withExactOrder([
      'id',
      'name',
      'description',
      'cadence_type',
      'cadence_config',
      'icon',
      'sort_order',
      'is_active',
      'is_archived',
      'created_at',
      'updated_at',
    ], {
      is_active: { dfltValue: '1' },
      is_archived: { dfltValue: '0' },
    });
    return JSON.stringify(historical) === JSON.stringify(actual);
  }
  if (table === 'subtask_templates') {
    const historical = withExactOrder([
      'id',
      'name',
      'description',
      'category',
      'type',
      'subtasks',
      'workflow_tasks',
      'icon',
      'is_built_in',
      'created_at',
      'updated_at',
    ], {
      is_built_in: { dfltValue: '0' },
    });
    return JSON.stringify(historical) === JSON.stringify(actual);
  }
  if (table === 'sync_log') {
    const historical = withExactOrder([
      'id',
      'connector_id',
      'success',
      'tasks_added',
      'tasks_updated',
      'tasks_removed',
      'alerts_added',
      'errors',
      'synced_at',
      'duration_ms',
      'tasks_pushed',
      'local_only_protected',
      'details',
      'job_id',
      'trigger',
      'scheduled_for',
      'started_at',
      'attempt',
      'max_attempts',
      'identity_mode',
      'identity_mode_revision',
    ]);
    return JSON.stringify(historical) === JSON.stringify(actual);
  }
  if (table === 'task_triage_log') {
    const historical = withExactOrder([
      'id',
      'task_id',
      'mode',
      'action',
      'triaged_at',
      'operation_id',
      'reversed_at',
    ]);
    return JSON.stringify(historical) === JSON.stringify(actual);
  }
  if (table === 'tasks') {
    const historicalShapes = trustedHistoricalTasksColumnOrders()
      .map((order) => withExactOrder(order));
    return historicalShapes.some(
      (historical) => JSON.stringify(historical) === JSON.stringify(actual),
    );
  }
  if (table === 'triage_sync_state') {
    const historical = withExactOrder([
      'id',
      'last_cursor',
      'last_synced_at',
      'total_imported',
      'total_skipped',
      'last_run_imported',
      'last_run_skipped',
      'last_run_errors',
      'last_run_duration_ms',
      'revision',
    ], {
      id: { notnull: 0 },
    });
    return JSON.stringify(historical) === JSON.stringify(actual);
  }
  return false;
}

function sqliteCount(sqlite: Database.Database, table: string): number {
  const row = sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`,
  ).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function fileSha256(path: string): string {
  const file = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    while ((bytesRead = readSync(file, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    closeSync(file);
  }
}

function currentSqliteSchemaColumns(
  migrationsDirectory: string,
  sourceTables: readonly string[],
): ReadonlyMap<string, readonly SqliteColumnInfo[]> {
  const current = new Database(':memory:');
  try {
    runOrderedDatabaseBootstrap(current, migrationsDirectory);
    const columns = sqliteImportSchemaColumns(current, sourceTables);
    for (const table of sourceTables) {
      if (!columns.has(table)) {
        throw new ImportPreconditionError(
          `Current SQLite bootstrap did not create required import table ${table}.`,
        );
      }
    }
    return columns;
  } finally {
    current.close();
  }
}

function sqliteColumnMismatches(
  expected: readonly SqliteColumnInfo[],
  actual: readonly SqliteColumnInfo[],
): readonly SqliteColumnMismatch[] {
  const actualByName = new Map(actual.map((column) => [column.name, column]));
  return expected.flatMap((expectedColumn) => {
    const actualColumn = actualByName.get(expectedColumn.name);
    if (!actualColumn) return [];
    const properties: SqliteColumnMismatch['properties'][number][] = [];
    if (expectedColumn.type !== actualColumn.type) properties.push('type');
    if (expectedColumn.notnull !== actualColumn.notnull) properties.push('nullability');
    if (expectedColumn.dfltValue !== actualColumn.dfltValue) properties.push('default');
    if (expectedColumn.pk !== actualColumn.pk) properties.push('primary-key');
    if (expectedColumn.hidden !== actualColumn.hidden) properties.push('hidden');
    return properties.length > 0
      ? [{ column: expectedColumn.name, properties }]
      : [];
  });
}

export function compareSqliteImportSchema(
  sqlite: Database.Database,
  migrationsDirectory: string,
  sourceTables = expectedImportTableNames().sourceTables,
): readonly SqliteSchemaMismatch[] {
  const currentColumns = currentSqliteSchemaColumns(migrationsDirectory, sourceTables);
  const actualColumns = sqliteImportSchemaColumns(sqlite, sourceTables);
  const mismatches: SqliteSchemaMismatch[] = [];
  for (const table of sourceTables) {
    const expectedColumns = currentColumns.get(table) ?? [];
    const actualTableColumns = actualColumns.get(table);
    if (!actualTableColumns) {
      mismatches.push({
        table,
        missingTable: true,
        missingColumns: expectedColumns.map((column) => column.name),
        unexpectedColumns: [],
        columnMismatches: [],
        columnOrderMismatch: false,
        expectedColumnOrder: expectedColumns.map((column) => column.name),
        actualColumnOrder: [],
        supportedHistoricalShape: false,
      });
      continue;
    }

    if (JSON.stringify(expectedColumns) === JSON.stringify(actualTableColumns)) continue;
    const expectedColumnSet = new Set(expectedColumns.map((column) => column.name));
    const actualColumnSet = new Set(actualTableColumns.map((column) => column.name));
    const missingColumns = [...expectedColumnSet].filter(
      (column) => !actualColumnSet.has(column),
    );
    const unexpectedColumns = [...actualColumnSet].filter(
      (column) => !expectedColumnSet.has(column),
    );
    mismatches.push({
      table,
      missingTable: false,
      missingColumns,
      unexpectedColumns,
      columnMismatches: sqliteColumnMismatches(expectedColumns, actualTableColumns),
      columnOrderMismatch: (
        missingColumns.length === 0
        && unexpectedColumns.length === 0
        && expectedColumns.some(
          (column, index) => actualTableColumns[index]?.name !== column.name,
        )
      ),
      expectedColumnOrder: expectedColumns.map((column) => column.name),
      actualColumnOrder: actualTableColumns.map((column) => column.name),
      supportedHistoricalShape: matchesSupportedSqliteColumnShape(
        table,
        expectedColumns,
        actualTableColumns,
      ),
    });
  }
  return mismatches;
}

function formatSqliteSchemaMismatch(mismatch: SqliteSchemaMismatch): string {
  if (mismatch.missingTable) return `${mismatch.table} (table missing)`;
  const differences = mismatch.columnMismatches
    .map(({ column, properties }) => `${column}:${properties.join('+')}`);
  if (mismatch.columnOrderMismatch) {
    differences.push(
      `column-order expected=[${mismatch.expectedColumnOrder.join(',')}] actual=[${mismatch.actualColumnOrder.join(',')}]`,
    );
  }
  return `${mismatch.table} (missing: ${mismatch.missingColumns.join(',') || 'none'}; unexpected: ${mismatch.unexpectedColumns.join(',') || 'none'}; differences: ${differences.join(',') || 'none'})`;
}

export function validateSqliteMigrationState(
  sqlite: Database.Database,
  migrationsDirectory: string,
  sourceTables = expectedImportTableNames().sourceTables,
): number {
  if (!sqliteTableExists(sqlite, '__drizzle_migrations')) {
    throw new ImportPreconditionError(
      'SQLite source is not a migrated Mission Control database: missing __drizzle_migrations.',
    );
  }
  const expected = currentSqliteMigrationEvidence(migrationsDirectory);
  const actual = (sqlite.prepare(
    'SELECT id, hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY id',
  ).all() as Array<{ id: number; hash: string; createdAt: number | null }>);
  const actualHashes = new Set(actual.map((row) => row.hash));
  const malformed = actual.filter((row) => !/^[a-f0-9]{64}$/.test(row.hash));
  if (malformed.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source migration journal contains ${malformed.length} malformed migration hash(es).`,
    );
  }
  const missing = expected.filter(
    (migration) => !migration.hashes.some((hash) => actualHashes.has(hash)),
  );
  if (missing.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source is not at the supported migration state: missing ${missing.length} current migration(s), including ${missing.slice(0, 3).map((entry) => entry.tag).join(', ')}.`,
    );
  }

  const untimestamped = actual.filter((row) => typeof row.createdAt !== 'number');
  if (untimestamped.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source migration journal contains ${untimestamped.length} untimestamped migration(s).`,
    );
  }
  const currentHashes = new Set(expected.flatMap((migration) => migration.hashes));
  const trustedHistoricalHashes = trustedRetainedMigrationHashes();
  const unrecognized = actual.filter(
    (row) => !currentHashes.has(row.hash) && !trustedHistoricalHashes.has(row.hash),
  );
  if (unrecognized.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source migration journal contains ${unrecognized.length} unrecognized migration hash(es).`,
    );
  }

  const incompatibleTables = compareSqliteImportSchema(
    sqlite,
    migrationsDirectory,
    sourceTables,
  ).filter((mismatch) => !mismatch.supportedHistoricalShape);
  if (incompatibleTables.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source schema does not match the current import schema for ${incompatibleTables.length} table(s): ${incompatibleTables.map(formatSqliteSchemaMismatch).join('; ')}.`,
    );
  }

  return actual.length;
}

function validateOpenedSqlite(
  sqlite: Database.Database,
  allowSyntheticActiveQueue: boolean,
): ImportEvidence['quiescence'] {
  let integrity: unknown;
  try {
    integrity = sqlite.prepare('PRAGMA integrity_check').pluck().get();
  } catch (error) {
    throw new ImportPreconditionError(
      `SQLite source failed PRAGMA integrity_check: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (integrity !== 'ok') {
    throw new ImportPreconditionError('SQLite source failed PRAGMA integrity_check.');
  }
  const foreignKeyRows = sqlite.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyRows.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source failed PRAGMA foreign_key_check with ${foreignKeyRows.length} violation(s).`,
    );
  }

  let activeCount = 0;
  if (sqliteTableExists(sqlite, 'sync_jobs')) {
    const rows = sqlite.prepare('SELECT status FROM sync_jobs').all() as Array<{
      status: string;
    }>;
    activeCount = rows.filter(
      (row) => !QUIESCENT_SYNC_JOB_STATUSES.has(String(row.status).toLowerCase()),
    ).length;
    if (activeCount > 0 && !allowSyntheticActiveQueue) {
      throw new ImportPreconditionError(
        `SQLite source is not quiescent: ${activeCount} sync job(s) are not terminal.`,
      );
    }
  }
  return {
    writersStoppedConfirmed: true,
    checkedWalAndRollbackJournal: true,
    checkedSidecarsBeforeOpen: true,
    activeSyncJobs: activeCount,
    acceptedForSyntheticFixture: activeCount > 0 && allowSyntheticActiveQueue,
  };
}

export function validateSourceSidecars(sourcePath: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (existsSync(`${sourcePath}${suffix}`)) {
      throw new ImportPreconditionError(
        `SQLite source is not quiescent: ${basename(sourcePath)}${suffix} exists. Checkpoint/stop writers before import.`,
      );
    }
  }
}

export function openImmutableReadonlySqlite(sourcePath: string): Database.Database {
  const sourceUri = new URL(pathToFileURL(sourcePath));
  sourceUri.searchParams.set('mode', 'ro');
  sourceUri.searchParams.set('immutable', '1');

  let sqlite: Database.Database;
  try {
    sqlite = new Database(sourceUri.href, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new ImportPreconditionError(
      'Unable to establish an immutable read-only SQLite source. '
      + 'SQLITE_USE_URI=1 must be configured before the first better-sqlite3 connection. '
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    sqlite.pragma('query_only = ON');
    const queryOnly = sqlite.pragma('query_only', { simple: true });
    const databasePath = (sqlite.pragma('database_list') as Array<{
      name: string;
      file: string;
    }>).find((database) => database.name === 'main')?.file;
    if (
      queryOnly !== 1
      || !databasePath
      || realpathSync.native(databasePath) !== realpathSync.native(sourcePath)
    ) {
      throw new ImportPreconditionError(
        'Unable to verify immutable read-only SQLite source semantics.',
      );
    }
    return sqlite;
  } catch (error) {
    sqlite.close();
    if (error instanceof ImportPreconditionError) throw error;
    throw new ImportPreconditionError(
      `Unable to verify immutable read-only SQLite source semantics: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function openValidatedSource(
  sourcePath: string,
  confirmWritersStopped: boolean,
): Pick<SourceHandle, 'sqlite' | 'sha256'> {
  if (!confirmWritersStopped) {
    throw new ImportPreconditionError(
      'Refusing to import until the operator passes --confirm-writers-stopped after stopping web and worker writers.',
    );
  }

  validateSourceSidecars(sourcePath);
  const sha256 = fileSha256(sourcePath);
  const sqlite = openImmutableReadonlySqlite(sourcePath);
  try {
    // Immutable opens never create sidecars, so this closes the check/open race without
    // confusing an importer-created artifact for source-state evidence.
    validateSourceSidecars(sourcePath);
    return { sqlite, sha256 };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function validateSourceUnchanged(source: SourceHandle): void {
  validateSourceSidecars(source.path);
  if (fileSha256(source.path) !== source.sha256) {
    throw new ImportPreconditionError(
      'SQLite source changed after pre-open validation. Keep the retained source offline and read-only for the entire import.',
    );
  }
}

function persistedFixture(id: string): PersistedStateFixture {
  const fixture = PERSISTED_STATE_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) {
    throw new ImportPreconditionError(
      `Unknown persisted-state fixture "${id}". Valid fixtures: ${PERSISTED_STATE_FIXTURES.map((candidate) => candidate.id).join(', ')}.`,
    );
  }
  return fixture;
}

function openSource(options: SqliteToPostgresImportOptions): SourceHandle {
  const sqliteMigrationsDirectory = options.sqliteMigrationsDirectory
    ?? DEFAULT_SQLITE_MIGRATIONS_DIRECTORY;
  if (options.fixtureId) {
    const fixture = persistedFixture(options.fixtureId);
    const directory = mkdtempSync(join(tmpdir(), `mc-postgres-import-${fixture.id}-`));
    const sourcePath = join(directory, fixture.fileName);
    try {
      copyFileSync(
        join(options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY, fixture.fileName),
        sourcePath,
      );
      const writable = new Database(sourcePath);
      try {
        runOrderedDatabaseBootstrap(writable, sqliteMigrationsDirectory);
      } finally {
        writable.close();
      }
      const opened = openValidatedSource(sourcePath, true);
      return {
        ...opened,
        path: sourcePath,
        label: fixture.id,
        kind: 'persisted-state-fixture',
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  if (!options.sqliteSourcePath) {
    throw new ImportPreconditionError('Pass --sqlite-source <path> or --fixture <id>.');
  }
  const sourcePath = resolve(options.sqliteSourcePath);
  const opened = openValidatedSource(sourcePath, options.confirmWritersStopped === true);
  return {
    ...opened,
    path: sourcePath,
    label: basename(sourcePath),
    kind: 'sqlite-file',
    cleanup: () => undefined,
  };
}

function assertSourceTablesExist(
  sqlite: Database.Database,
  sourceTables: readonly string[],
): void {
  const missing = sourceTables.filter((table) => !sqliteTableExists(sqlite, table));
  if (missing.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source is missing ${missing.length} required table(s): ${missing.slice(0, 10).join(', ')}.`,
    );
  }
}

function redactedTargetLabel(postgresUrl: string): string {
  let url: URL;
  try {
    url = new URL(postgresUrl);
  } catch {
    return 'invalid-postgres-url';
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || '<missing-db>';
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/${database}`;
}

function disposableTargetLooksSafe(postgresUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(postgresUrl);
  } catch {
    return false;
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (/prod(uction)?/i.test(url.hostname) || /prod(uction)?/i.test(database)) {
    return false;
  }
  return /(?:^|[-_.])(test|tests|testing|ci|dev|sandbox|local|rehearsal|fixture)(?:[-_.]|$)/i
    .test(database);
}

function poolForImport(postgresUrl: string): pg.Pool {
  const config = resolvePostgresConfig({
    ...process.env,
    MC_POSTGRES_URL: postgresUrl,
    MC_PROCESS_ROLE: 'sqlite-postgres-import',
    MC_POSTGRES_APPLICATION_NAME: process.env.MC_POSTGRES_APPLICATION_NAME
      ?? 'mission-control-sqlite-postgres-import',
  });
  return createPostgresPool({
    ...config,
    pool: {
      ...config.pool,
      statement_timeout: 0,
      idle_in_transaction_session_timeout: 0,
    },
  });
}

async function publicTableNames(pool: pg.Pool): Promise<readonly string[]> {
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
}

async function tableCounts(
  client: pg.Pool | pg.PoolClient,
  tables: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table)}`,
    );
    counts.set(table, Number(result.rows[0]?.count ?? 0));
  }
  return counts;
}

async function resetPublicSchema(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
}

export async function cleanupDisposableRehearsalTarget(pool: pg.Pool): Promise<void> {
  await resetPublicSchema(pool);
  const remaining = await publicTableNames(pool);
  if (remaining.length > 0) {
    throw new ImportInvariantError(
      `Disposable rehearsal cleanup left ${remaining.length} public table(s).`,
    );
  }
}

async function validatePostgresMigrationState(
  pool: pg.Pool,
  migrationsDirectory: string,
): Promise<void> {
  const exists = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'drizzle'
        AND table_name = '__drizzle_migrations'
    ) AS exists
  `);
  if (exists.rows[0]?.exists !== true) {
    throw new ImportPreconditionError(
      'PostgreSQL target has an existing Mission Control schema but is missing drizzle.__drizzle_migrations.',
    );
  }

  const expected = currentPostgresMigrationHashes(migrationsDirectory);
  const actual = (await pool.query<{ hash: string }>(`
    SELECT hash
    FROM drizzle.__drizzle_migrations
  `)).rows.map((row) => row.hash).sort();
  if (
    expected.length !== actual.length
    || expected.some((hash, index) => hash !== actual[index])
  ) {
    throw new ImportPreconditionError(
      `PostgreSQL target migration journal is not current: expected ${expected.length} migration(s), found ${actual.length}.`,
    );
  }
}

export async function prepareTarget(
  pool: pg.Pool,
  options: Required<Pick<SqliteToPostgresImportOptions, 'dryRun' | 'rehearsal' | 'resetDisposableRehearsalTarget'>>,
  postgresUrl: string,
  targetTables: readonly string[],
  postgresMigrationsDirectory: string,
): Promise<TargetState> {
  const existingTables = await publicTableNames(pool);
  const existingSet = new Set(existingTables);
  const targetSet = new Set(targetTables);
  const unexpected = existingTables.filter((table) => !targetSet.has(table));
  const missing = targetTables.filter((table) => !existingSet.has(table));

  if (existingTables.length === 0) {
    if (options.dryRun) {
      return { initialized: false, reset: false, emptyAttestation: 'dry-run-empty' };
    }
    await runPostgresMigrations(pool, { migrationsFolder: postgresMigrationsDirectory });
    return { initialized: true, reset: false, emptyAttestation: 'empty' };
  }

  const counts = await tableCounts(pool, existingTables);
  const nonEmpty = [...counts.entries()].filter(([, count]) => count > 0);
  const resetRequested = options.rehearsal && options.resetDisposableRehearsalTarget;
  if (resetRequested && !disposableTargetLooksSafe(postgresUrl)) {
    throw new ImportPreconditionError(
      'Refusing disposable rehearsal reset because the PostgreSQL database name is not clearly test/dev/local/rehearsal/fixture-marked.',
    );
  }
  if ((unexpected.length > 0 || nonEmpty.length > 0) && resetRequested) {
    if (options.dryRun) {
      return {
        initialized: false,
        reset: true,
        emptyAttestation: 'dry-run-would-reset',
      };
    }
    await resetPublicSchema(pool);
    await runPostgresMigrations(pool, { migrationsFolder: postgresMigrationsDirectory });
    return {
      initialized: true,
      reset: true,
      emptyAttestation: 'empty-after-disposable-reset',
    };
  }

  if (unexpected.length > 0) {
    throw new ImportPreconditionError(
      `PostgreSQL target has ${unexpected.length} unexpected public table(s); use disposable rehearsal reset only for synthetic rehearsals.`,
    );
  }
  if (missing.length > 0) {
    throw new ImportPreconditionError(
      `PostgreSQL target is missing ${missing.length} Mission Control table(s); start from an empty target or rerun schema initialization.`,
    );
  }
  if (nonEmpty.length > 0) {
    throw new ImportPreconditionError(
      `PostgreSQL target is not empty: ${nonEmpty.length} table(s) contain rows. Import will not overwrite existing data.`,
    );
  }
  await validatePostgresMigrationState(pool, postgresMigrationsDirectory);
  return { initialized: false, reset: false, emptyAttestation: 'empty-existing-schema' };
}

async function targetColumns(pool: pg.Pool): Promise<Map<string, readonly ColumnInfo[]>> {
  const result = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: 'YES' | 'NO';
    column_default: string | null;
    is_generated: 'ALWAYS' | 'NEVER';
    ordinal_position: number;
  }>(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable,
      column_default, is_generated, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const byTable = new Map<string, ColumnInfo[]>();
  for (const row of result.rows) {
    const table = byTable.get(row.table_name) ?? [];
    table.push({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      nullable: row.is_nullable === 'YES',
      hasDefault: row.column_default !== null,
      generated: row.is_generated === 'ALWAYS',
    });
    byTable.set(row.table_name, table);
  }
  return byTable;
}

async function targetForeignKeys(pool: pg.Pool): Promise<readonly ForeignKeyInfo[]> {
  const result = await pool.query<{
    table_name: string;
    columns: string[];
    referenced_table: string;
    referenced_columns: string[];
  }>(`
    SELECT
      table_class.relname AS table_name,
      array_agg(table_attribute.attname ORDER BY keys.ordinality) AS columns,
      referenced_class.relname AS referenced_table,
      array_agg(referenced_attribute.attname ORDER BY keys.ordinality) AS referenced_columns
    FROM pg_constraint constraint_row
    JOIN pg_class table_class ON table_class.oid = constraint_row.conrelid
    JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_class referenced_class ON referenced_class.oid = constraint_row.confrelid
    JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
      WITH ORDINALITY AS keys(column_number, referenced_column_number, ordinality) ON true
    JOIN pg_attribute table_attribute
      ON table_attribute.attrelid = table_class.oid
      AND table_attribute.attnum = keys.column_number
    JOIN pg_attribute referenced_attribute
      ON referenced_attribute.attrelid = referenced_class.oid
      AND referenced_attribute.attnum = keys.referenced_column_number
    WHERE constraint_row.contype = 'f'
      AND table_namespace.nspname = 'public'
    GROUP BY table_class.relname, referenced_class.relname, constraint_row.oid
    ORDER BY table_class.relname, referenced_class.relname
  `);
  return result.rows.map((row) => ({
    table: row.table_name,
    columns: row.columns,
    referencedTable: row.referenced_table,
    referencedColumns: row.referenced_columns,
  }));
}

export function dependencySafeTableOrder(
  sourceTables: readonly string[],
  foreignKeys: readonly ForeignKeyInfo[],
): readonly string[] {
  const tableSet = new Set(sourceTables);
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const table of sourceTables) {
    dependencies.set(table, new Set());
    dependents.set(table, new Set());
  }
  for (const key of foreignKeys) {
    if (
      !tableSet.has(key.table)
      || !tableSet.has(key.referencedTable)
      || key.table === key.referencedTable
    ) {
      continue;
    }
    dependencies.get(key.table)?.add(key.referencedTable);
    dependents.get(key.referencedTable)?.add(key.table);
  }

  const ready = [...sourceTables]
    .filter((table) => dependencies.get(table)?.size === 0)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift()!;
    ordered.push(table);
    for (const dependent of [...(dependents.get(table) ?? [])].sort()) {
      dependencies.get(dependent)?.delete(table);
      if (dependencies.get(dependent)?.size === 0 && !ordered.includes(dependent)) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== sourceTables.length) {
    const unresolved = sourceTables.filter((table) => !ordered.includes(table));
    throw new ImportPreconditionError(
      `PostgreSQL foreign-key topology has a cycle across import tables: ${unresolved.join(', ')}.`,
    );
  }
  return ordered;
}

function rowKey(row: Record<string, unknown>, columns: readonly string[]): string | null {
  const values = columns.map((column) => row[column]);
  if (values.some((value) => value === null || value === undefined)) return null;
  return JSON.stringify(values);
}

export function dependencySafeRows(
  rows: readonly Record<string, unknown>[],
  selfForeignKeys: readonly ForeignKeyInfo[],
): readonly Record<string, unknown>[] {
  if (rows.length <= 1 || selfForeignKeys.length === 0) return rows;
  const rowsByKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    for (const key of selfForeignKeys) {
      const ownKey = rowKey(row, key.referencedColumns);
      if (ownKey) rowsByKey.set(ownKey, row);
    }
  }
  const dependencies = new Map<Record<string, unknown>, Set<Record<string, unknown>>>();
  const dependents = new Map<Record<string, unknown>, Set<Record<string, unknown>>>();
  for (const row of rows) {
    dependencies.set(row, new Set());
    dependents.set(row, new Set());
  }
  for (const row of rows) {
    for (const key of selfForeignKeys) {
      const dependencyKey = rowKey(row, key.columns);
      if (!dependencyKey) continue;
      const parent = rowsByKey.get(dependencyKey);
      if (parent && parent !== row) {
        dependencies.get(row)?.add(parent);
        dependents.get(parent)?.add(row);
      }
    }
  }

  const ready = rows.filter((row) => dependencies.get(row)?.size === 0);
  const ordered: Record<string, unknown>[] = [];
  while (ready.length > 0) {
    const row = ready.shift()!;
    ordered.push(row);
    for (const dependent of dependents.get(row) ?? []) {
      dependencies.get(dependent)?.delete(row);
      if (dependencies.get(dependent)?.size === 0 && !ordered.includes(dependent)) {
        ready.push(dependent);
      }
    }
  }
  if (ordered.length !== rows.length) {
    throw new ImportPreconditionError(
      'A self-referential table contains a cycle that cannot be imported with immediate foreign-key checks.',
    );
  }
  return ordered;
}

export function convertSqliteValueForPostgres(
  value: unknown,
  column: ColumnInfo,
  table = '<unknown>',
): unknown {
  if (value === null || value === undefined) return null;
  if (column.dataType === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      if (value === '1' || value.toLowerCase() === 'true') return true;
      if (value === '0' || value.toLowerCase() === 'false') return false;
    }
    throw new ImportPreconditionError(
      `SQLite import value is incompatible with PostgreSQL at ${table}.${column.name} (invalid-boolean).`,
    );
  }
  if (column.dataType === 'json' || column.dataType === 'jsonb') {
    const category = jsonCompatibilityCategory(value);
    if (category) {
      throw new ImportValueCompatibilityError(table, column.name, category);
    }
    // node-postgres sends strings verbatim for json/jsonb parameters. Keeping the validated
    // serialized form preserves JSON string scalars and JSON null instead of changing semantics.
    return value;
  }
  return value;
}

function stringHasUnsupportedJsonbUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return true;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function jsonbTokenCompatibilityCategory(
  serialized: string,
): JsonCompatibilityCategory | null {
  let depth = 0;
  let stringStart = -1;
  let escaped = false;
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (stringStart >= 0) {
      if (character === '\0') return 'unsupported-unicode';
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        const token = serialized.slice(stringStart, index + 1);
        let decoded: unknown;
        try {
          decoded = JSON.parse(token) as unknown;
        } catch {
          decoded = null;
        }
        if (typeof decoded === 'string') {
          if (stringHasUnsupportedJsonbUnicode(decoded)) return 'unsupported-unicode';
        }
        stringStart = -1;
      }
      continue;
    }
    if (character === '"') {
      stringStart = index;
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > JSON_MAX_NESTING_DEPTH) return 'excessive-nesting';
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }
  return null;
}

function jsonCompatibilityCategory(value: unknown): JsonCompatibilityCategory | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return 'unsupported-storage-type';
  const tokenCategory = jsonbTokenCompatibilityCategory(value);
  if (tokenCategory) return tokenCategory;
  try {
    JSON.parse(value);
  } catch {
    return 'invalid-json';
  }
  return null;
}

export function preflightJsonCompatibility(
  sqlite: Database.Database,
  targetColumns = expectedJsonTargetColumns(),
): JsonPreflightReport {
  const columnsByTable = new Map<string, string[]>();
  for (const target of targetColumns) {
    const columns = columnsByTable.get(target.table) ?? [];
    columns.push(target.column);
    columnsByTable.set(target.table, columns);
  }

  const issueCounts = new Map<string, JsonCompatibilityIssue>();
  let rowsScanned = 0;
  let batchesScanned = 0;
  for (const [table, columns] of columnsByTable) {
    const selections = columns.flatMap((column, index) => [
      `${quoteIdentifier(column)} AS ${quoteIdentifier(`__json_value_${index}`)}`,
      `CAST(${quoteIdentifier(column)} AS BLOB) AS ${quoteIdentifier(`__json_raw_${index}`)}`,
    ]);
    const statement = sqlite.prepare(
      `SELECT ${selections.join(', ')} FROM ${quoteIdentifier(table)}`,
    );
    let tableRows = 0;
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      tableRows += 1;
      rowsScanned += 1;
      if ((tableRows - 1) % JSON_PREFLIGHT_BATCH_SIZE === 0) batchesScanned += 1;
      for (const [columnIndex, column] of columns.entries()) {
        const value = row[`__json_value_${columnIndex}`];
        const raw = row[`__json_raw_${columnIndex}`];
        let category: JsonCompatibilityCategory | null;
        if (typeof value === 'string') {
          try {
            const decoded = JSON_UTF8_DECODER.decode(raw as Uint8Array);
            category = decoded === value ? jsonCompatibilityCategory(value) : 'invalid-utf8';
          } catch {
            category = 'invalid-utf8';
          }
        } else {
          category = jsonCompatibilityCategory(value);
        }
        if (!category) continue;
        const key = `${table}\0${column}\0${category}`;
        const existing = issueCounts.get(key);
        issueCounts.set(key, {
          table,
          column,
          category,
          count: (existing?.count ?? 0) + 1,
        });
      }
    }
  }

  const issues = [...issueCounts.values()].sort((left, right) => (
    left.table.localeCompare(right.table)
    || left.column.localeCompare(right.column)
    || left.category.localeCompare(right.category)
  ));
  return { targetColumns, rowsScanned, batchesScanned, issues };
}

function assertJsonPreflightCompatible(report: JsonPreflightReport): void {
  if (report.issues.length === 0) return;
  throw new ImportPreconditionError(
    `SQLite source has incompatible JSON for ${report.issues.length} table/column/category group(s): ${
      report.issues.map((issue) => (
        `${issue.table}.${issue.column}:${issue.category}=${issue.count}`
      )).join('; ')
    }.`,
  );
}

function selectRows(
  sqlite: Database.Database,
  table: string,
  columns: readonly string[],
): readonly Record<string, unknown>[] {
  if (columns.length === 0) return [];
  const sql = `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`;
  return sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
}

async function copyTableRows(
  client: pg.PoolClient,
  sqlite: Database.Database,
  table: string,
  columns: readonly ColumnInfo[],
  selfForeignKeys: readonly ForeignKeyInfo[],
): Promise<number> {
  const sourceColumnSet = new Set(sqliteWritableColumnNames(sqlite, table));
  const importColumns = columns.filter(
    (column) => !column.generated && sourceColumnSet.has(column.name),
  );
  const requiredMissing = columns.filter(
    (column) => !column.generated
      && !column.nullable
      && !column.hasDefault
      && !sourceColumnSet.has(column.name),
  );
  if (requiredMissing.length > 0) {
    throw new ImportPreconditionError(
      `SQLite source is missing required PostgreSQL column(s) for ${table}: ${requiredMissing.map((column) => column.name).join(', ')}.`,
    );
  }

  const jsonTargets = importColumns
    .filter((column) => column.dataType === 'json' || column.dataType === 'jsonb')
    .map((column) => ({ table, column: column.name }));
  if (jsonTargets.length > 0) {
    assertJsonPreflightCompatible(preflightJsonCompatibility(sqlite, jsonTargets));
  }

  const rows = dependencySafeRows(
    selectRows(sqlite, table, importColumns.map((column) => column.name)),
    selfForeignKeys,
  );
  if (rows.length === 0) return 0;

  const batchSize = 250;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const jsonValues: Array<{ readonly column: string; readonly value: unknown }> = [];
    const placeholders = batch.map((row, rowIndex) => {
      const rowPlaceholders = importColumns.map((column, columnIndex) => {
        const value = convertSqliteValueForPostgres(row[column.name], column, table);
        values.push(value);
        if (column.dataType === 'json' || column.dataType === 'jsonb') {
          jsonValues.push({ column: column.name, value });
        }
        const parameter = `$${rowIndex * importColumns.length + columnIndex + 1}`;
        return column.dataType === 'json' || column.dataType === 'jsonb'
          ? `${parameter}::jsonb`
          : parameter;
      });
      return `(${rowPlaceholders.join(', ')})`;
    });
    await validateJsonbBatchWithTarget(client, table, jsonValues);
    await client.query(
      `INSERT INTO ${quoteIdentifier(table)} (${importColumns.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
  return rows.length;
}

async function validateJsonbBatchWithTarget(
  client: pg.PoolClient,
  table: string,
  jsonValues: readonly { readonly column: string; readonly value: unknown }[],
): Promise<void> {
  if (jsonValues.length === 0) return;
  await client.query('SAVEPOINT validate_jsonb_batch');
  try {
    await client.query(
      `SELECT COUNT(value::jsonb)::text AS validated_count FROM (VALUES ${
        jsonValues.map((_, index) => `($${index + 1}::text)`).join(', ')
      }) AS source(value)`,
      jsonValues.map(({ value }) => value),
    );
    await client.query('RELEASE SAVEPOINT validate_jsonb_batch');
    return;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT validate_jsonb_batch');
  }

  for (const candidate of jsonValues) {
    await client.query('SAVEPOINT validate_jsonb_value');
    try {
      await client.query('SELECT COUNT($1::jsonb)::text AS validated_count', [candidate.value]);
      await client.query('RELEASE SAVEPOINT validate_jsonb_value');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT validate_jsonb_value');
      throw new ImportValueCompatibilityError(
        table,
        candidate.column,
        'target-jsonb-rejected',
      );
    }
  }
  throw new ImportPreconditionError(
    `PostgreSQL rejected a JSON validation batch for ${table} (target-jsonb-rejected).`,
  );
}

async function sequenceInfos(client: pg.PoolClient): Promise<readonly SequenceInfo[]> {
  const result = await client.query<{
    table_name: string;
    column_name: string;
    sequence_name: string | null;
  }>(`
    SELECT table_name, column_name,
      pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS sequence_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE 'nextval(%'
    ORDER BY table_name, column_name
  `);
  return result.rows
    .filter((row): row is { table_name: string; column_name: string; sequence_name: string } => (
      row.sequence_name !== null
    ))
    .map((row) => ({
      table: row.table_name,
      column: row.column_name,
      sequenceName: row.sequence_name,
    }));
}

async function repairSequences(client: pg.PoolClient): Promise<void> {
  for (const sequence of await sequenceInfos(client)) {
    await client.query(
      `
        SELECT setval(
          $1::regclass,
          COALESCE((SELECT MAX(${quoteIdentifier(sequence.column)})::bigint FROM ${quoteIdentifier(sequence.table)}), 1),
          EXISTS (SELECT 1 FROM ${quoteIdentifier(sequence.table)})
        )
      `,
      [sequence.sequenceName],
    );
  }
}

export async function copyAllTables(
  pool: pg.Pool,
  sqlite: Database.Database,
  orderedTables: readonly string[],
  columnsByTable: Map<string, readonly ColumnInfo[]>,
  foreignKeys: readonly ForeignKeyInfo[],
  validateSource: () => void,
): Promise<readonly ImportTableCount[]> {
  const client = await pool.connect();
  const counts: ImportTableCount[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    for (const table of orderedTables) {
      const columns = columnsByTable.get(table);
      if (!columns) {
        throw new ImportPreconditionError(`PostgreSQL target is missing table ${table}.`);
      }
      const copied = await copyTableRows(
        client,
        sqlite,
        table,
        columns,
        foreignKeys.filter((key) => key.table === table && key.referencedTable === table),
      );
      counts.push({ table, sourceRows: copied, targetRows: copied });
    }
    await repairSequences(client);
    validateSource();
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'SQLite-to-PostgreSQL import and rollback both failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }

  const search = new PostgresKeywordSearchRepository(pool);
  await search.rebuild();
  return counts;
}

async function sourceCounts(
  sqlite: Database.Database,
  tables: readonly string[],
): Promise<readonly ImportTableCount[]> {
  return tables.map((table) => ({ table, sourceRows: sqliteCount(sqlite, table) }));
}

async function invariantReport(
  pool: pg.Pool,
  copiedTables: readonly ImportTableCount[],
): Promise<ImportInvariantReport> {
  const targetCounts = await tableCounts(pool, copiedTables.map((count) => count.table));
  const copiedCounts = copiedTables.map((count) => ({
    table: count.table,
    sourceRows: count.sourceRows,
    targetRows: targetCounts.get(count.table) ?? 0,
  }));
  const countByTable = new Map(copiedCounts.map((count) => [count.table, count]));

  const scalar = async (sql: string): Promise<number> => {
    const result = await pool.query<{ count: string }>(sql);
    return Number(result.rows[0]?.count ?? 0);
  };

  const report: ImportInvariantReport = {
    allCopiedTableCountsMatch: copiedCounts.every(
      (count) => count.sourceRows === count.targetRows,
    ),
    representativeCounts: REPRESENTATIVE_TABLES
      .filter((table) => countByTable.has(table))
      .map((table) => countByTable.get(table)!),
    taskSearchDocuments: await scalar('SELECT COUNT(*)::text AS count FROM task_search_documents'),
    notificationSearchDocuments: await scalar('SELECT COUNT(*)::text AS count FROM notification_search_documents'),
    orphanTaskProjects: await scalar(`
      SELECT COUNT(*)::text AS count
      FROM task_projects tp
      LEFT JOIN tasks t ON t.id = tp.task_id
      LEFT JOIN hub_projects p ON p.id = tp.project_id
      WHERE t.id IS NULL OR p.id IS NULL
    `),
    orphanTaskDependencies: await scalar(`
      SELECT COUNT(*)::text AS count
      FROM task_dependencies d
      LEFT JOIN tasks task ON task.id = d.task_id
      LEFT JOIN tasks depends ON depends.id = d.depends_on_task_id
      WHERE task.id IS NULL OR depends.id IS NULL
    `),
    orphanSyncJobEvents: await scalar(`
      SELECT COUNT(*)::text AS count
      FROM sync_job_events e
      LEFT JOIN sync_jobs j ON j.id = e.job_id
      WHERE j.id IS NULL
    `),
    orphanNotificationTasks: await scalar(`
      SELECT COUNT(*)::text AS count
      FROM notifications n
      LEFT JOIN tasks t ON t.id = n.related_task_id
      WHERE n.related_task_id IS NOT NULL AND t.id IS NULL
    `),
  };
  const tasks = countByTable.get('tasks')?.targetRows ?? 0;
  const notifications = countByTable.get('notifications')?.targetRows ?? 0;
  if (
    !report.allCopiedTableCountsMatch
    || report.taskSearchDocuments !== tasks
    || report.notificationSearchDocuments !== notifications
    || report.orphanTaskProjects !== 0
    || report.orphanTaskDependencies !== 0
    || report.orphanSyncJobEvents !== 0
    || report.orphanNotificationTasks !== 0
  ) {
    throw new ImportInvariantError('PostgreSQL import completed but invariant checks failed.');
  }
  return report;
}

function buildEvidence(input: {
  readonly dryRun: boolean;
  readonly rehearsal: boolean;
  readonly resetDisposableRehearsalTarget: boolean;
  readonly source: SourceHandle;
  readonly sourceIdentity: string;
  readonly sourceSha256: string;
  readonly sqliteMigrationCount: number;
  readonly sourceTables: readonly string[];
  readonly targetTables: readonly string[];
  readonly quiescence: ImportEvidence['quiescence'];
  readonly target: ImportEvidence['target'];
  readonly copiedTables: readonly ImportTableCount[];
  readonly jsonPreflight: JsonPreflightReport;
  readonly invariants?: ImportInvariantReport;
}): ImportEvidence {
  const taskCount = input.copiedTables.find((count) => count.table === 'tasks')?.sourceRows ?? 0;
  const notificationCount = input.copiedTables.find((count) => count.table === 'notifications')?.sourceRows ?? 0;
  const ready = !input.dryRun
    && input.invariants !== undefined
    && input.invariants.allCopiedTableCountsMatch
    && input.invariants.taskSearchDocuments === taskCount
    && input.invariants.notificationSearchDocuments === notificationCount
    && input.invariants.orphanTaskProjects === 0
    && input.invariants.orphanTaskDependencies === 0
    && input.invariants.orphanSyncJobEvents === 0
    && input.invariants.orphanNotificationTasks === 0;

  return {
    command: {
      mode: input.dryRun ? 'dry-run' : 'import',
      rehearsal: input.rehearsal,
      resetDisposableRehearsalTarget: input.resetDisposableRehearsalTarget,
      activationChanged: false,
    },
    source: {
      kind: input.source.kind,
      label: input.source.label,
      identity: input.sourceIdentity,
      sha256: input.sourceSha256,
      retainedArtifact: input.source.kind === 'sqlite-file',
      walOrJournalPresent: false,
      sidecarsPresent: false,
      openedReadOnly: true,
      immutable: true,
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
    },
    target: input.target,
    schema: {
      sqliteMigrationCount: input.sqliteMigrationCount,
      importTableCount: input.sourceTables.length,
      targetTableCount: input.targetTables.length,
      jsonTargetColumnCount: input.jsonPreflight.targetColumns.length,
      jsonRowsScanned: input.jsonPreflight.rowsScanned,
    },
    quiescence: input.quiescence,
    derivedState: {
      droppedFromImport: [
        'sqlite_fts_virtual_tables',
        'postgres_generated_search_vector_columns',
        'postgres_keyword_search_projection_rows',
      ],
      rebuilt: ['task_search_documents', 'notification_search_documents'],
      semanticVectorCheck: 'not-applicable-to-relational-import',
    },
    workerReadinessHooks: {
      queueRowsCopied: input.copiedTables.find((count) => count.table === 'sync_jobs')?.sourceRows ?? 0,
      smokeAfterActivationRequired: true,
    },
    rollback: {
      sqliteSourceRetained: input.source.kind === 'sqlite-file',
      activationGateRequired: true,
      cleanupRequiredOnFailure: input.target.resetDisposableTarget
        ? 'drop disposable rehearsal database/schema'
        : 'discard the failed PostgreSQL target and keep the retained SQLite artifact active',
    },
    observability: {
      logsSecretSafe: true,
      recommendedSignals: [
        'application startup readiness after explicit activation',
        'sync worker lease recovery after explicit activation',
        'PostgreSQL pool errors and slow query logs',
        'search query smoke checks for imported task and notification terms',
      ],
    },
    verdict: {
      ready_for_cutover_planning: ready,
      reason: ready
        ? 'import completed, counts and representative invariants passed, search projections rebuilt, and activation was not changed'
        : input.dryRun
          ? 'dry-run only; execute against an empty PostgreSQL target for cutover planning evidence'
          : 'import did not produce a complete invariant report',
    },
  };
}

export async function runSqliteToPostgresImport(
  rawOptions: SqliteToPostgresImportOptions,
): Promise<SqliteToPostgresImportResult> {
  const logger = rawOptions.logger ?? noopLogger();
  const dryRun = rawOptions.dryRun === true;
  const rehearsal = rawOptions.rehearsal === true || rawOptions.fixtureId !== undefined;
  const resetDisposableRehearsalTarget = rawOptions.resetDisposableRehearsalTarget === true;
  const postgresMigrationsDirectory = rawOptions.postgresMigrationsDirectory
    ?? DEFAULT_POSTGRES_MIGRATIONS_DIRECTORY;
  const source = openSource(rawOptions);
  const sourceSha256 = source.sha256;
  const sourceIdentity = `${source.kind}:${source.label}`;
  let pool: pg.Pool | null = null;
  let disposableTargetTouched = false;
  let evidenceTarget: ImportEvidence['target'] = {
    identity: 'not-provided',
    initializedSchema: false,
    resetDisposableTarget: false,
    emptyAttestation: 'not-checked',
  };
  try {
    const { sourceTables, targetTables } = expectedImportTableNames();
    const sqliteMigrationCount = validateSqliteMigrationState(
      source.sqlite,
      rawOptions.sqliteMigrationsDirectory ?? DEFAULT_SQLITE_MIGRATIONS_DIRECTORY,
      sourceTables,
    );
    const quiescence = validateOpenedSqlite(
      source.sqlite,
      source.kind === 'persisted-state-fixture',
    );
    assertSourceTablesExist(source.sqlite, sourceTables);
    const jsonPreflight = preflightJsonCompatibility(source.sqlite);
    assertJsonPreflightCompatible(jsonPreflight);

    logger.info('source-ready', {
      source: source.label,
      sourceKind: source.kind,
      requiredTables: sourceTables.length,
      jsonTargetColumns: jsonPreflight.targetColumns.length,
      jsonRowsScanned: jsonPreflight.rowsScanned,
      jsonBatchesScanned: jsonPreflight.batchesScanned,
    });

    const plannedCounts = await sourceCounts(source.sqlite, sourceTables);
    const postgresUrl = rawOptions.postgresUrl
      ?? process.env.MC_POSTGRES_IMPORT_URL
      ?? process.env.MC_POSTGRES_URL;
    if (!postgresUrl) {
      if (!dryRun) {
        throw new ImportPreconditionError(
          'Pass --postgres-url <url> or set MC_POSTGRES_IMPORT_URL for a real import.',
        );
      }
      logger.info('dry-run-without-target', {
        copiedTables: plannedCounts.length,
        sourceRows: plannedCounts.reduce((sum, count) => sum + count.sourceRows, 0),
      });
      validateSourceUnchanged(source);
      const evidence = buildEvidence({
        dryRun,
        rehearsal,
        resetDisposableRehearsalTarget,
        source,
        sourceIdentity,
        sourceSha256,
        sqliteMigrationCount,
        sourceTables,
        targetTables,
        quiescence,
        target: evidenceTarget,
        copiedTables: plannedCounts,
        jsonPreflight,
      });
      return {
        dryRun,
        rehearsal,
        sourceKind: source.kind,
        sourceLabel: source.label,
        copiedTables: plannedCounts,
        initializedTarget: false,
        resetDisposableTarget: false,
        evidence,
      };
    }

    if (
      resetDisposableRehearsalTarget
      && rehearsal
      && !disposableTargetLooksSafe(postgresUrl)
    ) {
      throw new ImportPreconditionError(
        'Refusing disposable rehearsal reset because the PostgreSQL database name is not clearly test/dev/local/rehearsal/fixture-marked.',
      );
    }
    pool = poolForImport(postgresUrl);
    disposableTargetTouched = resetDisposableRehearsalTarget && rehearsal && !dryRun;
    logger.info('target-connect', { target: redactedTargetLabel(postgresUrl) });
    const targetState = await prepareTarget(
      pool,
      { dryRun, rehearsal, resetDisposableRehearsalTarget },
      postgresUrl,
      targetTables,
      postgresMigrationsDirectory,
    );
    evidenceTarget = {
      identity: redactedTargetLabel(postgresUrl),
      initializedSchema: targetState.initialized,
      resetDisposableTarget: targetState.reset,
      emptyAttestation: targetState.emptyAttestation,
    };
    const foreignKeys = dryRun && !targetState.initialized && (await publicTableNames(pool)).length === 0
      ? []
      : await targetForeignKeys(pool);
    const orderedTables = dryRun && foreignKeys.length === 0
      ? sourceTables
      : dependencySafeTableOrder(sourceTables, foreignKeys);

    if (dryRun) {
      logger.info('dry-run-plan', {
        target: redactedTargetLabel(postgresUrl),
        sourceTables: sourceTables.length,
        plannedRows: plannedCounts.reduce((sum, count) => sum + count.sourceRows, 0),
        wouldInitializeTarget: !targetState.initialized,
        wouldResetDisposableTarget: targetState.reset,
      });
      validateSourceUnchanged(source);
      const evidence = buildEvidence({
        dryRun,
        rehearsal,
        resetDisposableRehearsalTarget,
        source,
        sourceIdentity,
        sourceSha256,
        sqliteMigrationCount,
        sourceTables,
        targetTables,
        quiescence,
        target: evidenceTarget,
        copiedTables: plannedCounts,
        jsonPreflight,
      });
      return {
        dryRun,
        rehearsal,
        sourceKind: source.kind,
        sourceLabel: source.label,
        copiedTables: plannedCounts,
        initializedTarget: targetState.initialized,
        resetDisposableTarget: targetState.reset,
        evidence,
      };
    }

    const columnsByTable = await targetColumns(pool);
    const copiedTables = await copyAllTables(
      pool,
      source.sqlite,
      orderedTables,
      columnsByTable,
      foreignKeys,
      () => validateSourceUnchanged(source),
    );
    const invariants = await invariantReport(pool, copiedTables);
    validateSourceUnchanged(source);
    const evidence = buildEvidence({
      dryRun,
      rehearsal,
      resetDisposableRehearsalTarget,
      source,
      sourceIdentity,
      sourceSha256,
      sqliteMigrationCount,
      sourceTables,
      targetTables,
      quiescence,
      target: evidenceTarget,
      copiedTables,
      jsonPreflight,
      invariants,
    });
    logger.info('import-complete', {
      copiedTables: copiedTables.length,
      copiedRows: copiedTables.reduce((sum, count) => sum + count.sourceRows, 0),
      taskSearchDocuments: invariants.taskSearchDocuments,
      notificationSearchDocuments: invariants.notificationSearchDocuments,
      ready_for_cutover_planning: evidence.verdict.ready_for_cutover_planning,
    });

    return {
      dryRun,
      rehearsal,
      sourceKind: source.kind,
      sourceLabel: source.label,
      copiedTables,
      initializedTarget: targetState.initialized,
      resetDisposableTarget: targetState.reset,
      evidence,
      invariants,
    };
  } catch (error) {
    if (pool && disposableTargetTouched && !dryRun) {
      try {
        await cleanupDisposableRehearsalTarget(pool);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'SQLite-to-PostgreSQL import failed and disposable rehearsal cleanup could not be verified',
        );
      }
    }
    throw error;
  } finally {
    source.sqlite.close();
    source.cleanup();
    await pool?.end();
  }
}

export { Pool };
