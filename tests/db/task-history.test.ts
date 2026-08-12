import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _runMigrationsIndividually } from '@/db';
import * as schema from '@/db/schema';
import {
  getTaskStateAtTime,
  getTaskTransitionsInRange,
} from '@/db/task-history';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const openDatabases: Database.Database[] = [];

function createDatabase() {
  const sqlite = new Database(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      micro_status TEXT,
      kanban_column TEXT,
      effort INTEGER,
      updated_at TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE task_projects (
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL
    );
    CREATE TABLE project_phase_items (
      id TEXT PRIMARY KEY NOT NULL,
      phase_id TEXT NOT NULL,
      task_id TEXT NOT NULL
    );
  `);
  return sqlite;
}

function applyMigration(sqlite: Database.Database) {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0031_add_task_history.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

function insertTask(
  sqlite: Database.Database,
  overrides: Partial<{
    id: string;
    sourceId: string;
    connectorType: string;
    connectorInstanceId: string;
    status: string;
    microStatus: string | null;
    kanbanColumn: string | null;
    effort: number | null;
    updatedAt: string;
    syncStatus: string;
  }> = {},
) {
  sqlite.prepare(`
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, status,
      micro_status, kanban_column, effort, updated_at, sync_status
    ) VALUES (
      @id, @sourceId, @connectorType, @connectorInstanceId, @status,
      @microStatus, @kanbanColumn, @effort, @updatedAt, @syncStatus
    )
  `).run({
    id: 'task-1',
    sourceId: 'local:task-1',
    connectorType: 'local',
    connectorInstanceId: 'local',
    status: 'todo',
    microStatus: null,
    kanbanColumn: null,
    effort: null,
    updatedAt: '2026-08-01T00:00:00.000Z',
    syncStatus: 'synced',
    ...overrides,
  });
}

function historyRows(sqlite: Database.Database) {
  return sqlite.prepare(`
    SELECT event_type AS eventType, previous_value AS previousValue,
      new_value AS newValue, provenance, project_id AS projectId,
      phase_id AS phaseId
    FROM task_history_events
    ORDER BY id
  `).all() as Array<{
    eventType: string;
    previousValue: string | null;
    newValue: string | null;
    provenance: string;
    projectId: string | null;
    phaseId: string | null;
  }>;
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe('task history migration and capture', () => {
  it('applies through the application migration runner on a fresh database', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);

    _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

    expect(sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'task_history_events'
    `).get()).toEqual({ name: 'task_history_events' });
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM __drizzle_migrations
      WHERE created_at = 1785473000000
    `).get()).toEqual({ count: 1 });
  });

  it('backfills one defensible baseline and removes duplicate memberships safely', () => {
    const sqlite = createDatabase();
    insertTask(sqlite, { status: 'in_progress', effort: 3 });
    sqlite.exec(`
      INSERT INTO task_projects VALUES ('task-1', 'project-1'), ('task-1', 'project-1');
      INSERT INTO project_phase_items VALUES
        ('item-1', 'phase-1', 'task-1'),
        ('item-2', 'phase-1', 'task-1');
    `);

    applyMigration(sqlite);

    const rows = historyRows(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('baseline');
    expect(rows[0].provenance).toBe('migration_baseline');
    expect(JSON.parse(rows[0].newValue!)).toMatchObject({
      status: 'in_progress',
      effort: 3,
      projectIds: ['project-1'],
      phaseIds: ['phase-1'],
    });
    expect(sqlite.prepare('SELECT count(*) AS count FROM task_projects').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT count(*) AS count FROM project_phase_items').get()).toEqual({ count: 1 });
  });

  it('captures local tracked changes and rejects history mutation', () => {
    const sqlite = createDatabase();
    applyMigration(sqlite);
    insertTask(sqlite);

    sqlite.prepare(`
      UPDATE tasks
      SET status = 'in_progress', micro_status = 'blocked',
        kanban_column = 'doing', effort = 3,
        updated_at = '2026-08-02T00:00:00.000Z',
        sync_status = 'pending_push'
      WHERE id = 'task-1'
    `).run();

    const rows = historyRows(sqlite);
    expect(rows.map((row) => row.eventType)).toEqual([
      'baseline',
      'status_changed',
      'micro_status_changed',
      'kanban_column_changed',
      'effort_changed',
    ]);
    expect(rows.slice(1).every((row) => row.provenance === 'local')).toBe(true);
    expect(() => sqlite.exec(`UPDATE task_history_events SET new_value = 'tampered'`))
      .toThrow('task_history_events is append-only');
    expect(() => sqlite.exec('DELETE FROM task_history_events'))
      .toThrow('task_history_events is append-only');
  });

  it('does not duplicate events when a connector repeats unchanged state', () => {
    const sqlite = createDatabase();
    applyMigration(sqlite);
    insertTask(sqlite, {
      sourceId: 'repo#1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const sync = sqlite.prepare(`
      UPDATE tasks
      SET status = 'done', sync_status = 'synced'
      WHERE id = 'task-1'
    `);
    sync.run();
    sync.run();

    const statusEvents = historyRows(sqlite).filter((row) => row.eventType === 'status_changed');
    expect(statusEvents).toEqual([expect.objectContaining({
      previousValue: 'todo',
      newValue: 'done',
      provenance: 'connector',
    })]);
    const timestamps = sqlite.prepare(`
      SELECT occurred_at AS occurredAt
      FROM task_history_events
      WHERE task_id = 'task-1'
      ORDER BY id
    `).all() as Array<{ occurredAt: string }>;
    expect(timestamps[1].occurredAt >= timestamps[0].occurredAt).toBe(true);
  });

  it('preserves reopen and recomplete sequences', () => {
    const sqlite = createDatabase();
    applyMigration(sqlite);
    insertTask(sqlite, { status: 'done' });

    sqlite.exec(`
      UPDATE tasks
      SET status = 'todo', updated_at = '2026-08-04T00:00:00.000Z', sync_status = 'pending_push'
      WHERE id = 'task-1';
      UPDATE tasks
      SET status = 'done', updated_at = '2026-08-05T00:00:00.000Z', sync_status = 'pending_push'
      WHERE id = 'task-1';
    `);

    expect(historyRows(sqlite).map((row) => row.eventType)).toEqual([
      'baseline',
      'status_changed',
      'reopened',
      'status_changed',
    ]);
  });

  it('captures project and phase membership additions and removals once', () => {
    const sqlite = createDatabase();
    applyMigration(sqlite);
    insertTask(sqlite);

    sqlite.exec(`
      INSERT INTO task_projects VALUES ('task-1', 'project-1');
      INSERT INTO project_phase_items VALUES ('item-1', 'phase-1', 'task-1');
      DELETE FROM task_projects WHERE task_id = 'task-1' AND project_id = 'project-1';
      DELETE FROM project_phase_items WHERE task_id = 'task-1' AND phase_id = 'phase-1';
      INSERT INTO task_projects VALUES ('missing-task', 'project-orphan');
      INSERT OR IGNORE INTO task_projects VALUES ('task-1', 'project-2');
      INSERT OR IGNORE INTO task_projects VALUES ('task-1', 'project-2');
    `);

    expect(historyRows(sqlite).slice(1)).toEqual([
      expect.objectContaining({ eventType: 'project_added', projectId: 'project-1' }),
      expect.objectContaining({ eventType: 'phase_added', phaseId: 'phase-1' }),
      expect.objectContaining({ eventType: 'project_removed', projectId: 'project-1' }),
      expect.objectContaining({ eventType: 'phase_removed', phaseId: 'phase-1' }),
      expect.objectContaining({ eventType: 'project_added', projectId: 'project-orphan' }),
      expect.objectContaining({ eventType: 'project_added', projectId: 'project-2' }),
    ]);
    expect(() => sqlite.exec(`INSERT INTO task_projects VALUES ('task-1', 'project-2'), ('task-1', 'project-2')`))
      .toThrow();
  });
});

describe('task history reporting helpers', () => {
  it('queries ranges and reconstructs state no earlier than the baseline', async () => {
    const sqlite = createDatabase();
    insertTask(sqlite, { status: 'todo', effort: 1 });
    sqlite.exec(`
      INSERT INTO task_projects VALUES ('task-1', 'project-1');
      INSERT INTO project_phase_items VALUES ('item-1', 'phase-1', 'task-1');
    `);
    applyMigration(sqlite);
    const database = drizzle(sqlite, { schema });

    sqlite.exec(`
      UPDATE tasks
      SET status = 'in_progress', effort = 3,
        updated_at = '2026-08-10T00:00:00.000Z', sync_status = 'pending_push'
      WHERE id = 'task-1';
      DELETE FROM task_projects WHERE task_id = 'task-1' AND project_id = 'project-1';
      INSERT INTO task_projects VALUES ('task-1', 'project-2');
      DELETE FROM project_phase_items WHERE task_id = 'task-1' AND phase_id = 'phase-1';
      INSERT INTO project_phase_items VALUES ('item-2', 'phase-2', 'task-1');
    `);

    const transitions = await getTaskTransitionsInRange({
      start: '2000-01-01T00:00:00.000Z',
      end: '9999-12-31T23:59:59.999Z',
      taskIds: ['task-1'],
      eventTypes: ['status_changed', 'effort_changed'],
    }, database);
    expect(transitions.map((event) => event.eventType)).toEqual([
      'status_changed',
      'effort_changed',
    ]);

    const baseline = sqlite.prepare(`
      SELECT occurred_at AS occurredAt
      FROM task_history_events
      WHERE task_id = 'task-1' AND event_type = 'baseline'
    `).get() as { occurredAt: string };
    expect(await getTaskStateAtTime('task-1', '2000-01-01T00:00:00.000Z', database)).toBeNull();
    expect(await getTaskStateAtTime('task-1', '9999-12-31T23:59:59.999Z', database)).toEqual({
      taskId: 'task-1',
      status: 'in_progress',
      microStatus: null,
      kanbanColumn: null,
      effort: 3,
      projectIds: ['project-2'],
      phaseIds: ['phase-2'],
      asOf: '9999-12-31T23:59:59.999Z',
      historicalBoundaryAt: baseline.occurredAt,
    });
  });
});
