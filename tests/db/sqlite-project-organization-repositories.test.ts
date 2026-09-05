import { afterAll, beforeAll, describe, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ProjectAutomationRepository } from '@/db/persistence/project-automation';
import {
  ORGANIZATION_FIXTURE,
  ORGANIZATION_NOW,
  projectOrganizationRepositoriesContract,
  type ProjectOrganizationContractSeed,
} from '../contracts/project-organization-repositories.contract';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

describe('SQLite project-organization adapters', () => {
  let sqlite: Database.Database;
  let repository: ProjectAutomationRepository;
  let seed: ProjectOrganizationContractSeed;

  beforeAll(async () => {
    const { importInitializedSqliteDatabase } = await import(
      '../helpers/initialized-sqlite-database'
    );
    const database = await importInitializedSqliteDatabase();
    const { createSqliteProjectAutomationRepository } = await import(
      '@/db/persistence/sqlite-project-automation-repository'
    );
    sqlite = database.sqlite;
    repository = createSqliteProjectAutomationRepository(sqlite);

    seed = {
      async reset() {
        sqlite.exec(`
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
            WHERE id LIKE 'organization-contract-%';
        `);
      },
      async seed() {
        const insertProject = sqlite.prepare(`
          INSERT INTO hub_projects (
            id, name, color, source_bindings, auto_include_rules, kanban_columns,
            default_view, status, hidden, sort_order, hierarchy_revision,
            metadata, created_at, updated_at
          ) VALUES (?, ?, '#3b82f6', '[]', ?, '[]', 'list', 'active', ?, 0, 0,
                    '{}', ?, ?)
        `);
        insertProject.run(
          ORGANIZATION_FIXTURE.projectId,
          'Zulu project',
          JSON.stringify([
            { type: 'title_contains', value: 'match' },
            { type: 'connector', value: 'organization-connector' },
          ]),
          0,
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
        );
        insertProject.run(
          ORGANIZATION_FIXTURE.otherProjectId,
          'Alpha project',
          '[]',
          0,
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
        );
        insertProject.run(
          ORGANIZATION_FIXTURE.hiddenProjectId,
          'Hidden project',
          '[]',
          1,
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
        );

        const insertPhase = sqlite.prepare(`
          INSERT INTO project_phases (
            id, project_id, name, status, start_after_phase_id, sort_order,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
        `);
        insertPhase.run(
          ORGANIZATION_FIXTURE.phaseA,
          ORGANIZATION_FIXTURE.projectId,
          'Design',
          null,
          1,
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
        );
        insertPhase.run(
          ORGANIZATION_FIXTURE.phaseB,
          ORGANIZATION_FIXTURE.projectId,
          'Build',
          ORGANIZATION_FIXTURE.phaseA,
          0,
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
        );

        const insertTask = sqlite.prepare(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, source_list_id,
            title, status, priority, metadata, sync_status, created_at, updated_at,
            last_synced_at
          ) VALUES (?, ?, 'local', 'organization-connector', ?, ?, 'todo', 'none',
                    '{}', 'synced', ?, ?, ?)
        `);
        insertTask.run(
          ORGANIZATION_FIXTURE.taskB,
          `source:${ORGANIZATION_FIXTURE.taskB}`,
          'remote-b',
          'second match',
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
        );
        insertTask.run(
          ORGANIZATION_FIXTURE.taskA,
          `source:${ORGANIZATION_FIXTURE.taskA}`,
          'remote-a',
          'first match',
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
          ORGANIZATION_NOW,
        );
        const insertMembership = sqlite.prepare(
          'INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)',
        );
        insertMembership.run(ORGANIZATION_FIXTURE.taskB, ORGANIZATION_FIXTURE.projectId);
        insertMembership.run(ORGANIZATION_FIXTURE.taskA, ORGANIZATION_FIXTURE.projectId);

        const insertItem = sqlite.prepare(`
          INSERT INTO project_phase_items (
            id, phase_id, task_id, sort_order, is_proposed, created_at
          ) VALUES (?, ?, ?, ?, 0, ?)
        `);
        insertItem.run(
          ORGANIZATION_FIXTURE.itemA,
          ORGANIZATION_FIXTURE.phaseA,
          ORGANIZATION_FIXTURE.taskA,
          1,
          ORGANIZATION_NOW,
        );
        insertItem.run(
          ORGANIZATION_FIXTURE.itemB,
          ORGANIZATION_FIXTURE.phaseA,
          ORGANIZATION_FIXTURE.taskB,
          0,
          ORGANIZATION_NOW,
        );

        const insertGroup = sqlite.prepare(`
          INSERT INTO list_groups (id, name, sort_order, created_at)
          VALUES (?, ?, ?, ?)
        `);
        insertGroup.run(
          ORGANIZATION_FIXTURE.groupA,
          'Zulu group',
          1,
          ORGANIZATION_NOW,
        );
        insertGroup.run(
          ORGANIZATION_FIXTURE.groupB,
          'Alpha group',
          0,
          ORGANIZATION_NOW,
        );

        const insertList = sqlite.prepare(`
          INSERT INTO source_lists (
            id, connector_instance_id, source_id, name, type, task_count,
            group_id, sort_order, hidden, user_display_name
          ) VALUES (?, 'organization-connector', ?, ?, 'list', 0, ?, ?, 0, ?)
        `);
        insertList.run(
          ORGANIZATION_FIXTURE.listA,
          'remote-a',
          'Zulu',
          ORGANIZATION_FIXTURE.groupA,
          1,
          null,
        );
        insertList.run(
          ORGANIZATION_FIXTURE.listB,
          'remote-b',
          'Beta',
          ORGANIZATION_FIXTURE.groupA,
          0,
          'A display',
        );

        sqlite.prepare(`
          UPDATE hub_projects SET hierarchy_revision = 0
          WHERE id = ?
        `).run(ORGANIZATION_FIXTURE.projectId);
      },
    };
  });

  afterAll(async () => {
    await seed?.reset();
    sqlite?.close();
    delete process.env.MC_DB_PATH;
  });

  projectOrganizationRepositoriesContract(
    'SQLite',
    () => repository,
    () => seed,
  );
});
