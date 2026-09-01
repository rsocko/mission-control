import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import { generatePersistedStateFixtures } from '../../scripts/generate-persisted-state-fixtures';
import {
  PERSISTED_STATE_FIXTURES,
  PERSISTED_STATE_FIXTURE_VERSION,
  type PersistedStateFixture,
} from '../../scripts/persisted-state-fixture-manifest';

interface MigrationJournalEntry {
  readonly tag: string;
}

const REPOSITORY_ROOT = process.cwd();
const MIGRATIONS_DIRECTORY = resolve(REPOSITORY_ROOT, 'drizzle');
const FIXTURES_DIRECTORY = resolve(
  REPOSITORY_ROOT,
  'tests',
  'fixtures',
  'persisted-state',
  'sqlite',
);
const temporaryDirectories: string[] = [];

function currentMigrationHashes(): string[] {
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS_DIRECTORY, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: MigrationJournalEntry[] };
  return journal.entries.map((entry) => createHash('sha256')
    .update(
      readFileSync(resolve(MIGRATIONS_DIRECTORY, `${entry.tag}.sql`), 'utf8')
        .replace(/\r\n?/g, '\n'),
    )
    .digest('hex'));
}

function canonicalDatabaseState(databasePath: string): {
  readonly schemaObjects: readonly object[];
  readonly tableRows: readonly object[];
} {
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    const schemaObjects = sqlite.prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all() as Array<{
      type: string;
      name: string;
      tableName: string;
      sql: string | null;
    }>;
    const tableRows = schemaObjects
      .filter((object) => (
        object.type === 'table'
        && !/^(tasks|alerts)_fts_(config|content|data|docsize|idx)$/.test(object.name)
      ))
      .map((object) => {
        const rows = sqlite.prepare(
          `SELECT * FROM "${object.name.replaceAll('"', '""')}"`,
        ).all().map((row) => JSON.stringify(row, (_key, value) => (
          Buffer.isBuffer(value) ? value.toString('hex') : value
        ))).sort();
        return { table: object.name, rows };
      });
    return { schemaObjects, tableRows };
  } finally {
    sqlite.close();
  }
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  return sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
}

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
  }>).map((row) => row.name);
}

function openFixtureCopy(fixture: PersistedStateFixture): {
  readonly sqlite: Database.Database;
  readonly directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), `mc-${fixture.id}-`));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, fixture.fileName);
  copyFileSync(resolve(FIXTURES_DIRECTORY, fixture.fileName), databasePath);
  return { sqlite: new Database(databasePath), directory };
}

function assertCurrentMigrationState(sqlite: Database.Database): void {
  const expected = new Set(currentMigrationHashes());
  const actual = (sqlite.prepare(
    'SELECT hash FROM __drizzle_migrations',
  ).all() as Array<{ hash: string }>).map((row) => row.hash);
  expect(actual.filter((hash) => expected.has(hash))).toHaveLength(expected.size);
}

function assertCoreInvariants(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  expect(sqlite.prepare(`
    SELECT title, status, priority, local_disposition AS localDisposition,
      push_count AS pushCount, last_synced_at AS lastSyncedAt
    FROM tasks WHERE id = ?
  `).get(fixture.taskId)).toEqual({
    title: `Synthetic ${fixture.searchToken} task`,
    status: 'in_progress',
    priority: 'high',
    localDisposition: 'active',
    pushCount: 0,
    lastSyncedAt: '2026-01-15T12:00:00.000Z',
  });
  expect(sqlite.prepare(`
    SELECT p.name, tp.task_id AS taskId
    FROM hub_projects p
    INNER JOIN task_projects tp ON tp.project_id = p.id
    WHERE p.id = ?
  `).get(fixture.projectId)).toEqual({
    name: `Synthetic project ${fixture.checkpointTag}`,
    taskId: fixture.taskId,
  });
  expect(sqlite.prepare(`
    SELECT credentials, settings, deleted_at AS deletedAt
    FROM connector_configs WHERE id = ?
  `).get(fixture.connectorId)).toEqual({
    credentials: '{}',
    settings: JSON.stringify({
      fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION,
      origin: fixture.checkpointTag,
    }),
    deletedAt: null,
  });
  expect(sqlite.prepare(`
    SELECT success, tasks_added AS tasksAdded, tasks_updated AS tasksUpdated,
      tasks_pushed AS tasksPushed
    FROM sync_log WHERE id = ?
  `).get(fixture.syncLogId)).toEqual({
    success: 1,
    tasksAdded: 1,
    tasksUpdated: 2,
    tasksPushed: 0,
  });
  expect(JSON.parse((sqlite.prepare(
    'SELECT value FROM app_settings WHERE key = ?',
  ).pluck().get(fixture.settingKey) as string))).toEqual({
    fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION,
    origin: fixture.checkpointTag,
  });
  expect(columnNames(sqlite, 'tasks')).toEqual(expect.arrayContaining([
    'local_disposition',
    'planning_horizon',
    'reminder_relative',
    'recurrence_generated_from_task_id',
  ]));
  expect(columnNames(sqlite, 'triage_sync_state')).toContain('revision');
  expect(sqlite.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

function assertNotificationAndQueueInvariants(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  if (!fixture.notificationId || !fixture.syncJobId) {
    expect(sqlite.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) FROM sync_jobs').pluck().get()).toBe(0);
    return;
  }
  expect(sqlite.prepare(`
    SELECT title, level, read_state AS readState, disposition, related_task_id AS relatedTaskId
    FROM notifications WHERE id = ?
  `).get(fixture.notificationId)).toEqual({
    title: `Synthetic ${fixture.searchToken} notification`,
    level: 'attention',
    readState: 'unread',
    disposition: 'inbox',
    relatedTaskId: fixture.taskId,
  });
  expect(sqlite.prepare(`
    SELECT j.status, j.attempt, e.event_type AS eventType, e.payload
    FROM sync_jobs j
    INNER JOIN sync_job_events e ON e.job_id = j.id
    WHERE j.id = ?
  `).get(fixture.syncJobId)).toEqual({
    status: 'queued',
    attempt: 1,
    eventType: 'queued',
    payload: JSON.stringify({ fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION }),
  });
}

function assertNodeIdCutoverInvariants(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  if (!fixture.includesPreNodeIdCutoverState) return;
  expect(tableExists(sqlite, 'github_identity_comparison_runs')).toBe(false);
  expect(tableExists(sqlite, 'github_identity_comparison_records')).toBe(false);
  expect(tableExists(sqlite, 'github_identity_sub_issue_population_members')).toBe(false);
  expect(columnNames(sqlite, 'task_source_write_leases')).not.toContain('comparison_run_id');
  expect(sqlite.prepare(`
    SELECT state, cycle_outcome AS cycleOutcome, mode_revision AS modeRevision
    FROM task_source_write_leases WHERE id = 'fixture-write-lease-0104'
  `).get()).toEqual({
    state: 'succeeded',
    cycleOutcome: 'succeeded',
    modeRevision: 7,
  });
  expect(sqlite.prepare(`
    SELECT applied_count AS appliedCount, state
    FROM github_identity_write_cycles WHERE id = 'fixture-write-cycle-0104'
  `).get()).toEqual({ appliedCount: 1, state: 'completed' });
}

async function assertSearchInvariants(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): Promise<void> {
  vi.resetModules();
  vi.doMock('@/db', () => ({
    default: drizzle(sqlite),
    sqlite,
  }));
  try {
    const { sqliteKeywordSearchRepository } = await import(
      '@/lib/search/sqlite-fts-repository'
    );
    await sqliteKeywordSearchRepository.rebuild();
    const results = await sqliteKeywordSearchRepository.search(fixture.searchToken);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task', id: fixture.taskId }),
    ]));
    if (fixture.notificationId) {
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'notification', id: fixture.notificationId }),
      ]));
    }
  } finally {
    vi.doUnmock('@/db');
    vi.resetModules();
  }
}

async function assertCompatibleFixture(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): Promise<void> {
  runOrderedDatabaseBootstrap(sqlite, MIGRATIONS_DIRECTORY);
  assertCurrentMigrationState(sqlite);
  assertCoreInvariants(sqlite, fixture);
  assertNotificationAndQueueInvariants(sqlite, fixture);
  assertNodeIdCutoverInvariants(sqlite, fixture);
  await assertSearchInvariants(sqlite, fixture);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('persisted-state compatibility fixtures', () => {
  for (const fixture of PERSISTED_STATE_FIXTURES) {
    it(
      `upgrades ${fixture.checkpointTag} and preserves representative state`,
      async () => {
        const { sqlite } = openFixtureCopy(fixture);
        try {
          await assertCompatibleFixture(sqlite, fixture);
          expect(sqlite.prepare(
            'SELECT COUNT(*) FROM __drizzle_migrations',
          ).pluck().get()).toBe(
            currentMigrationHashes().length + (fixture.retainedHistoricalMigrationRows ?? 0),
          );
        } finally {
          sqlite.close();
        }
      },
      20_000,
    );
  }

  it(
    'rejects a persisted shape that prevents the migration chain from completing',
    async () => {
      const fixture = PERSISTED_STATE_FIXTURES[2];
      const { sqlite } = openFixtureCopy(fixture);
      try {
        sqlite.exec(`
          CREATE VIEW __new_task_source_write_leases AS
          SELECT 'incompatible' AS id
        `);
        await expect(assertCompatibleFixture(sqlite, fixture)).rejects.toThrow();
        expect(() => assertCurrentMigrationState(sqlite)).toThrow();
      } finally {
        sqlite.close();
      }
    },
    20_000,
  );

  it(
    'regenerates logically identical synthetic fixture artifacts',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'mc-regenerated-fixtures-'));
      temporaryDirectories.push(directory);
      generatePersistedStateFixtures(directory);
      for (const fixture of PERSISTED_STATE_FIXTURES) {
        expect(
          canonicalDatabaseState(resolve(directory, fixture.fileName)),
          fixture.id,
        ).toEqual(
          canonicalDatabaseState(resolve(FIXTURES_DIRECTORY, fixture.fileName)),
        );
      }
    },
    20_000,
  );

  it('refuses to replace an output directory containing unrelated files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mc-fixture-output-safety-'));
    temporaryDirectories.push(directory);
    const unrelatedFile = join(directory, 'keep.txt');
    writeFileSync(unrelatedFile, 'unrelated content');

    expect(() => generatePersistedStateFixtures(directory)).toThrow(
      /Refusing to replace non-corpus output directory/,
    );
    expect(readFileSync(unrelatedFile, 'utf8')).toBe('unrelated content');
  });
});
