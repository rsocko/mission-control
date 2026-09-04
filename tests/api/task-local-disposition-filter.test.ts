import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('task local disposition filtering', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let buildConditions: typeof import('@/app/api/tasks/canonical-filter').buildCanonicalTaskFilterConditions;
  let and: typeof import('drizzle-orm').and;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [dbModule, schemaModule, filterModule, drizzle] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/app/api/tasks/canonical-filter'),
      import('drizzle-orm'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    buildConditions = filterModule.buildCanonicalTaskFilterConditions;
    and = drizzle.and;
  });

  beforeEach(async () => {
    await db.delete(schema.myDayItems);
    await db.delete(schema.tasks);
    const now = '2026-08-05T12:00:00.000Z';
    await db.insert(schema.tasks).values([
      task('active-task', 'active', now),
      task('handled-task', 'handled', now),
      task('dismissed-task', 'dismissed', now),
      task('legacy-notification-task', 'active', now, 'monarch-money'),
    ]);
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  async function matchingIds(params: URLSearchParams): Promise<string[]> {
    const { conditions } = await buildConditions(params);
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(...conditions));
    return rows.map((row) => row.id).sort();
  }

  it('shows active tasks by default and supports explicit disposition slices', async () => {
    await expect(matchingIds(new URLSearchParams())).resolves.toEqual(['active-task']);
    await expect(matchingIds(new URLSearchParams({
      localDisposition: 'handled',
    }))).resolves.toEqual(['handled-task']);
    await expect(matchingIds(new URLSearchParams({
      localDispositions: 'handled,dismissed',
    }))).resolves.toEqual(['dismissed-task', 'handled-task']);
    await expect(matchingIds(new URLSearchParams({
      localDisposition: 'all',
    }))).resolves.toEqual(['active-task', 'dismissed-task', 'handled-task']);
  });

  it('lets structured disposition queries override the active default', async () => {
    await expect(matchingIds(new URLSearchParams({
      filterQuery: 'disposition:dismissed',
    }))).resolves.toEqual(['dismissed-task']);
    await expect(matchingIds(new URLSearchParams({
      filterQuery: 'disposition:not-a-value',
    }))).resolves.toEqual([]);
    await expect(matchingIds(new URLSearchParams({
      filterQuery: '-disposition:dismissed',
    }))).resolves.toEqual(['active-task', 'handled-task']);
  });
});

function task(
  id: string,
  localDisposition: 'active' | 'handled' | 'dismissed',
  now: string,
  connectorType = 'custom-rest',
) {
  return {
    id,
    sourceId: `source:${id}`,
    connectorType,
    connectorInstanceId: 'custom-rest-read-only',
    title: id,
    status: 'todo',
    localDisposition,
    priority: 'none',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}
