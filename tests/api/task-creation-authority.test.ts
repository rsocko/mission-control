import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('POST /api/tasks source authority', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let createTask: typeof import('@/app/api/tasks/route').POST;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.MC_MODE = 'demo';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const [dbModule, schemaModule, routeModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/tasks/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    createTask = routeModule.POST;
  });

  beforeEach(async () => {
    await db.delete(schema.taskTags);
    await db.delete(schema.taskProjects);
    await db.delete(schema.tasks);
    await db.delete(schema.connectorConfigs);
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
    delete process.env.MC_MODE;
  });

  async function insertConnector(
    id: string,
    type: string,
    capabilities: Record<string, unknown>,
    settings: Record<string, unknown>,
  ) {
    const now = new Date().toISOString();
    await db.insert(schema.connectorConfigs).values({
      id,
      type,
      name: id,
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 15,
      capabilities,
      credentials: {},
      settings,
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  function request(connectorType: string, connectorInstanceId?: string) {
    return new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Created task',
        connectorType,
        connectorInstanceId,
      }),
    });
  }

  it('allows create-only Custom REST destinations', async () => {
    await insertConnector(
      'custom-create-only',
      'custom-rest',
      { read: true, write: false, delete: false, sync: true },
      { createEndpoint: '/tasks' },
    );

    const response = await createTask(request('custom-rest'));

    expect(response.status).toBe(201);
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
  });

  it.each([
    'finance',
    'finance-manager',
    'monarch-money',
  ])('blocks the %s Finance alias despite stale creation capabilities', async (type) => {
    await insertConnector(
      `${type}-stale-caps`,
      type,
      { read: true, write: true, taskCreate: true, delete: false, sync: true },
      {},
    );

    const response = await createTask(request(type));

    expect(response.status).toBe(403);
    expect(await db.select().from(schema.tasks)).toEqual([]);
  });

  it('blocks task-producing connectors without a create implementation', async () => {
    await insertConnector(
      'document-intelligence-no-create',
      'document-intelligence',
      { read: true, write: true, delete: false, sync: true },
      {},
    );

    const response = await createTask(request('document-intelligence'));

    expect(response.status).toBe(403);
    expect(await db.select().from(schema.tasks)).toEqual([]);
  });

  it('requires and honors an instance ID when a connector type has multiple instances', async () => {
    await insertConnector(
      'custom-create-a',
      'custom-rest',
      { read: true, write: false, delete: false, sync: true },
      { createEndpoint: '/tasks-a' },
    );
    await insertConnector(
      'custom-create-b',
      'custom-rest',
      { read: true, write: false, delete: false, sync: true },
      { createEndpoint: '/tasks-b' },
    );

    const ambiguous = await createTask(request('custom-rest'));
    expect(ambiguous.status).toBe(400);

    const selected = await createTask(request('custom-rest', 'custom-create-b'));
    expect(selected.status).toBe(201);
    expect(await db.select().from(schema.tasks)).toEqual([
      expect.objectContaining({
        connectorType: 'custom-rest',
        connectorInstanceId: 'custom-create-b',
      }),
    ]);
  });

  it('rejects an instance ID from a different connector type', async () => {
    await insertConnector(
      'github-instance',
      'github-issues',
      { read: true, write: true, taskCreate: true, delete: true, sync: true },
      {},
    );

    const response = await createTask(request('custom-rest', 'github-instance'));

    expect(response.status).toBe(400);
    expect(await db.select().from(schema.tasks)).toEqual([]);
  });
});
