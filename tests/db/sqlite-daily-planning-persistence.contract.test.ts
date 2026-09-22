import { afterAll, beforeAll, describe, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { DailyPlanningPersistence } from '@/db/persistence/daily-planning';
import {
  describeDailyPlanningPersistenceContract,
  type DailyPlanningContractHarness,
  type DailyPlanningTaskSeed,
} from '../contracts/daily-planning-persistence.contract';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

describe('SQLite daily-planning adapter', () => {
  let sqlite: Database.Database;
  let persistence: DailyPlanningPersistence;
  let harness: DailyPlanningContractHarness;

  beforeAll(async () => {
    const { importInitializedSqliteDatabase } = await import(
      '../helpers/initialized-sqlite-database'
    );
    const database = await importInitializedSqliteDatabase();
    const { createSqliteDailyPlanningPersistence } = await import(
      '@/db/persistence/sqlite-daily-planning-repository'
    );
    sqlite = database.sqlite;
    persistence = createSqliteDailyPlanningPersistence(sqlite);
    harness = {
      persistence,
      async reset() {
        sqlite.exec(`
          DELETE FROM my_day_items;
          DELETE FROM my_day_exclusions;
          DELETE FROM focus_items;
          DELETE FROM weekly_one_thing;
          DELETE FROM energy_checkins;
          DELETE FROM task_schedules;
          DELETE FROM task_tags;
          DELETE FROM task_projects;
          DELETE FROM tasks;
          DELETE FROM triage_items;
          DELETE FROM notifications;
          DELETE FROM connector_configs;
        `);
      },
      async seedTasks(tasks: readonly DailyPlanningTaskSeed[]) {
        const insert = sqlite.prepare(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, local_disposition, priority, planning_horizon, due_date, push_count,
            created_at, updated_at, completed_at, parent_id, depth, is_checklist_item,
            source_list_id, source_list_name, assignee, micro_status, status_reason,
            metadata, sync_status, last_synced_at
          ) VALUES (
            @id, @sourceId, @connectorType, @connectorInstanceId, @title, @description,
            @status, @localDisposition, @priority, @planningHorizon, @dueDate, @pushCount,
            @createdAt, @updatedAt, @completedAt, @parentId, @depth, 0,
            @sourceListId, @sourceListName, NULL, @microStatus, NULL,
            '{}', 'synced', @updatedAt
          )
        `);
        for (const task of tasks) {
          insert.run({
            id: task.id,
            sourceId: task.sourceId ?? `source-${task.id}`,
            connectorType: task.connectorType ?? 'local',
            connectorInstanceId: task.connectorInstanceId ?? 'local',
            title: task.title ?? task.id,
            description: task.description ?? null,
            status: task.status ?? 'todo',
            localDisposition: task.localDisposition ?? 'active',
            priority: task.priority ?? 'none',
            planningHorizon: task.planningHorizon ?? null,
            dueDate: task.dueDate ?? null,
            pushCount: task.pushCount ?? 0,
            createdAt: task.createdAt ?? '2026-09-04T12:00:00.000Z',
            updatedAt: task.updatedAt ?? '2026-09-04T12:00:00.000Z',
            completedAt: task.completedAt ?? null,
            parentId: task.parentId ?? null,
            depth: task.depth ?? 0,
            sourceListId: task.sourceListId ?? null,
            sourceListName: task.sourceListName ?? null,
            microStatus: task.microStatus ?? null,
          });
        }
      },
      async countPlanningSignals(taskId, eventType) {
        return Number((sqlite.prepare(`
          SELECT COUNT(*) AS count FROM task_history_events
          WHERE task_id = ? AND event_type = ?
        `).get(taskId, eventType) as { count: number }).count);
      },
      async countMyDayExclusions(taskId, date) {
        return Number((sqlite.prepare(`
          SELECT COUNT(*) AS count FROM my_day_exclusions WHERE task_id = ? AND date = ?
        `).get(taskId, date) as { count: number }).count);
      },
    };
  }, 30_000);

  afterAll(() => {
    sqlite?.close();
    delete process.env.MC_DB_PATH;
  });

  describeDailyPlanningPersistenceContract('SQLite', () => harness);
});
