import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backfillTaskFieldStates,
  backfillTasksLastSyncedAt,
  repairTaskLinkedSourceDuplicates,
} from '@/db/bootstrap/repairs/task-sync';

const openDatabases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  openDatabases.push(sqlite);
  return sqlite;
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe('task bootstrap repairs', () => {
  it('removes duplicate linked-source identities idempotently', () => {
    const sqlite = createDatabase();
    sqlite.exec(`
      CREATE TABLE task_linked_sources (
        task_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        source_id TEXT NOT NULL
      );
      INSERT INTO task_linked_sources VALUES
        ('task-first', 'connector-1', 'source-1'),
        ('task-duplicate', 'connector-1', 'source-1'),
        ('task-other', 'connector-1', 'source-2');
    `);

    repairTaskLinkedSourceDuplicates(sqlite);
    repairTaskLinkedSourceDuplicates(sqlite);

    expect(sqlite.prepare(`
      SELECT task_id AS taskId, source_id AS sourceId
      FROM task_linked_sources
      ORDER BY source_id
    `).all()).toEqual([
      { taskId: 'task-first', sourceId: 'source-1' },
      { taskId: 'task-other', sourceId: 'source-2' },
    ]);
  });

  it('backfills each scout field state once while preserving existing overrides', () => {
    const sqlite = createDatabase();
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT,
        due_date TEXT,
        connector_type TEXT NOT NULL,
        last_synced_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_field_states (
        task_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        source_value TEXT NOT NULL,
        locally_overridden INTEGER NOT NULL DEFAULT 0,
        source_observed_at TEXT,
        local_edited_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, field_name)
      );
      INSERT INTO tasks VALUES (
        'task-1',
        'Source title',
        'Source description',
        'high',
        '2026-08-20',
        'scout',
        '2026-08-14T12:00:00.000Z',
        '2026-08-14T12:30:00.000Z'
      );
      INSERT INTO task_field_states VALUES (
        'task-1',
        'title',
        '"Local title"',
        1,
        '2026-08-14T11:00:00.000Z',
        '2026-08-14T11:30:00.000Z',
        '2026-08-14T11:30:00.000Z'
      );
    `);

    backfillTaskFieldStates(sqlite);
    backfillTaskFieldStates(sqlite);

    expect(sqlite.prepare(`
      SELECT field_name AS fieldName, source_value AS sourceValue,
        locally_overridden AS locallyOverridden,
        source_observed_at AS sourceObservedAt
      FROM task_field_states
      ORDER BY field_name
    `).all()).toEqual([
      {
        fieldName: 'description',
        sourceValue: '"Source description"',
        locallyOverridden: 0,
        sourceObservedAt: '2026-08-14T12:00:00.000Z',
      },
      {
        fieldName: 'dueDate',
        sourceValue: '"2026-08-20"',
        locallyOverridden: 0,
        sourceObservedAt: '2026-08-14T12:00:00.000Z',
      },
      {
        fieldName: 'priority',
        sourceValue: '"high"',
        locallyOverridden: 0,
        sourceObservedAt: '2026-08-14T12:00:00.000Z',
      },
      {
        fieldName: 'title',
        sourceValue: '"Local title"',
        locallyOverridden: 1,
        sourceObservedAt: '2026-08-14T11:00:00.000Z',
      },
    ]);
  });

  it('backfills missing synchronization timestamps idempotently', () => {
    const sqlite = createDatabase();
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        last_synced_at TEXT
      );
      INSERT INTO tasks VALUES
        ('task-null', '2026-08-14T10:00:00.000Z', NULL),
        ('task-empty', '2026-08-14T11:00:00.000Z', ''),
        ('task-set', '2026-08-14T12:00:00.000Z', '2026-08-14T09:00:00.000Z');
    `);

    backfillTasksLastSyncedAt(sqlite);
    backfillTasksLastSyncedAt(sqlite);

    expect(sqlite.prepare(`
      SELECT id, last_synced_at AS lastSyncedAt
      FROM tasks
      ORDER BY id
    `).all()).toEqual([
      { id: 'task-empty', lastSyncedAt: '2026-08-14T11:00:00.000Z' },
      { id: 'task-null', lastSyncedAt: '2026-08-14T10:00:00.000Z' },
      { id: 'task-set', lastSyncedAt: '2026-08-14T09:00:00.000Z' },
    ]);
  });

  it('propagates unexpected repair schema failures', () => {
    const sqlite = createDatabase();

    expect(() => repairTaskLinkedSourceDuplicates(sqlite)).toThrow(
      'no such table: task_linked_sources',
    );
    expect(() => backfillTaskFieldStates(sqlite)).toThrow(
      'no such table: task_field_states',
    );
  });
});
