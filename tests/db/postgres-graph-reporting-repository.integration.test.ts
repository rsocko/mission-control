import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@/db/postgres/schema';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import { describeGraphReportingRepositoryContract } from '../contracts/graph-reporting-repository.contract';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const TABLES = [
  'project_phase_items',
  'project_phases',
  'project_tags',
  'task_projects',
  'task_tags',
  'task_dependencies',
  'task_history_events',
  'tags',
  'hub_projects',
  'tasks',
  'connector_configs',
];

let sharedPool: Pool | null = null;

async function pool(): Promise<Pool> {
  if (!sharedPool) {
    assertSafeIntegrationTestTarget(connectionString!);
    const { Pool } = await import('pg');
    sharedPool = new Pool({ connectionString, max: 4 });
  }
  return sharedPool;
}

async function clear(database: Pool): Promise<void> {
  for (const table of TABLES) await database.query(`DELETE FROM "${table}"`);
}

afterAll(async () => {
  await sharedPool?.end();
  sharedPool = null;
});

if (connectionString) {
  describeGraphReportingRepositoryContract('PostgreSQL', async () => {
    const database = await pool();
    await clear(database);
    const { createPostgresGraphReportingRepository } = await import(
      '@/db/postgres/repositories/graph-reporting-repository'
    );
    return {
      repository: createPostgresGraphReportingRepository(
        drizzle(database, { schema }),
        database,
      ),
      async insert(table: string, row: Record<string, unknown>) {
        const columns = Object.keys(row);
        await database.query(
          `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
           VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
          columns.map((column) => row[column] ?? null),
        );
      },
      close: () => clear(database),
    };
  });

  describe('PostgreSQL graph reporting concurrency', () => {
    it('serializes opposing blocking-edge creation', async () => {
      const database = await pool();
      await clear(database);
      const { createPostgresGraphReportingRepository } = await import(
        '@/db/postgres/repositories/graph-reporting-repository'
      );
      const repository = createPostgresGraphReportingRepository(
        drizzle(database, { schema }),
        database,
      );
      const now = '2026-09-05T12:00:00.000Z';
      await database.query(
        `INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
         VALUES ('connector-live', 'local', 'Live', '{}', $1, $1)`,
        [now],
      );
      await database.query(
        `INSERT INTO hub_projects (id, name, created_at, updated_at)
         VALUES ('project-1', 'Project', $1, $1)`,
        [now],
      );
      await database.query(
        `INSERT INTO tasks (
           id, source_id, connector_type, connector_instance_id, title,
           created_at, updated_at, last_synced_at
         ) VALUES
           ('task-a', 'task-a', 'local', 'connector-live', 'Task A', $1, $1, $1),
           ('task-b', 'task-b', 'local', 'connector-live', 'Task B', $1, $1, $1)`,
        [now],
      );
      await database.query(
        `INSERT INTO task_projects (task_id, project_id)
         VALUES ('task-a', 'project-1'), ('task-b', 'project-1')`,
      );

      const results = await Promise.all([
        repository.projects.createDependency({
          projectId: 'project-1',
          sourceTaskId: 'task-a',
          targetTaskId: 'task-b',
          type: 'blocks',
          id: 'dependency-a-b',
          createdAt: now,
        }),
        repository.projects.createDependency({
          projectId: 'project-1',
          sourceTaskId: 'task-b',
          targetTaskId: 'task-a',
          type: 'blocks',
          id: 'dependency-b-a',
          createdAt: now,
        }),
      ]);

      expect(results.map(({ kind }) => kind).sort()).toEqual(['created', 'cycle']);
      await clear(database);
    });
  });
}

describe.skipIf(Boolean(connectionString))('PostgreSQL graph reporting integration', () => {
  it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
});
