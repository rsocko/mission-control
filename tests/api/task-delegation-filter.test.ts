import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('task delegation filtering', () => {
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
    await db.delete(schema.agentDispatches);
    await db.delete(schema.externalAgents);
    await db.delete(schema.tasks);

    const now = '2026-08-05T12:00:00.000Z';
    await db.insert(schema.tasks).values([
      task('active-delegation', now),
      task('completed-delegation', now),
      task('undelegated', now),
    ]);
    await db.insert(schema.externalAgents).values([
      agent('copilot', 'Copilot', now),
      agent('scout', 'Scout', now),
    ]);
    await db.insert(schema.agentDispatches).values([
      dispatch('active-old', 'active-delegation', 'copilot', 'completed', '2026-08-05T12:01:00.000Z'),
      dispatch('active-latest', 'active-delegation', 'scout', 'in_progress', '2026-08-05T12:02:00.000Z'),
      dispatch('completed', 'completed-delegation', 'copilot', 'completed', '2026-08-05T12:03:00.000Z'),
    ]);
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  async function matchingIds(params: URLSearchParams): Promise<string[]> {
    const { conditions, quickFilterCondition } = await buildConditions(params);
    const query = db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(...conditions, quickFilterCondition));
    const rows = await query;
    return rows.map((row) => row.id).sort();
  }

  it('filters by the latest delegation status and delegatee', async () => {
    await expect(matchingIds(new URLSearchParams({
      filterQuery: 'delegation:active',
    }))).resolves.toEqual(['active-delegation']);
    await expect(matchingIds(new URLSearchParams({
      filterQuery: 'delegation:completed',
    }))).resolves.toEqual(['completed-delegation']);
    await expect(matchingIds(new URLSearchParams({
      filterQuery: 'delegatee:scout',
    }))).resolves.toEqual(['active-delegation']);
    await expect(matchingIds(new URLSearchParams({
      filterQuery: 'delegatee:copilot',
    }))).resolves.toEqual(['completed-delegation']);
  });

  it('supports delegation absence, negation, and the delegated quick filter', async () => {
    await expect(matchingIds(new URLSearchParams({
      filterQuery: 'delegation:none',
    }))).resolves.toEqual(['undelegated']);
    await expect(matchingIds(new URLSearchParams({
      filterQuery: '-delegation:active',
    }))).resolves.toEqual(['completed-delegation', 'undelegated']);
    await expect(matchingIds(new URLSearchParams({
      quickFilter: 'delegated',
    }))).resolves.toEqual(['active-delegation', 'completed-delegation']);
  });
});

function task(id: string, now: string) {
  return {
    id,
    sourceId: `source:${id}`,
    connectorType: 'custom-rest',
    connectorInstanceId: 'custom-rest-read-only',
    title: id,
    status: 'todo',
    priority: 'none',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

function agent(id: string, name: string, now: string) {
  return {
    id,
    name,
    type: 'pull-queue' as const,
    transport: 'pull' as const,
    executionLocality: 'remote' as const,
    authType: 'none' as const,
    dataPolicy: {
      allowedClassifications: ['standard' as const],
      fieldAllowlist: [],
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function dispatch(
  id: string,
  taskId: string,
  externalAgentId: string,
  status: 'completed' | 'in_progress',
  now: string,
) {
  return {
    id,
    externalAgentId,
    idempotencyKey: `key:${id}`,
    instruction: `Process ${taskId}`,
    scope: { taskIds: [taskId] },
    status,
    transport: 'pull' as const,
    executionLocality: 'remote' as const,
    dataClassification: 'standard' as const,
    allowedActions: [],
    disclosedFields: [],
    payloadPreview: {},
    previewHash: `hash:${id}`,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
