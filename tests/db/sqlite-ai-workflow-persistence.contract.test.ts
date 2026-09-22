import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AIWorkflowPersistence } from '@/db/persistence/ai-workflows';
import type { DailyPlanningPersistence } from '@/db/persistence/daily-planning';
import type { ProjectAdministrationPersistence } from '@/db/persistence/project-organization';
import {
  AI_WORKFLOW_NOW,
  AI_WORKFLOW_TODAY,
  describeAIWorkflowPersistenceContract,
  type AIWorkflowContractHarness,
} from '../contracts/ai-workflow-persistence.contract';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

describe('SQLite AI workflow adapter', () => {
  let sqlite: Database.Database;
  let persistence: AIWorkflowPersistence;
  let dailyPlanning: DailyPlanningPersistence;
  let projects: ProjectAdministrationPersistence;
  let harness: AIWorkflowContractHarness;

  beforeAll(async () => {
    const { importInitializedSqliteDatabase } = await import(
      '../helpers/initialized-sqlite-database'
    );
    const database = await importInitializedSqliteDatabase();
    const { createSqliteAIWorkflowPersistence } = await import(
      '@/db/persistence/sqlite-ai-workflow-repository'
    );
    const [{ createSqliteDailyPlanningPersistence }, {
      createSqliteProjectAdministrationRepository,
    }] = await Promise.all([
      import('@/db/persistence/sqlite-daily-planning-repository'),
      import('@/db/persistence/sqlite-project-organization-repositories'),
    ]);
    sqlite = database.sqlite;
    persistence = createSqliteAIWorkflowPersistence(sqlite);
    dailyPlanning = createSqliteDailyPlanningPersistence(sqlite);
    projects = createSqliteProjectAdministrationRepository(sqlite);
    harness = {
      persistence,
      dailyPlanning,
      projects,
      async reset() {
        sqlite.exec(`
          DELETE FROM my_day_items;
          DELETE FROM focus_items;
          DELETE FROM task_schedules;
          DELETE FROM task_tags;
          DELETE FROM task_projects;
          DELETE FROM notifications;
          DELETE FROM tags;
          DELETE FROM hub_projects;
          DELETE FROM tasks;
        `);
      },
      async seed() {
        const insertTask = sqlite.prepare(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, priority, due_date, created_at, updated_at, last_synced_at,
            source_list_name, assignee, depth, parent_id
          ) VALUES (
            @id, @sourceId, @connectorType, 'aiw-instance', @title, @description,
            @status, @priority, @dueDate, @createdAt, @updatedAt, @updatedAt,
            @sourceListName, @assignee, @depth, @parentId
          )
        `);
        const tasks = [
          {
            id: 'aiw-task-a', title: 'Alpha', description: 'Alpha description',
            status: 'todo', priority: 'high', dueDate: '2026-09-05',
            connectorType: 'github', sourceListName: 'Work', updatedAt: '2026-09-06T10:00:00.000Z',
            depth: 0, assignee: null,
          },
          {
            id: 'aiw-task-b', title: 'Beta', description: null,
            status: 'todo', priority: 'critical', dueDate: AI_WORKFLOW_TODAY,
            connectorType: 'todo', sourceListName: 'Today', updatedAt: '2026-09-06T12:00:00.000Z',
            depth: 0, assignee: 'Riley',
          },
          {
            id: 'aiw-task-c', title: 'Gamma', description: null,
            status: 'in_progress', priority: 'medium', dueDate: '2026-09-04',
            connectorType: 'todo', sourceListName: null, updatedAt: '2026-09-06T11:00:00.000Z',
            depth: 0, assignee: null,
          },
          {
            id: 'aiw-task-d', title: 'Done', description: null,
            status: 'done', priority: 'critical', dueDate: '2026-09-01',
            connectorType: 'github', sourceListName: null, updatedAt: '2026-09-06T15:00:00.000Z',
            depth: 0, assignee: null,
          },
          {
            id: 'aiw-task-e', title: 'Epsilon', description: 'Energy target',
            status: 'todo', priority: 'low', dueDate: null,
            connectorType: 'local', sourceListName: null, updatedAt: '2026-09-06T14:00:00.000Z',
            depth: 0, assignee: null,
          },
          {
            id: 'aiw-task-child', title: 'Child', description: null,
            status: 'todo', priority: 'none', dueDate: null,
            connectorType: 'local', sourceListName: null, updatedAt: '2026-09-06T14:00:00.000Z',
            depth: 1, assignee: null,
          },
        ];
        for (const task of tasks) {
          insertTask.run({
            ...task,
            sourceId: `source-${task.id}`,
            createdAt: '2026-09-01T00:00:00.000Z',
            parentId: task.id === 'aiw-task-child' ? 'aiw-task-a' : null,
          });
        }

        sqlite.prepare(`
          INSERT INTO hub_projects (
            id, name, description, category, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          'aiw-project-1',
          'Project One',
          'First project',
          'engineering',
          AI_WORKFLOW_NOW,
          AI_WORKFLOW_NOW,
        );
        sqlite.prepare(`
          INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)
        `).run('aiw-task-a', 'aiw-project-1');
        sqlite.prepare(`
          INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)
        `).run('aiw-task-b', 'aiw-project-1');

        const insertTag = sqlite.prepare(`
          INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
          VALUES (?, ?, ?, 'ai-inferred', 'contract', ?, 1, ?)
        `);
        insertTag.run('aiw-tag-alpha', 'Alpha', 'alpha', '#111111', AI_WORKFLOW_NOW);
        insertTag.run('aiw-energy-z', 'Energy high duplicate', 'energy-high', '#10b981', AI_WORKFLOW_NOW);
        insertTag.run('aiw-energy-a', 'Energy high canonical', 'energy-high', '#10b981', AI_WORKFLOW_NOW);
        sqlite.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)')
          .run('aiw-task-a', 'aiw-tag-alpha');
        sqlite.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)')
          .run('aiw-task-b', 'aiw-energy-z');

        sqlite.prepare(`
          INSERT INTO my_day_items (id, task_id, date, added_at, "order")
          VALUES ('aiw-day', 'aiw-task-b', ?, ?, 1)
        `).run(AI_WORKFLOW_TODAY, AI_WORKFLOW_NOW);
        sqlite.prepare(`
          INSERT INTO focus_items (id, task_id, scope, date, slot, added_at)
          VALUES ('aiw-focus', 'aiw-task-a', 'today', ?, 1, ?)
        `).run(AI_WORKFLOW_TODAY, AI_WORKFLOW_NOW);
        sqlite.prepare(`
          INSERT INTO task_schedules (
            task_id, scheduled_date, scheduled_time, estimated_duration
          ) VALUES ('aiw-task-b', ?, '09:30', 45)
        `).run(AI_WORKFLOW_TODAY);

        const insertNotification = sqlite.prepare(`
          INSERT INTO notifications (
            id, source_id, connector_type, connector_instance_id, title,
            level, level_rank, category, read_state, disposition, source_state,
            is_actionable, received_at, sort_at, snoozed_until
          ) VALUES (
            @id, @sourceId, @connectorType, 'aiw-instance', @title,
            @level, @levelRank, @category, @readState, 'inbox', 'active',
            @isActionable, @receivedAt, @receivedAt, @snoozedUntil
          )
        `);
        for (const notification of [
          {
            id: 'aiw-notification-old', title: 'Urgent', level: 'urgent', levelRank: 0,
            category: 'security', readState: 'unread', isActionable: 1,
            receivedAt: '2026-09-06T11:00:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-new', title: 'FYI', level: 'fyi', levelRank: 3,
            category: 'work', readState: 'unread', isActionable: 0,
            receivedAt: '2026-09-06T11:00:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-read', title: 'Read', level: 'urgent', levelRank: 0,
            category: 'security', readState: 'read', isActionable: 1,
            receivedAt: '2026-09-06T11:30:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-digest', title: 'Digest', level: 'digest', levelRank: 4,
            category: 'system', readState: 'unread', isActionable: 0,
            receivedAt: '2026-09-06T11:40:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-snoozed', title: 'Snoozed', level: 'urgent', levelRank: 0,
            category: 'security', readState: 'unread', isActionable: 1,
            receivedAt: '2026-09-06T11:50:00.000Z',
            snoozedUntil: '2026-09-07T00:00:00.000Z',
          },
        ]) {
          insertNotification.run({
            ...notification,
            sourceId: `source-${notification.id}`,
            connectorType: 'outlook',
          });
        }
      },
      async seedRawTasks(rows) {
        const insert = sqlite.prepare(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, priority, due_date, completed_at, created_at, updated_at,
            last_synced_at, source_list_name, assignee, depth, parent_id
          ) VALUES (
            @id, @sourceId, 'local', 'aiw-instance', @title, @description,
            @status, 'none', NULL, @completedAt, @createdAt, @updatedAt,
            @updatedAt, NULL, NULL, 0, NULL
          )
        `);
        for (const row of rows) {
          insert.run({ ...row, sourceId: `source-${row.id}` });
        }
      },
      async inspectEnergyState(taskIds) {
        const tags = sqlite.prepare(`
          SELECT id, slug FROM tags
          WHERE slug IN ('energy-high', 'energy-medium', 'energy-low')
          ORDER BY slug, id
        `).all() as Array<{ id: string; slug: string }>;
        const links = sqlite.prepare(`
          SELECT tt.task_id AS taskId, tt.tag_id AS tagId, t.slug
          FROM task_tags tt
          INNER JOIN tags t ON t.id = tt.tag_id
          WHERE tt.task_id IN (${taskIds.map(() => '?').join(', ')})
            AND t.slug IN ('energy-high', 'energy-medium', 'energy-low')
          ORDER BY tt.task_id, tt.tag_id
        `).all(...taskIds) as Array<{ taskId: string; tagId: string; slug: string }>;
        return { tags, links };
      },
    };
  }, 30_000);

  afterAll(() => {
    sqlite?.close();
    delete process.env.MC_DB_PATH;
  });

  describeAIWorkflowPersistenceContract('SQLite', () => harness);

  it('keeps composite planning and goal reads on one SQLite snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mc-ai-workflow-snapshot-'));
    const path = join(directory, 'snapshot.db');
    const reader = new Database(path);
    const writer = new Database(path);
    try {
      reader.pragma('journal_mode = WAL');
      writer.pragma('journal_mode = WAL');
      reader.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          priority TEXT NOT NULL,
          due_date TEXT,
          connector_type TEXT NOT NULL,
          source_list_name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          depth INTEGER NOT NULL
        );
        CREATE TABLE my_day_items (task_id TEXT NOT NULL, date TEXT NOT NULL);
        CREATE TABLE task_schedules (
          task_id TEXT NOT NULL,
          scheduled_date TEXT NOT NULL,
          scheduled_time TEXT,
          estimated_duration INTEGER
        );
        CREATE TABLE focus_items (
          task_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          date TEXT NOT NULL
        );
        CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL);
        CREATE TABLE task_tags (task_id TEXT NOT NULL, tag_id TEXT NOT NULL);
        CREATE TABLE hub_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          category TEXT
        );
        CREATE TABLE task_projects (task_id TEXT NOT NULL, project_id TEXT NOT NULL);

        INSERT INTO tasks VALUES (
          'task-a', 'Alpha', 'Initial task', 'todo', 'high', NULL, 'local', NULL,
          '2026-09-01T00:00:00.000Z', '2026-09-06T00:00:00.000Z', 0
        );
        INSERT INTO my_day_items VALUES ('task-a', '${AI_WORKFLOW_TODAY}');
        INSERT INTO task_schedules VALUES ('task-a', '${AI_WORKFLOW_TODAY}', '09:30', 30);
        INSERT INTO focus_items VALUES ('task-a', 'today', '${AI_WORKFLOW_TODAY}');
        INSERT INTO tags VALUES ('tag-a', 'Initial tag', 'initial-tag');
        INSERT INTO task_tags VALUES ('task-a', 'tag-a');
        INSERT INTO hub_projects VALUES (
          'project-a', 'Initial project', 'Initial description', 'engineering'
        );
        INSERT INTO task_projects VALUES ('task-a', 'project-a');
      `);

      const {
        createSqliteAIDailyPlanningExtensions,
        createSqliteAIProjectOrganizationExtensions,
      } = await import('@/db/persistence/sqlite-ai-workflow-repository');
      const planning = createSqliteAIDailyPlanningExtensions(reader);
      const organization = createSqliteAIProjectOrganizationExtensions(reader);
      const originalPrepare = reader.prepare.bind(reader);

      function interleaveWrite(
        sqlFragment: string,
        method: 'all' | 'get',
        write: () => void,
      ) {
        let fired = false;
        const spy = vi.spyOn(reader, 'prepare').mockImplementation((source) => {
          const statement = originalPrepare(source);
          if (fired || !source.includes(sqlFragment)) return statement;
          return new Proxy(statement, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property === method) {
                return (...args: unknown[]) => {
                  const result = Reflect.apply(
                    value as (...parameters: unknown[]) => unknown,
                    target,
                    args,
                  );
                  fired = true;
                  write();
                  return result;
                };
              }
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        });
        return { spy, fired: () => fired };
      }

      const dayWrite = interleaveWrite('FROM my_day_items m', 'all', () => {
        writer.exec(`
          UPDATE task_schedules SET scheduled_time = '11:00' WHERE task_id = 'task-a';
          INSERT INTO tasks VALUES (
            'task-b', 'Beta', NULL, 'todo', 'medium', NULL, 'local', NULL,
            '2026-09-01T00:00:00.000Z', '2026-09-06T00:00:00.000Z', 0
          );
        `);
      });
      const dayContext = await planning.dayPlan.getContext({
        date: AI_WORKFLOW_TODAY,
        openTaskLimit: 20,
      });
      dayWrite.spy.mockRestore();
      expect(dayWrite.fired()).toBe(true);
      expect(dayContext.schedules).toEqual([
        expect.objectContaining({ taskId: 'task-a', scheduledTime: '09:30' }),
      ]);
      expect(dayContext.openTasks.map((task) => task.id)).toEqual(['task-a']);

      const focusWrite = interleaveWrite('FROM focus_items', 'all', () => {
        writer.exec(`
          INSERT INTO tasks VALUES (
            'task-c', 'Gamma', NULL, 'todo', 'low', NULL, 'local', NULL,
            '2026-09-01T00:00:00.000Z', '2026-09-06T00:00:00.000Z', 0
          );
          INSERT INTO my_day_items VALUES ('task-b', '${AI_WORKFLOW_TODAY}');
        `);
      });
      const focusContext = await planning.getFocusSuggestionContext({
        scope: 'today',
        date: AI_WORKFLOW_TODAY,
        effectiveDate: AI_WORKFLOW_TODAY,
        taskLimit: 20,
      });
      focusWrite.spy.mockRestore();
      expect(focusWrite.fired()).toBe(true);
      expect(focusContext.tasks.map((task) => task.id)).toEqual(['task-a', 'task-b']);
      expect(focusContext.myDayTaskIds).toEqual(['task-a']);

      const goalWrite = interleaveWrite('FROM tasks WHERE id = ?', 'get', () => {
        writer.exec(`
          UPDATE tags SET name = 'Updated tag' WHERE id = 'tag-a';
          UPDATE hub_projects SET name = 'Updated project' WHERE id = 'project-a';
        `);
      });
      const goalContext = await organization.getGoalDevelopmentContext('task-a', 20);
      goalWrite.spy.mockRestore();
      expect(goalWrite.fired()).toBe(true);
      expect(goalContext).toMatchObject({
        tags: [{ name: 'Initial tag', slug: 'initial-tag' }],
        linkedProjects: [{ name: 'Initial project' }],
        existingProjects: [{ name: 'Initial project' }],
      });
    } finally {
      reader.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
