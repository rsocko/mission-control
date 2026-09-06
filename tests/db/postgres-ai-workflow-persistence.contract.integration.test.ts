import { afterAll, beforeAll, describe } from 'vitest';
import type { Pool } from 'pg';
import type { AIWorkflowPersistence } from '@/db/persistence/ai-workflows';
import type { DailyPlanningPersistence } from '@/db/persistence/daily-planning';
import type { ProjectAdministrationPersistence } from '@/db/persistence/project-organization';
import {
  AI_WORKFLOW_NOW,
  AI_WORKFLOW_TODAY,
  describeAIWorkflowPersistenceContract,
  type AIWorkflowContractHarness,
} from '../contracts/ai-workflow-persistence.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)('PostgreSQL AI workflow adapter', () => {
  let pool: Pool;
  let persistence: AIWorkflowPersistence;
  let dailyPlanning: DailyPlanningPersistence;
  let projects: ProjectAdministrationPersistence;
  let harness: AIWorkflowContractHarness;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [{ Pool }, { createPostgresAIWorkflowPersistence }, {
      createPostgresDailyPlanningPersistence,
    }, {
      createPostgresProjectAdministrationRepository,
    }] = await Promise.all([
      import('pg'),
      import('@/db/postgres/repositories/ai-workflow-repository'),
      import('@/db/postgres/repositories/daily-planning-repository'),
      import('@/db/postgres/repositories/project-organization-repositories'),
    ]);
    pool = new Pool({ connectionString, max: 16 });
    persistence = createPostgresAIWorkflowPersistence(pool);
    dailyPlanning = createPostgresDailyPlanningPersistence(pool);
    projects = createPostgresProjectAdministrationRepository(pool);
    harness = {
      persistence,
      dailyPlanning,
      projects,
      async reset() {
        await pool.query(`
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
          await pool.query(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, description,
              status, priority, due_date, created_at, updated_at, last_synced_at,
               source_list_name, assignee, depth, parent_id
            ) VALUES (
              $1, $2, $3, 'aiw-instance', $4, $5, $6, $7, $8,
              '2026-09-01T00:00:00.000Z', $9, $9, $10, $11, $12, $13
            )
          `, [
            task.id,
            `source-${task.id}`,
            task.connectorType,
            task.title,
            task.description,
            task.status,
            task.priority,
            task.dueDate,
            task.updatedAt,
            task.sourceListName,
            task.assignee,
            task.depth,
            task.id === 'aiw-task-child' ? 'aiw-task-a' : null,
          ]);
        }

        await pool.query(`
          INSERT INTO hub_projects (
            id, name, description, category, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $5)
        `, [
          'aiw-project-1',
          'Project One',
          'First project',
          'engineering',
          AI_WORKFLOW_NOW,
        ]);
        await pool.query(`
          INSERT INTO task_projects (task_id, project_id)
          VALUES ('aiw-task-a', 'aiw-project-1'), ('aiw-task-b', 'aiw-project-1')
        `);
        await pool.query(`
          INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
          VALUES
            ('aiw-tag-alpha', 'Alpha', 'alpha', 'ai-inferred', 'contract', '#111111', TRUE, $1),
            ('aiw-energy-z', 'Energy high duplicate', 'energy-high', 'ai-inferred', 'contract', '#10b981', TRUE, $1),
            ('aiw-energy-a', 'Energy high canonical', 'energy-high', 'ai-inferred', 'contract', '#10b981', TRUE, $1)
        `, [AI_WORKFLOW_NOW]);
        await pool.query(`
          INSERT INTO task_tags (task_id, tag_id)
          VALUES ('aiw-task-a', 'aiw-tag-alpha'), ('aiw-task-b', 'aiw-energy-z')
        `);
        await pool.query(`
          INSERT INTO my_day_items (id, task_id, date, added_at, "order")
          VALUES ('aiw-day', 'aiw-task-b', $1, $2, 1)
        `, [AI_WORKFLOW_TODAY, AI_WORKFLOW_NOW]);
        await pool.query(`
          INSERT INTO focus_items (id, task_id, scope, date, slot, added_at)
          VALUES ('aiw-focus', 'aiw-task-a', 'today', $1, 1, $2)
        `, [AI_WORKFLOW_TODAY, AI_WORKFLOW_NOW]);
        await pool.query(`
          INSERT INTO task_schedules (
            task_id, scheduled_date, scheduled_time, estimated_duration
          ) VALUES ('aiw-task-b', $1, '09:30', 45)
        `, [AI_WORKFLOW_TODAY]);

        const notifications = [
          {
            id: 'aiw-notification-old', title: 'Urgent', level: 'urgent', levelRank: 0,
            category: 'security', readState: 'unread', isActionable: true,
            receivedAt: '2026-09-06T11:00:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-new', title: 'FYI', level: 'fyi', levelRank: 3,
            category: 'work', readState: 'unread', isActionable: false,
            receivedAt: '2026-09-06T11:00:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-read', title: 'Read', level: 'urgent', levelRank: 0,
            category: 'security', readState: 'read', isActionable: true,
            receivedAt: '2026-09-06T11:30:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-digest', title: 'Digest', level: 'digest', levelRank: 4,
            category: 'system', readState: 'unread', isActionable: false,
            receivedAt: '2026-09-06T11:40:00.000Z', snoozedUntil: null,
          },
          {
            id: 'aiw-notification-snoozed', title: 'Snoozed', level: 'urgent', levelRank: 0,
            category: 'security', readState: 'unread', isActionable: true,
            receivedAt: '2026-09-06T11:50:00.000Z',
            snoozedUntil: '2026-09-07T00:00:00.000Z',
          },
        ];
        for (const notification of notifications) {
          await pool.query(`
            INSERT INTO notifications (
              id, source_id, connector_type, connector_instance_id, title,
              level, level_rank, category, read_state, disposition, source_state,
              is_actionable, received_at, sort_at, snoozed_until
            ) VALUES (
              $1, $2, 'outlook', 'aiw-instance', $3, $4, $5, $6, $7,
              'inbox', 'active', $8, $9, $9, $10
            )
          `, [
            notification.id,
            `source-${notification.id}`,
            notification.title,
            notification.level,
            notification.levelRank,
            notification.category,
            notification.readState,
            notification.isActionable,
            notification.receivedAt,
            notification.snoozedUntil,
          ]);
        }
      },
      async seedRawTasks(rows) {
        for (const row of rows) {
          await pool.query(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, description,
              status, priority, due_date, completed_at, created_at, updated_at,
              last_synced_at, source_list_name, assignee, depth, parent_id
            ) VALUES (
              $1, $2, 'local', 'aiw-instance', $3, $4,
              $5, 'none', NULL, $6, $7, $8,
              $8, NULL, NULL, 0, NULL
            )
          `, [
            row.id,
            `source-${row.id}`,
            row.title,
            row.description,
            row.status,
            row.completedAt,
            row.createdAt,
            row.updatedAt,
          ]);
        }
      },
      async inspectEnergyState(taskIds) {
        const tags = (await pool.query<{ id: string; slug: string }>(`
          SELECT id, slug FROM tags
          WHERE slug IN ('energy-high', 'energy-medium', 'energy-low')
          ORDER BY slug COLLATE "C", id COLLATE "C"
        `)).rows;
        const links = (await pool.query<{ taskId: string; tagId: string; slug: string }>(`
          SELECT tt.task_id AS "taskId", tt.tag_id AS "tagId", t.slug
          FROM task_tags tt
          INNER JOIN tags t ON t.id = tt.tag_id
          WHERE tt.task_id = ANY($1::text[])
            AND t.slug IN ('energy-high', 'energy-medium', 'energy-low')
          ORDER BY tt.task_id COLLATE "C", tt.tag_id COLLATE "C"
        `, [taskIds])).rows;
        return { tags, links };
      },
    };
  }, 120_000);

  afterAll(async () => {
    await harness?.reset();
    await pool?.end();
  });

  describeAIWorkflowPersistenceContract('PostgreSQL', () => harness);
});
