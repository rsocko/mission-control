import { describe, expect, it, vi } from 'vitest';
import {
  convertSqliteValueForPostgres,
  dependencySafeRows,
  dependencySafeTableOrder,
  expectedImportTableNames,
  runSqliteToPostgresImport,
} from '../../scripts/lib/sqlite-to-postgres-import';
import { ImportPreconditionError } from '../../scripts/lib/sqlite-to-postgres-import';
import { parseArgs } from '../../scripts/sqlite-to-postgres-import';

describe('SQLite-to-PostgreSQL import tooling', () => {
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
});
