import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ProjectHierarchyPersistence } from '@/db/persistence/project-hierarchy';
import {
  projectHierarchyRepositoryContract,
  type ProjectHierarchyContractSeed,
} from '../contracts/project-hierarchy-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const NOW = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'contract-project';
const PHASE_A = 'contract-phase-a';
const TASKS = [
  'contract-task-1',
  'contract-task-2',
  'contract-task-3',
  'contract-task-4',
] as const;

function commandId(suffix: string) {
  return `10000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
}

describe.skipIf(!connectionString)('PostgreSQL project-hierarchy adapter', () => {
  let pool: Pool;
  let repository: ProjectHierarchyPersistence;
  let automation: { evaluateProject(projectId: string): Promise<unknown> };
  let contractSeed: ProjectHierarchyContractSeed;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [
      { Pool },
      { createPostgresProjectHierarchyRepository },
      { createPostgresProjectAutomationRepository },
    ] = await Promise.all([
      import('pg'),
      import('@/db/postgres/repositories/project-hierarchy-repository'),
      import('@/db/postgres/repositories/project-automation-repository'),
    ]);
    pool = new Pool({ connectionString });
    repository = createPostgresProjectHierarchyRepository(pool);
    automation = createPostgresProjectAutomationRepository(pool);

    contractSeed = {
      async reset() {
        await pool.query(`
          DELETE FROM project_hierarchy_mutation_context WHERE project_id LIKE 'contract-%';
          DELETE FROM project_hierarchy_commands WHERE project_id LIKE 'contract-%';
          DELETE FROM project_phase_items WHERE phase_id LIKE 'contract-phase-%';
          DELETE FROM project_auto_include_exclusions WHERE project_id LIKE 'contract-%';
          DELETE FROM task_projects WHERE project_id LIKE 'contract-%';
          DELETE FROM project_phases WHERE id LIKE 'contract-phase-%';
          DELETE FROM hub_projects WHERE id LIKE 'contract-%';
          DELETE FROM tasks WHERE id LIKE 'contract-task-%'
        `);
      },
      async seed(fixture) {
        await pool.query(`
          INSERT INTO hub_projects (
            id, name, color, source_bindings, auto_include_rules, kanban_columns,
            default_view, status, hidden, sort_order, hierarchy_revision,
            metadata, created_at, updated_at
          ) VALUES ($1, 'Contract project', '#3b82f6', '[]'::jsonb, '[]'::jsonb,
                    '[]'::jsonb, 'list', 'active', FALSE, 0, 0, '{}'::jsonb, $2, $2)
        `, [fixture.projectId, NOW]);
        for (const [index, phaseId] of fixture.phaseIds.entries()) {
          await pool.query(`
            INSERT INTO project_phases (
              id, project_id, name, status, sort_order, created_at, updated_at
            ) VALUES ($1, $2, $3, 'pending', $4, $5, $5)
          `, [phaseId, fixture.projectId, `Phase ${index + 1}`, index, NOW]);
        }
        for (const taskId of fixture.taskIds) {
          await pool.query(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, status,
              priority, metadata, sync_status, created_at, updated_at, last_synced_at
            ) VALUES ($1, $2, 'local', 'local', $1, 'todo', 'none', '{}'::jsonb,
                      'synced', $3, $3, $3)
          `, [taskId, `local:${taskId}`, NOW]);
        }
        await pool.query(`
          INSERT INTO task_projects (task_id, project_id)
          SELECT task_id, $2 FROM unnest($1::text[]) AS candidate(task_id)
        `, [fixture.taskIds.slice(0, 3), fixture.projectId]);
        const items = [
          [fixture.itemIds[0], fixture.phaseIds[0], fixture.taskIds[0], 0, 3],
          [fixture.itemIds[1], fixture.phaseIds[0], fixture.taskIds[1], 1, null],
          [fixture.itemIds[2], fixture.phaseIds[1], fixture.taskIds[2], 0, null],
        ] as const;
        for (const [id, phaseId, taskId, sortOrder, effort] of items) {
          await pool.query(`
            INSERT INTO project_phase_items (
              id, phase_id, task_id, sort_order, estimated_effort_hours,
              is_proposed, proposal_type, created_at
            ) VALUES ($1, $2, $3, $4, $5, FALSE, NULL, $6)
          `, [id, phaseId, taskId, sortOrder, effort, NOW]);
        }
        await pool.query(
          'UPDATE hub_projects SET hierarchy_revision = 0 WHERE id = $1',
          [fixture.projectId],
        );
      },
      async seedEmptyProject(projectId) {
        await pool.query(`
          INSERT INTO hub_projects (
            id, name, color, source_bindings, auto_include_rules, kanban_columns,
            default_view, status, hidden, sort_order, hierarchy_revision,
            metadata, created_at, updated_at
          ) VALUES ($1, 'Other project', '#3b82f6', '[]'::jsonb, '[]'::jsonb,
                    '[]'::jsonb, 'list', 'active', FALSE, 0, 0, '{}'::jsonb, $2, $2)
        `, [projectId, NOW]);
      },
      async readRevision(projectId) {
        const { rows } = await pool.query<{ revision: number }>(
          'SELECT hierarchy_revision AS revision FROM hub_projects WHERE id = $1',
          [projectId],
        );
        return rows[0]?.revision ?? -1;
      },
      async isMember(projectId, taskId) {
        const { rowCount } = await pool.query(
          'SELECT 1 FROM task_projects WHERE project_id = $1 AND task_id = $2',
          [projectId, taskId],
        );
        return (rowCount ?? 0) > 0;
      },
      async readExclusion(projectId, taskId) {
        const { rows } = await pool.query<{ excludedAt: string }>(`
          SELECT excluded_at AS "excludedAt" FROM project_auto_include_exclusions
          WHERE project_id = $1 AND task_id = $2
        `, [projectId, taskId]);
        return rows[0]?.excludedAt ?? null;
      },
      async addMembershipOutOfBand(projectId, taskId) {
        await pool.query(`
          INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [taskId, projectId]);
      },
    };
  });

  afterAll(async () => {
    await contractSeed?.reset();
    await pool?.end();
  });

  projectHierarchyRepositoryContract(
    'PostgreSQL',
    () => repository,
    () => contractSeed,
  );

  describe('PostgreSQL project-hierarchy concurrency and trigger parity', () => {
    beforeAll(async () => {
      await contractSeed.reset();
    });

    async function reseed() {
      await contractSeed.reset();
      await contractSeed.seed({
        projectId: PROJECT_ID,
        phaseIds: [PHASE_A, 'contract-phase-b'],
        taskIds: [...TASKS] as [string, string, string, string],
        itemIds: ['contract-item-1', 'contract-item-2', 'contract-item-3'],
      });
    }

    it('lets exactly one of two different commands win from one revision', async () => {
      await reseed();
      const results = await Promise.allSettled([
        repository.applyAuthorizedCommand({
          projectId: PROJECT_ID,
          request: {
            commandId: commandId('1'),
            expectedRevision: 0,
            command: {
              type: 'move_tasks',
              taskIds: [TASKS[0]],
              toPhaseId: 'contract-phase-b',
              toIndex: 0,
            },
          },
        }),
        repository.applyAuthorizedCommand({
          projectId: PROJECT_ID,
          request: {
            commandId: commandId('2'),
            expectedRevision: 0,
            command: {
              type: 'move_tasks',
              taskIds: [TASKS[1]],
              toPhaseId: 'contract-phase-b',
              toIndex: 0,
            },
          },
        }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected && (rejected as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        code: 'HIERARCHY_REVISION_CONFLICT',
      });
      expect(await contractSeed.readRevision(PROJECT_ID)).toBe(1);
    });

    it('collapses a raced identical command into one commit and one replay', async () => {
      await reseed();
      const request = {
        commandId: commandId('3'),
        expectedRevision: 0,
        command: {
          type: 'move_tasks' as const,
          taskIds: [TASKS[0]],
          toPhaseId: 'contract-phase-b',
          toIndex: 0,
        },
      };
      const [first, second] = await Promise.all([
        repository.applyAuthorizedCommand({ projectId: PROJECT_ID, request }),
        repository.applyAuthorizedCommand({ projectId: PROJECT_ID, request }),
      ]);

      expect(second).toEqual(first);
      expect(await contractSeed.readRevision(PROJECT_ID)).toBe(1);
    });

    it('serializes hierarchy commands with project automation on one project lock', async () => {
      await reseed();
      const [applied] = await Promise.all([
        repository.applyAuthorizedCommand({
          projectId: PROJECT_ID,
          request: {
            commandId: commandId('4'),
            expectedRevision: 0,
            command: { type: 'remove_tasks', taskIds: [TASKS[0]] },
          },
        }),
        automation.evaluateProject(PROJECT_ID),
      ]);

      expect(applied.revision).toBe(1);
      expect(await contractSeed.isMember(PROJECT_ID, TASKS[0])).toBe(false);
    });

    it('advances the revision for out-of-band writes and cleans membership placement', async () => {
      await reseed();
      await pool.query(`
        INSERT INTO project_phases (id, project_id, name, status, sort_order, created_at, updated_at)
        VALUES ('contract-phase-c', $1, 'Phase 3', 'pending', 2, $2, $2)
      `, [PROJECT_ID, NOW]);
      expect(await contractSeed.readRevision(PROJECT_ID)).toBe(1);

      await pool.query(
        'DELETE FROM task_projects WHERE project_id = $1 AND task_id = $2',
        [PROJECT_ID, TASKS[0]],
      );
      // The membership delete bumps once, and its placement-cleanup trigger
      // deletes the phase item, whose own out-of-band trigger bumps again.
      expect(await contractSeed.readRevision(PROJECT_ID)).toBe(3);
      const { rowCount } = await pool.query(
        'SELECT 1 FROM project_phase_items WHERE task_id = $1',
        [TASKS[0]],
      );
      expect(rowCount ?? 0).toBe(0);

      await pool.query('DELETE FROM project_phases WHERE id = $1', ['contract-phase-c']);
      expect(await contractSeed.readRevision(PROJECT_ID)).toBe(4);
    });

    it('enforces the phase-placement guards on out-of-band writes', async () => {
      await reseed();
      await expect(pool.query(`
        INSERT INTO project_phase_items (
          id, phase_id, task_id, sort_order, estimated_effort_hours,
          is_proposed, proposal_type, created_at
        ) VALUES ('contract-duplicate', 'contract-phase-b', $1, 1, NULL, FALSE, NULL, $2)
      `, [TASKS[0], NOW])).rejects.toThrow(
        'task already belongs to another phase in this project',
      );

      await expect(pool.query(`
        INSERT INTO project_phase_items (
          id, phase_id, task_id, sort_order, estimated_effort_hours,
          is_proposed, proposal_type, created_at
        ) VALUES ('contract-outsider', 'contract-phase-b', $1, 1, NULL, FALSE, NULL, $2)
      `, [TASKS[3], NOW])).rejects.toThrow('task must belong to the phase project');
    });

    it('suppresses trigger-driven bumps while a mutation context is held', async () => {
      await reseed();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO project_hierarchy_mutation_context (project_id) VALUES ($1)',
          [PROJECT_ID],
        );
        await client.query(
          'INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [TASKS[3], PROJECT_ID],
        );
        const { rows } = await client.query<{ revision: number }>(
          'SELECT hierarchy_revision AS revision FROM hub_projects WHERE id = $1',
          [PROJECT_ID],
        );
        expect(rows[0].revision).toBe(0);
        await client.query('COMMIT');
      } finally {
        await client.query(
          'DELETE FROM project_hierarchy_mutation_context WHERE project_id = $1',
          [PROJECT_ID],
        );
        client.release();
      }
      expect(await contractSeed.readRevision(PROJECT_ID)).toBe(0);
    });
  });
});
