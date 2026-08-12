import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { getBurnReport } from '@/lib/reports/burn';

vi.unmock('drizzle-orm');

const openDatabases: Database.Database[] = [];

function createDatabase() {
  const sqlite = new Database(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE hub_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      started_at TEXT,
      target_date TEXT
    );
    CREATE TABLE project_phases (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      target_start TEXT,
      target_end TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE task_history_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      field_name TEXT,
      previous_value TEXT,
      new_value TEXT,
      project_id TEXT,
      phase_id TEXT,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      provenance TEXT NOT NULL,
      provenance_ref TEXT,
      metadata TEXT
    );
  `);
  return { sqlite, database: drizzle(sqlite, { schema }) };
}

function insertEvent(
  sqlite: Database.Database,
  values: {
    taskId: string;
    eventType: string;
    occurredAt: string;
    newValue?: string | null;
    projectId?: string | null;
    phaseId?: string | null;
    provenance?: string;
  },
) {
  sqlite.prepare(`
    INSERT INTO task_history_events (
      task_id, event_type, new_value, project_id, phase_id,
      occurred_at, recorded_at, provenance
    ) VALUES (
      @taskId, @eventType, @newValue, @projectId, @phaseId,
      @occurredAt, @occurredAt, @provenance
    )
  `).run({
    newValue: null,
    projectId: null,
    phaseId: null,
    provenance: 'local',
    ...values,
  });
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('getBurnReport', () => {
  it('queries historical project and phase members rather than only current junction rows', async () => {
    const { sqlite, database } = createDatabase();
    sqlite.exec(`
      INSERT INTO hub_projects VALUES (
        'project-1', 'Reporting', '2026-07-01', '2026-07-31'
      );
      INSERT INTO project_phases VALUES (
        'phase-1', 'project-1', 'Build', '2026-07-01', '2026-07-15'
      );
      INSERT INTO tasks VALUES
        ('task-1', 'Migrated task', '2026-07-01T08:00:00.000Z', '2026-07-01T10:00:00.000Z'),
        ('task-2', 'Added task', '2026-07-01T08:00:00.000Z', NULL);
    `);
    insertEvent(sqlite, {
      taskId: 'task-1',
      eventType: 'baseline',
      occurredAt: '2026-07-01T12:00:00.000Z',
      provenance: 'migration_baseline',
      newValue: JSON.stringify({
        status: 'done',
        effort: 3,
        projectIds: ['project-1'],
        phaseIds: ['phase-1'],
      }),
    });
    insertEvent(sqlite, {
      taskId: 'task-2',
      eventType: 'baseline',
      occurredAt: '2026-07-01T13:00:00.000Z',
      newValue: JSON.stringify({
        status: 'todo',
        effort: 2,
        projectIds: [],
        phaseIds: [],
      }),
    });
    insertEvent(sqlite, {
      taskId: 'task-2',
      eventType: 'project_added',
      projectId: 'project-1',
      occurredAt: '2026-07-02T09:00:00.000Z',
    });
    insertEvent(sqlite, {
      taskId: 'task-2',
      eventType: 'phase_added',
      phaseId: 'phase-1',
      occurredAt: '2026-07-02T09:00:00.000Z',
    });

    const projectReport = await getBurnReport({
      projectId: 'project-1',
      mode: 'count',
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      today: '2026-07-03',
    }, database);
    const phaseReport = await getBurnReport({
      projectId: 'project-1',
      phaseId: 'phase-1',
      mode: 'count',
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      today: '2026-07-03',
    }, database);

    expect(projectReport?.points.at(-1)).toMatchObject({
      total: 2,
      completed: 1,
      remaining: 1,
    });
    expect(projectReport?.tasks.map((task) => task.title)).toEqual([
      'Migrated task',
      'Added task',
    ]);
    expect(phaseReport?.points.at(-1)).toMatchObject({
      total: 2,
      completed: 1,
      remaining: 1,
    });
  });

  it('loads migration baselines after the requested range to reconstruct earlier lifecycle dates', async () => {
    const { sqlite, database } = createDatabase();
    sqlite.exec(`
      INSERT INTO hub_projects VALUES (
        'project-1', 'Reporting', '2026-06-01', '2026-08-31'
      );
      INSERT INTO tasks VALUES (
        'task-1',
        'Historical task',
        '2026-06-10T08:00:00.000Z',
        '2026-06-20T10:00:00.000Z'
      );
    `);
    insertEvent(sqlite, {
      taskId: 'task-1',
      eventType: 'baseline',
      occurredAt: '2026-08-07T12:00:00.000Z',
      provenance: 'migration_baseline',
      newValue: JSON.stringify({
        status: 'done',
        effort: null,
        projectIds: ['project-1'],
        phaseIds: [],
      }),
    });

    const report = await getBurnReport({
      projectId: 'project-1',
      mode: 'count',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      today: '2026-08-07',
    }, database);

    expect(report?.points.find((point) => point.date === '2026-06-09')).toMatchObject({
      total: 0,
      completed: 0,
    });
    expect(report?.points.find((point) => point.date === '2026-06-10')).toMatchObject({
      total: 1,
      completed: 0,
    });
    expect(report?.points.find((point) => point.date === '2026-06-20')).toMatchObject({
      total: 1,
      completed: 1,
    });
  });

  it('loads later project additions to reconstruct scope in an earlier requested range', async () => {
    const { sqlite, database } = createDatabase();
    sqlite.exec(`
      INSERT INTO hub_projects VALUES (
        'project-1', 'Reporting', '2025-03-01', '2026-08-31'
      );
      INSERT INTO tasks VALUES (
        'task-1',
        'Older organized task',
        '2025-03-25T08:00:00.000Z',
        NULL
      );
    `);
    insertEvent(sqlite, {
      taskId: 'task-1',
      eventType: 'baseline',
      occurredAt: '2026-08-07T08:00:00.000Z',
      newValue: JSON.stringify({
        status: 'todo',
        effort: null,
        projectIds: [],
        phaseIds: [],
      }),
    });
    insertEvent(sqlite, {
      taskId: 'task-1',
      eventType: 'project_added',
      projectId: 'project-1',
      occurredAt: '2026-08-07T10:00:00.000Z',
    });

    const report = await getBurnReport({
      projectId: 'project-1',
      mode: 'count',
      startDate: '2025-03-24',
      endDate: '2025-03-31',
      today: '2026-08-08',
    }, database);

    expect(report?.points.find((point) => point.date === '2025-03-24')).toMatchObject({
      total: 0,
      completed: 0,
    });
    expect(report?.points.find((point) => point.date === '2025-03-25')).toMatchObject({
      total: 1,
      completed: 0,
    });
  });
});
