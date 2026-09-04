import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');
vi.mock('@/db', () => {
  throw new Error('SQLite must not be evaluated by PostgreSQL connector-domain routes');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalClientId = process.env.MS_CLIENT_ID;
const originalPublicDemo = process.env.MC_PUBLIC_DEMO;
const connectorId = `l12a-domain-${randomUUID()}`;
const todoConnectorId = `l12a-todo-${randomUUID()}`;
const todoListId = `l12a-list-${randomUUID()}`;

describePostgres('PostgreSQL connector-domain route composition', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_POSTGRES_URL = connectionString!;
    process.env.MS_CLIENT_ID = 'l12a-test-client';
    const { initializeDatabaseWithRetry } = await import('@/db/startup');
    await initializeDatabaseWithRetry();
  }, 120_000);

  afterAll(async () => {
    const { getWorkerPersistenceRepositories } = await import(
      '@/lib/persistence/worker-runtime'
    );
    const management = (await getWorkerPersistenceRepositories()).execution.management;
    await management.hardDeleteConnector(connectorId);
    await management.hardDeleteConnector(todoConnectorId);
    const { shutdownRuntimeDatabase } = await import('@/db/runtime');
    await shutdownRuntimeDatabase();
    if (originalBackend === undefined) delete process.env.MC_DATABASE_BACKEND;
    else process.env.MC_DATABASE_BACKEND = originalBackend;
    if (originalPostgresUrl === undefined) delete process.env.MC_POSTGRES_URL;
    else process.env.MC_POSTGRES_URL = originalPostgresUrl;
    if (originalClientId === undefined) delete process.env.MS_CLIENT_ID;
    else process.env.MS_CLIENT_ID = originalClientId;
    if (originalPublicDemo === undefined) delete process.env.MC_PUBLIC_DEMO;
    else process.env.MC_PUBLIC_DEMO = originalPublicDemo;
  });

  it('imports all ten migrated route modules without evaluating SQLite', async () => {
    const modules = await Promise.all([
      import('@/app/api/auth/microsoft/connect/route'),
      import('@/app/api/calendar-events/route'),
      import('@/app/api/connectors/[id]/label-normalize/route'),
      import('@/app/api/connectors/[id]/label-scan/route'),
      import('@/app/api/connectors/[id]/lists/route'),
      import('@/app/api/connectors/[id]/permissions/route'),
      import('@/app/api/connectors/[id]/validate-repo/route'),
      import('@/app/api/connectors/github-repos/route'),
      import('@/app/api/source-lists/[id]/fix-emoji/route'),
      import('@/app/api/sync/health/route'),
    ]);

    expect(modules).toHaveLength(10);
  });

  it('creates and reads an OAuth connector through PostgreSQL composition', async () => {
    const { GET } = await import('@/app/api/auth/microsoft/connect/route');
    const response = await GET(new Request(
      `http://localhost/api/auth/microsoft/connect?instanceId=${connectorId}&connectorType=outlook-calendar`,
    ));
    expect(response.status).toBe(307);

    const { getWorkerPersistenceRepositories } = await import(
      '@/lib/persistence/worker-runtime'
    );
    const management = (await getWorkerPersistenceRepositories()).execution.management;
    await expect(management.getConnector(connectorId)).resolves.toMatchObject({
      id: connectorId,
      type: 'outlook-calendar',
      enabled: true,
      credentials: {},
      settings: { accountType: 'personal' },
    });
    await expect(management.listActiveConnectorsByType('outlook-calendar'))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: connectorId }),
      ]));
  });

  it('executes connector projections, sync health, and emoji guards through PostgreSQL', async () => {
    const { getWorkerPersistenceRepositories } = await import(
      '@/lib/persistence/worker-runtime'
    );
    const management = (await getWorkerPersistenceRepositories()).execution.management;
    await management.createConnector({
      id: todoConnectorId,
      type: 'microsoft-todo',
      name: 'L12a To Do',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      now: '2026-09-04T00:00:00.000Z',
    });
    await management.ensureSourceLists([{
      id: todoListId,
      connectorInstanceId: todoConnectorId,
      sourceId: 'remote-l12a-list',
      name: '😀 L12a List',
      type: 'list',
      taskCount: 0,
      lastSyncedAt: null,
      sortOrder: 0,
      hidden: false,
      icon: null,
      iconColor: null,
    }]);

    const { GET: getLists } = await import('@/app/api/connectors/[id]/lists/route');
    const listsResponse = await getLists(
      new Request('http://localhost/api/connectors/lists'),
      { params: Promise.resolve({ id: todoConnectorId }) },
    );
    expect(listsResponse.status).toBe(200);
    await expect(listsResponse.json()).resolves.toMatchObject({
      sourceLists: [{ id: todoListId, name: '😀 L12a List' }],
    });

    process.env.MC_PUBLIC_DEMO = 'true';
    const { GET: getHealth } = await import('@/app/api/sync/health/route');
    const healthResponse = await getHealth();
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      graphApiEmojiIssue: {
        affectedLists: expect.arrayContaining([
          expect.objectContaining({ id: todoListId }),
        ]),
      },
    });

    const { POST: fixEmoji } = await import('@/app/api/source-lists/[id]/fix-emoji/route');
    const emojiResponse = await fixEmoji(
      new Request('http://localhost/api/source-lists/fix-emoji', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'strip-emoji' }),
      }),
      { params: Promise.resolve({ id: todoListId }) },
    );
    expect(emojiResponse.status).toBe(503);
    await expect(emojiResponse.json()).resolves.toEqual({
      error: 'Connector not initialized. Try syncing first.',
    });
  });
});
