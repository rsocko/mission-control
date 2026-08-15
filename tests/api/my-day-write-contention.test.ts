import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const BUSY_TIMEOUT_MS = 1_000;

describe('GET /api/my-day under writer-lock contention', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mission-control-my-day-'));
  const databasePath = join(directory, 'my-day.db');
  const originalDatabasePath = process.env.MC_DB_PATH;
  const originalBusyTimeout = process.env.MC_DB_BUSY_TIMEOUT_MS;
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let getMyDay: typeof import('@/app/api/my-day/route').GET;

  function withHeldWriterLock<T>(callback: () => Promise<T>): Promise<T> {
    const holder = new Database(databasePath);
    holder.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare(
      "UPDATE tasks SET title = 'held' WHERE id = 'contention-holder'",
    ).run();
    return callback().finally(() => {
      holder.exec('COMMIT');
      holder.close();
    });
  }

  beforeAll(async () => {
    process.env.MC_DB_PATH = databasePath;
    process.env.MC_DB_BUSY_TIMEOUT_MS = String(BUSY_TIMEOUT_MS);
    vi.doUnmock('@/db');
    vi.doUnmock('@/db/schema');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const [dbModule, schemaModule, routeModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/my-day/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    getMyDay = routeModule.GET;

    const timestamp = '2026-08-05T16:00:00.000Z';
    const task = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      sourceId: `source-${id}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: id,
      status: 'todo',
      localDisposition: 'active' as const,
      priority: 'none',
      depth: 0,
      metadata: {},
      syncStatus: 'synced',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSyncedAt: timestamp,
      ...overrides,
    });

    await db.insert(schema.tasks).values([
      task('contention-holder'),
      task('planned-task'),
      task('completed-task', { status: 'done', completedAt: timestamp }),
    ]);
    await db.insert(schema.myDayItems).values({
      id: 'planned-item',
      taskId: 'planned-task',
      date: '2026-08-05',
      order: 1,
      addedAt: timestamp,
    });
  });

  afterAll(() => {
    sqlite.close();
    if (originalDatabasePath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDatabasePath;
    if (originalBusyTimeout === undefined) delete process.env.MC_DB_BUSY_TIMEOUT_MS;
    else process.env.MC_DB_BUSY_TIMEOUT_MS = originalBusyTimeout;
    rmSync(directory, { recursive: true, force: true });
  });

  it('serves the day while another connection owns the writer lock', async () => {
    const response = await withHeldWriterLock(() => getMyDay(new Request(
      'http://localhost/api/my-day?date=2026-08-05',
    )));
    const body = await response.json() as { items: Array<{ taskId: string }> };

    expect(response.status).toBe(200);
    expect(body.items.map((item) => item.taskId)).toEqual(['planned-task']);
    // The skipped auto-include is retried on the next uncontended request.
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM my_day_items WHERE task_id = 'completed-task'",
    ).get()).toEqual({ count: 0 });
  });

  it('auto-includes completed tasks once the writer lock is available', async () => {
    const response = await getMyDay(new Request(
      'http://localhost/api/my-day?date=2026-08-05',
    ));
    const body = await response.json() as { items: Array<{ taskId: string }> };

    expect(response.status).toBe(200);
    expect(body.items.map((item) => item.taskId).sort())
      .toEqual(['completed-task', 'planned-task']);
  });

  it('does not wait for the writer lock when there is nothing to auto-include', async () => {
    const startedAt = Date.now();
    const response = await withHeldWriterLock(() => getMyDay(new Request(
      'http://localhost/api/my-day?date=2026-08-05',
    )));

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(BUSY_TIMEOUT_MS);
  });
});
