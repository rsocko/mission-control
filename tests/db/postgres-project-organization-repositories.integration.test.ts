import { afterAll, beforeAll, describe } from 'vitest';
import type { Pool } from 'pg';
import type { ProjectAutomationRepository } from '@/db/persistence/project-automation';
import {
  ORGANIZATION_FIXTURE,
  ORGANIZATION_NOW,
  projectOrganizationRepositoriesContract,
  type ProjectOrganizationContractSeed,
} from '../contracts/project-organization-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)('PostgreSQL project-organization adapters', () => {
  let pool: Pool;
  let repository: ProjectAutomationRepository;
  let seed: ProjectOrganizationContractSeed;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [
      { Pool },
      { createPostgresProjectAutomationRepository },
    ] = await Promise.all([
      import('pg'),
      import('@/db/postgres/repositories/project-automation-repository'),
    ]);
    pool = new Pool({ connectionString });
    repository = createPostgresProjectAutomationRepository(pool);

    seed = {
      async reset() {
        await pool.query(`
          DELETE FROM project_hierarchy_mutation_context
            WHERE project_id LIKE 'organization-contract-%';
          DELETE FROM project_hierarchy_commands
            WHERE project_id LIKE 'organization-contract-%';
          DELETE FROM project_phase_items
            WHERE phase_id LIKE 'organization-contract-%';
          DELETE FROM project_auto_include_exclusions
            WHERE project_id LIKE 'organization-contract-%';
          DELETE FROM task_projects
            WHERE project_id LIKE 'organization-contract-%';
          DELETE FROM project_phases
            WHERE id LIKE 'organization-contract-%';
          DELETE FROM hub_projects
            WHERE id LIKE 'organization-contract-%';
          DELETE FROM tasks
            WHERE id LIKE 'organization-contract-%';
          DELETE FROM source_lists
            WHERE id LIKE 'organization-contract-%';
          DELETE FROM list_groups
            WHERE id LIKE 'organization-contract-%'
        `);
      },
      async seed() {
        await pool.query(`
          INSERT INTO hub_projects (
            id, name, color, source_bindings, auto_include_rules, kanban_columns,
            default_view, status, hidden, sort_order, hierarchy_revision,
            metadata, created_at, updated_at
          ) VALUES
            ($1, 'Zulu project', '#3b82f6', '[]'::jsonb, $4::jsonb, '[]'::jsonb,
             'list', 'active', FALSE, 0, 0, '{}'::jsonb, $5, $5),
            ($2, 'Alpha project', '#3b82f6', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
             'list', 'active', FALSE, 0, 0, '{}'::jsonb, $5, $5),
            ($3, 'Hidden project', '#3b82f6', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
             'list', 'active', TRUE, 0, 0, '{}'::jsonb, $5, $5)
        `, [
          ORGANIZATION_FIXTURE.projectId,
          ORGANIZATION_FIXTURE.otherProjectId,
          ORGANIZATION_FIXTURE.hiddenProjectId,
          JSON.stringify([
            { type: 'title_contains', value: 'match' },
            { type: 'connector', value: 'organization-connector' },
          ]),
          ORGANIZATION_NOW,
        ]);

        await pool.query(`
          INSERT INTO project_phases (
            id, project_id, name, status, start_after_phase_id, sort_order,
            created_at, updated_at
          ) VALUES
            ($1, $3, 'Design', 'pending', NULL, 1, $4, $4),
            ($2, $3, 'Build', 'pending', $1, 0, $4, $4)
        `, [
          ORGANIZATION_FIXTURE.phaseA,
          ORGANIZATION_FIXTURE.phaseB,
          ORGANIZATION_FIXTURE.projectId,
          ORGANIZATION_NOW,
        ]);

        await pool.query(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, source_list_id,
            title, status, priority, metadata, sync_status, created_at, updated_at,
            last_synced_at
          ) VALUES
            ($1, $3, 'local', 'organization-connector', 'remote-b', 'second match',
             'todo', 'none', '{}'::jsonb, 'synced', $5, $5, $5),
            ($2, $4, 'local', 'organization-connector', 'remote-a', 'first match',
             'todo', 'none', '{}'::jsonb, 'synced', $5, $5, $5)
        `, [
          ORGANIZATION_FIXTURE.taskB,
          ORGANIZATION_FIXTURE.taskA,
          `source:${ORGANIZATION_FIXTURE.taskB}`,
          `source:${ORGANIZATION_FIXTURE.taskA}`,
          ORGANIZATION_NOW,
        ]);
        await pool.query(`
          INSERT INTO task_projects (task_id, project_id)
          VALUES ($1, $3), ($2, $3)
        `, [
          ORGANIZATION_FIXTURE.taskB,
          ORGANIZATION_FIXTURE.taskA,
          ORGANIZATION_FIXTURE.projectId,
        ]);
        await pool.query(`
          INSERT INTO project_phase_items (
            id, phase_id, task_id, sort_order, is_proposed, created_at
          ) VALUES
            ($1, $3, $4, 1, FALSE, $6),
            ($2, $3, $5, 0, FALSE, $6)
        `, [
          ORGANIZATION_FIXTURE.itemA,
          ORGANIZATION_FIXTURE.itemB,
          ORGANIZATION_FIXTURE.phaseA,
          ORGANIZATION_FIXTURE.taskA,
          ORGANIZATION_FIXTURE.taskB,
          ORGANIZATION_NOW,
        ]);

        await pool.query(`
          INSERT INTO list_groups (id, name, sort_order, created_at)
          VALUES
            ($1, 'Zulu group', 1, $3),
            ($2, 'Alpha group', 0, $3)
        `, [
          ORGANIZATION_FIXTURE.groupA,
          ORGANIZATION_FIXTURE.groupB,
          ORGANIZATION_NOW,
        ]);
        await pool.query(`
          INSERT INTO source_lists (
            id, connector_instance_id, source_id, name, type, task_count,
            group_id, sort_order, hidden, user_display_name
          ) VALUES
            ($1, 'organization-connector', 'remote-a', 'Zulu', 'list', 0,
             $3, 1, FALSE, NULL),
            ($2, 'organization-connector', 'remote-b', 'Beta', 'list', 0,
             $3, 0, FALSE, 'A display')
        `, [
          ORGANIZATION_FIXTURE.listA,
          ORGANIZATION_FIXTURE.listB,
          ORGANIZATION_FIXTURE.groupA,
        ]);
        await pool.query(
          'UPDATE hub_projects SET hierarchy_revision = 0 WHERE id = $1',
          [ORGANIZATION_FIXTURE.projectId],
        );
      },
    };
  });

  afterAll(async () => {
    await seed?.reset();
    await pool?.end();
  });

  projectOrganizationRepositoriesContract(
    'PostgreSQL',
    () => repository,
    () => seed,
  );
});
