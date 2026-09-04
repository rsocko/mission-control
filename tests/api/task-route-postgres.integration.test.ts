import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const poison = vi.hoisted(() => ({ triggered: false }));

vi.mock('@/db', () => {
  poison.triggered = true;
  throw new Error('POISONED: task routes must not import @/db');
});
vi.mock('@/lib/search/fts', () => ({
  indexTask: vi.fn(async () => undefined),
  removeTaskFromIndex: vi.fn(async () => undefined),
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityDelete: vi.fn(async () => undefined),
  publishSemanticEntityUpsert: vi.fn(async () => undefined),
}));
vi.mock('@/lib/rules', () => ({ evaluateRulesForTasks: vi.fn(async () => undefined) }));

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalEnvironment = {
  backend: process.env.MC_DATABASE_BACKEND,
  url: process.env.MC_POSTGRES_URL,
  sslMode: process.env.MC_POSTGRES_SSL_MODE,
  applicationName: process.env.MC_POSTGRES_APPLICATION_NAME,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

if (connectionString) {
  describe('task routes with PostgreSQL task-core', () => {
    let runtime: typeof import('@/db/runtime');
    let pool: Pool;
    let collectionRoute: typeof import('@/app/api/tasks/route');
    let detailRoute: typeof import('@/app/api/tasks/[id]/route');

    beforeAll(async () => {
      assertSafeIntegrationTestTarget(connectionString);
      process.env.MC_DATABASE_BACKEND = 'postgres';
      process.env.MC_POSTGRES_URL = connectionString;
      process.env.MC_POSTGRES_SSL_MODE =
        new URL(connectionString).searchParams.get('sslmode') ?? 'disable';
      process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-task-route-test';
      runtime = await import('@/db/runtime');
      await runtime.initializeRuntimeDatabase();
      pool = runtime.getPostgresPersistenceBackend().context.pool;
      await pool.query(`
        TRUNCATE TABLE
          event_outbox_deliveries,
          event_outbox,
          triage_action_claims,
          triage_items,
          task_attachments,
          task_linked_sources,
          task_schedules,
          task_triage_log,
          task_projects,
          task_tags,
          my_day_exclusions,
          my_day_items,
          tasks
        RESTART IDENTITY CASCADE
      `);
      [collectionRoute, detailRoute] = await Promise.all([
        import('@/app/api/tasks/route'),
        import('@/app/api/tasks/[id]/route'),
      ]);
    });

    it('imports both routes and executes collection, detail, create, patch, and delete', async () => {
      const createResponse = await collectionRoute.POST(new Request(
        'http://localhost/api/tasks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'PostgreSQL route proof', priority: 'high' }),
        },
      ));
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { id: string };

      const collectionResponse = await collectionRoute.GET(new Request(
        'http://localhost/api/tasks?search=route%20proof',
      ));
      expect(collectionResponse.status).toBe(200);
      await expect(collectionResponse.json()).resolves.toMatchObject({
        tasks: [expect.objectContaining({ id: created.id })],
        total: 1,
      });

      const detailResponse = await detailRoute.GET(
        new Request(`http://localhost/api/tasks/${created.id}`),
        { params: Promise.resolve({ id: created.id }) },
      );
      expect(detailResponse.status).toBe(200);
      await expect(detailResponse.json()).resolves.toMatchObject({
        task: {
          id: created.id,
          title: 'PostgreSQL route proof',
        },
      });

      const patchResponse = await detailRoute.PATCH(new Request(
        `http://localhost/api/tasks/${created.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'PostgreSQL route updated' }),
        },
      ), { params: Promise.resolve({ id: created.id }) });
      expect(patchResponse.status).toBe(200);
      expect((await pool.query(
        'SELECT title FROM tasks WHERE id = $1',
        [created.id],
      )).rows[0]?.title).toBe('PostgreSQL route updated');

      const deleteResponse = await detailRoute.DELETE(new Request(
        `http://localhost/api/tasks/${created.id}`,
        { method: 'DELETE' },
      ), { params: Promise.resolve({ id: created.id }) });
      expect(deleteResponse.status).toBe(200);
      expect((await pool.query(
        'SELECT COUNT(*)::int AS count FROM tasks WHERE id = $1',
        [created.id],
      )).rows[0]?.count).toBe(0);
      expect(poison.triggered).toBe(false);
    });

    afterAll(async () => {
      if (runtime) await runtime.shutdownRuntimeDatabase();
      restore('MC_DATABASE_BACKEND', originalEnvironment.backend);
      restore('MC_POSTGRES_URL', originalEnvironment.url);
      restore('MC_POSTGRES_SSL_MODE', originalEnvironment.sslMode);
      restore('MC_POSTGRES_APPLICATION_NAME', originalEnvironment.applicationName);
    });
  });
} else {
  describe('task routes with PostgreSQL task-core', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
