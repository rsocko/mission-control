import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('local task lifecycle', () => {
  const dbPath = join(process.cwd(), 'data', `local-task-lifecycle-${process.pid}-${Date.now()}.db`);
  const originalDbPath = process.env.MC_DB_PATH;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let deleteTaskLocally: typeof import('@/lib/tasks/local-task-lifecycle').deleteTaskLocally;

  beforeAll(async () => {
    process.env.MC_DB_PATH = dbPath;
    vi.doUnmock('crypto');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();
    const dbModule = await importInitializedSqliteDatabase();
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    ({ deleteTaskLocally } = await import('@/lib/tasks/local-task-lifecycle'));
  });

  afterAll(() => {
    sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${dbPath}${suffix}`;
      if (existsSync(file)) rmSync(file);
    }
    if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDbPath;
  });

  it('removes phase and lifecycle associations while preserving child tasks', async () => {
    const now = '2026-08-08T04:00:00.000Z';
    db.insert(schema.tasks).values([
      {
        id: 'local-root',
        sourceId: 'local:root',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Duplicate local task',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'local-child',
        sourceId: 'local:child',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Child task',
        parentId: 'local-root',
        depth: 1,
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'local-grandchild',
        sourceId: 'local:grandchild',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Grandchild task',
        parentId: 'local-child',
        depth: 2,
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]).run();
    db.insert(schema.projectPhases).values({
      id: 'phase-1',
      name: 'Phase 1',
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.taskProjects).values({
      taskId: 'local-root',
      projectId: 'project-1',
    }).run();
    db.insert(schema.projectPhaseItems).values({
      id: 'phase-item-1',
      phaseId: 'phase-1',
      taskId: 'local-root',
      createdAt: now,
    }).run();
    db.insert(schema.taskSchedules).values({
      taskId: 'local-root',
      scheduledDate: '2026-08-08',
      isTimeBlocked: false,
    }).run();
    db.insert(schema.myDayExclusions).values({
      id: 'exclusion-1',
      taskId: 'local-root',
      date: '2026-08-08',
      removedAt: now,
    }).run();
    db.insert(schema.focusItems).values({
      id: 'focus-1',
      taskId: 'local-root',
      scope: 'today',
      date: '2026-08-08',
      slot: 1,
      addedAt: now,
    }).run();
    db.insert(schema.taskLinkedSources).values({
      id: 'linked-1',
      taskId: 'local-root',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      sourceId: 'owner/repo#1',
      title: 'Mirror',
      linkedAt: now,
    }).run();
    db.insert(schema.taskAttachments).values({
      id: 'attachment-1',
      taskId: 'local-root',
      name: 'note.txt',
      contentType: 'text/plain',
      size: 4,
      contentBase64: 'dGVzdA==',
      createdAt: now,
    }).run();
    db.insert(schema.notifications).values({
      id: 'notification-1',
      sourceId: 'notification-source-1',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Related notification',
      receivedAt: now,
      sortAt: now,
      relatedTaskId: 'local-root',
    }).run();

    await deleteTaskLocally('local-root');

    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM project_phase_items WHERE task_id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_projects WHERE task_id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_schedules WHERE task_id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM my_day_exclusions WHERE task_id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM focus_items WHERE task_id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_linked_sources WHERE task_id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_attachments WHERE task_id = 'local-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT related_task_id AS relatedTaskId FROM notifications WHERE id = 'notification-1'",
    ).get()).toEqual({ relatedTaskId: null });
    expect(sqlite.prepare(
      "SELECT parent_id AS parentId, depth FROM tasks WHERE id = 'local-child'",
    ).get()).toEqual({ parentId: null, depth: 0 });
    expect(sqlite.prepare(
      "SELECT parent_id AS parentId, depth FROM tasks WHERE id = 'local-grandchild'",
    ).get()).toEqual({ parentId: 'local-child', depth: 1 });
  });
});
