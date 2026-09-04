import { afterAll, beforeAll, describe, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ProjectHierarchyPersistence } from '@/db/persistence/project-hierarchy';
import {
  projectHierarchyRepositoryContract,
  type ProjectHierarchyContractSeed,
} from '../contracts/project-hierarchy-repository.contract';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

const NOW = '2026-01-01T00:00:00.000Z';

describe('SQLite project-hierarchy adapter', () => {
  let sqlite: Database.Database;
  let repository: ProjectHierarchyPersistence;
  let contractSeed: ProjectHierarchyContractSeed;

  beforeAll(async () => {
    const { importInitializedSqliteDatabase } = await import(
      '../helpers/initialized-sqlite-database'
    );
    const database = await importInitializedSqliteDatabase();
    const { createSqliteProjectHierarchyRepository } = await import(
      '@/db/persistence/sqlite-project-hierarchy-repository'
    );
    sqlite = database.sqlite;
    repository = createSqliteProjectHierarchyRepository(sqlite);

    contractSeed = {
      async reset() {
        sqlite.exec(`
          DELETE FROM project_hierarchy_mutation_context WHERE project_id LIKE 'contract-%';
          DELETE FROM project_hierarchy_commands WHERE project_id LIKE 'contract-%';
          DELETE FROM project_phase_items WHERE phase_id LIKE 'contract-phase-%';
          DELETE FROM project_auto_include_exclusions WHERE project_id LIKE 'contract-%';
          DELETE FROM task_projects WHERE project_id LIKE 'contract-%';
          DELETE FROM project_phases WHERE id LIKE 'contract-phase-%';
          DELETE FROM hub_projects WHERE id LIKE 'contract-%';
          DELETE FROM tasks WHERE id LIKE 'contract-task-%';
        `);
      },
      async seed(fixture) {
        sqlite.prepare(`
          INSERT INTO hub_projects (
            id, name, color, source_bindings, auto_include_rules, kanban_columns,
            default_view, status, hidden, sort_order, hierarchy_revision,
            metadata, created_at, updated_at
          ) VALUES (?, 'Contract project', '#3b82f6', '[]', '[]', '[]',
                    'list', 'active', 0, 0, 0, '{}', ?, ?)
        `).run(fixture.projectId, NOW, NOW);
        fixture.phaseIds.forEach((phaseId, index) => {
          sqlite.prepare(`
            INSERT INTO project_phases (
              id, project_id, name, status, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
          `).run(phaseId, fixture.projectId, `Phase ${index + 1}`, index, NOW, NOW);
        });
        for (const taskId of fixture.taskIds) {
          sqlite.prepare(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, status,
              priority, metadata, sync_status, created_at, updated_at, last_synced_at
            ) VALUES (?, ?, 'local', 'local', ?, 'todo', 'none', '{}', 'synced', ?, ?, ?)
          `).run(taskId, `local:${taskId}`, taskId, NOW, NOW, NOW);
        }
        for (const taskId of fixture.taskIds.slice(0, 3)) {
          sqlite.prepare(
            'INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)',
          ).run(taskId, fixture.projectId);
        }
        const items: Array<[string, string, string, number, number | null]> = [
          [fixture.itemIds[0], fixture.phaseIds[0], fixture.taskIds[0], 0, 3],
          [fixture.itemIds[1], fixture.phaseIds[0], fixture.taskIds[1], 1, null],
          [fixture.itemIds[2], fixture.phaseIds[1], fixture.taskIds[2], 0, null],
        ];
        for (const [id, phaseId, taskId, sortOrder, effort] of items) {
          sqlite.prepare(`
            INSERT INTO project_phase_items (
              id, phase_id, task_id, sort_order, estimated_effort_hours,
              is_proposed, proposal_type, created_at
            ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
          `).run(id, phaseId, taskId, sortOrder, effort, NOW);
        }
        sqlite.prepare(
          'UPDATE hub_projects SET hierarchy_revision = 0 WHERE id = ?',
        ).run(fixture.projectId);
      },
      async seedEmptyProject(projectId) {
        sqlite.prepare(`
          INSERT INTO hub_projects (
            id, name, color, source_bindings, auto_include_rules, kanban_columns,
            default_view, status, hidden, sort_order, hierarchy_revision,
            metadata, created_at, updated_at
          ) VALUES (?, 'Other project', '#3b82f6', '[]', '[]', '[]',
                    'list', 'active', 0, 0, 0, '{}', ?, ?)
        `).run(projectId, NOW, NOW);
      },
      async readRevision(projectId) {
        const row = sqlite.prepare(
          'SELECT hierarchy_revision AS revision FROM hub_projects WHERE id = ?',
        ).get(projectId) as { revision: number } | undefined;
        return row?.revision ?? -1;
      },
      async isMember(projectId, taskId) {
        return sqlite.prepare(
          'SELECT 1 AS present FROM task_projects WHERE project_id = ? AND task_id = ?',
        ).get(projectId, taskId) !== undefined;
      },
      async readExclusion(projectId, taskId) {
        const row = sqlite.prepare(`
          SELECT excluded_at AS excludedAt FROM project_auto_include_exclusions
          WHERE project_id = ? AND task_id = ?
        `).get(projectId, taskId) as { excludedAt: string } | undefined;
        return row?.excludedAt ?? null;
      },
      async addMembershipOutOfBand(projectId, taskId) {
        sqlite.prepare(
          'INSERT OR IGNORE INTO task_projects (task_id, project_id) VALUES (?, ?)',
        ).run(taskId, projectId);
      },
    };
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  projectHierarchyRepositoryContract(
    'SQLite',
    () => repository,
    () => contractSeed,
  );
});
