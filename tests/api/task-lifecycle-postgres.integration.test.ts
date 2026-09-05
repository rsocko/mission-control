import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const sqliteTouch = vi.hoisted(() => vi.fn());
vi.mock('@/db', () => {
  sqliteTouch();
  throw new Error('POISONED: task lifecycle routes must not import SQLite');
});
vi.mock('@/lib/rules', () => ({
  evaluateRulesForTasks: vi.fn(async () => undefined),
}));

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
  describe('task lifecycle routes with PostgreSQL task-core', () => {
    let runtime: typeof import('@/db/runtime');
    let pool: Pool;
    let routes: {
      attachments: typeof import('@/app/api/tasks/[id]/attachments/route');
      copy: typeof import('@/app/api/tasks/[id]/copy/route');
      promote: typeof import('@/app/api/tasks/[id]/promote/route');
      subtasks: typeof import('@/app/api/tasks/[id]/subtasks/route');
      tags: typeof import('@/app/api/tasks/[id]/tags/route');
    };

    beforeAll(async () => {
      assertSafeIntegrationTestTarget(connectionString);
      process.env.MC_DATABASE_BACKEND = 'postgres';
      process.env.MC_POSTGRES_URL = connectionString;
      process.env.MC_POSTGRES_SSL_MODE =
        new URL(connectionString).searchParams.get('sslmode') ?? 'disable';
      process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-task-lifecycle-route-test';

      runtime = await import('@/db/runtime');
      await runtime.initializeRuntimeDatabase();
      pool = runtime.getPostgresPersistenceBackend().context.pool;
      await pool.query(`
        TRUNCATE TABLE
          task_attachments,
          task_projects,
          task_tags,
          tags,
          tasks,
          connector_configs
        RESTART IDENTITY CASCADE
      `);
      await pool.query(`
        INSERT INTO connector_configs (
          id, type, name, enabled, capabilities, credentials, settings, synced_lists,
          created_at, updated_at
        ) VALUES (
          'local', 'local', 'Local', true, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z'
        )
      `);
      await pool.query(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          local_disposition, priority, created_at, updated_at, sync_status
        ) VALUES (
          'lifecycle-parent', 'local:lifecycle-parent', 'local', 'local',
          'Lifecycle parent', 'todo', 'active', 'medium',
          '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z', 'synced'
        )
      `);

      const [attachments, copy, promote, subtasks, tags] = await Promise.all([
        import('@/app/api/tasks/[id]/attachments/route'),
        import('@/app/api/tasks/[id]/copy/route'),
        import('@/app/api/tasks/[id]/promote/route'),
        import('@/app/api/tasks/[id]/subtasks/route'),
        import('@/app/api/tasks/[id]/tags/route'),
      ]);
      routes = { attachments, copy, promote, subtasks, tags };
    }, 120_000);

    it('executes all five route modules without loading SQLite', async () => {
      const params = { params: Promise.resolve({ id: 'lifecycle-parent' }) };

      const attachmentResponse = await routes.attachments.POST(new Request(
        'http://localhost/api/tasks/lifecycle-parent/attachments',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'proof.txt',
            contentType: 'text/plain',
            contentBase64: Buffer.from('proof').toString('base64'),
          }),
        },
      ), params);
      expect(attachmentResponse.status).toBe(200);
      const attachmentList = await routes.attachments.GET(new Request(
        'http://localhost/api/tasks/lifecycle-parent/attachments',
      ), params);
      await expect(attachmentList.json()).resolves.toMatchObject({
        attachments: [expect.objectContaining({ name: 'proof.txt' })],
      });

      const subtaskResponse = await routes.subtasks.POST(new Request(
        'http://localhost/api/tasks/lifecycle-parent/subtasks',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'PostgreSQL child', effort: 2 }),
        },
      ), params);
      expect(subtaskResponse.status).toBe(200);
      const subtaskId = ((await subtaskResponse.json()) as { subtask: { id: string } }).subtask.id;
      const subtaskList = await routes.subtasks.GET(new Request(
        'http://localhost/api/tasks/lifecycle-parent/subtasks',
      ), params);
      await expect(subtaskList.json()).resolves.toMatchObject({
        subtasks: [expect.objectContaining({ id: subtaskId })],
      });

      const promoteResponse = await routes.promote.POST(
        new Request(`http://localhost/api/tasks/${subtaskId}/promote`, { method: 'POST' }),
        { params: Promise.resolve({ id: subtaskId }) },
      );
      expect(promoteResponse.status).toBe(200);

      const tagResponse = await routes.tags.POST(new Request(
        'http://localhost/api/tasks/lifecycle-parent/tags',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tags: ['Needs Review', 'needs-review'] }),
        },
      ), params);
      expect(tagResponse.status).toBe(200);

      const taskCountBeforeRollback = (await pool.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM tasks',
      )).rows[0]?.count;
      await pool.query(`
        ALTER TABLE task_tags
        ADD CONSTRAINT fail_task_lifecycle_copy_tag_insert CHECK (false) NOT VALID
      `);
      try {
        const rollbackResponse = await routes.copy.POST(new Request(
          'http://localhost/api/tasks/lifecycle-parent/copy',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetConnectorInstanceId: 'local', keepTags: true }),
          },
        ), params);
        expect(rollbackResponse.status).toBe(500);
      } finally {
        await pool.query(`
          ALTER TABLE task_tags
          DROP CONSTRAINT IF EXISTS fail_task_lifecycle_copy_tag_insert
        `);
      }
      await expect(pool.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM tasks',
      )).resolves.toMatchObject({
        rows: [expect.objectContaining({ count: taskCountBeforeRollback })],
      });

      const copyResponse = await routes.copy.POST(new Request(
        'http://localhost/api/tasks/lifecycle-parent/copy',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetConnectorInstanceId: 'local', keepTags: true }),
        },
      ), params);
      expect(copyResponse.status).toBe(201);
      const copiedId = ((await copyResponse.json()) as { id: string }).id;

      const result = await pool.query<{
        promoted_parent_id: string | null;
        normalized_tag_count: number;
        copy_tag_count: number;
      }>(`
        SELECT
          (SELECT parent_id FROM tasks WHERE id = $1) AS promoted_parent_id,
          (SELECT COUNT(*)::int FROM tags WHERE slug = 'needs-review') AS normalized_tag_count,
          (SELECT COUNT(*)::int FROM task_tags WHERE task_id = $2) AS copy_tag_count
      `, [subtaskId, copiedId]);
      expect(result.rows[0]).toEqual({
        promoted_parent_id: null,
        normalized_tag_count: 1,
        copy_tag_count: 1,
      });
      expect(sqliteTouch).not.toHaveBeenCalled();
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
  describe('task lifecycle routes with PostgreSQL task-core', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
