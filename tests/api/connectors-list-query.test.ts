import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');
vi.unmock('crypto');

let db: typeof import('@/db').default;
let connectorConfigs: typeof import('@/db/schema').connectorConfigs;
let sourceLists: typeof import('@/db/schema').sourceLists;
let syncLog: typeof import('@/db/schema').syncLog;
let tasks: typeof import('@/db/schema').tasks;
let GET: typeof import('@/app/api/connectors/route').GET;
let POST: typeof import('@/app/api/connectors/route').POST;
let PATCH: typeof import('@/app/api/connectors/route').PATCH;
let eq: typeof import('drizzle-orm').eq;

beforeAll(async () => {
  ({ default: db } = await importInitializedSqliteDatabase());
  ({ connectorConfigs, sourceLists, syncLog, tasks } = await import('@/db/schema'));
  ({ GET, POST, PATCH } = await import('@/app/api/connectors/route'));
  ({ eq } = await import('drizzle-orm'));

  await db.insert(connectorConfigs).values({
    id: 'connector-1',
    type: 'github-issues',
    name: 'GitHub',
    capabilities: {},
    settings: { repos: ['repo-1'] },
    credentials: { accessToken: 'invented-github-token' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  await db.insert(connectorConfigs).values({
    id: 'finance-existing',
    type: 'finance-manager',
    name: 'Tyrion',
    capabilities: {},
    credentials: { bridgeToken: 'invented-legacy-token' },
    settings: { bridgeUrl: 'https://legacy.invalid/v1/../capture', maxRetries: 1 },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  await db.insert(sourceLists).values({
    id: 'source-list-1',
    connectorInstanceId: 'connector-1',
    sourceId: 'repo-1',
    name: 'Repository',
    type: 'repo',
  });
  const taskDefaults = {
    connectorType: 'github-issues',
    connectorInstanceId: 'connector-1',
    priority: 'medium' as const,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastSyncedAt: '2026-08-01T00:00:00.000Z',
    sourceListId: 'repo-1',
  };
  await db.insert(tasks).values([
    {
      ...taskDefaults,
      id: 'task-1',
      sourceId: 'issue-1',
      title: 'Open issue',
      status: 'todo',
    },
    {
      ...taskDefaults,
      id: 'task-1-subtask',
      sourceId: 'issue-1-subtask',
      title: 'Open subtask',
      status: 'todo',
      parentId: 'task-1',
      depth: 1,
    },
    {
      ...taskDefaults,
      id: 'task-cancelled',
      sourceId: 'issue-cancelled',
      title: 'Cancelled issue',
      status: 'cancelled',
    },
  ]);
  await db.insert(syncLog).values([
    {
      id: 'sync-older',
      connectorId: 'connector-1',
      success: true,
      syncedAt: '2026-08-02T00:00:00.000Z',
    },
    {
      id: 'sync-newer',
      connectorId: 'connector-1',
      success: true,
      syncedAt: '2026-08-03T00:00:00.000Z',
    },
    {
      id: 'sync-failed',
      connectorId: 'connector-1',
      success: false,
      syncedAt: '2026-08-04T00:00:00.000Z',
    },
  ]);
}, 30_000);

describe('GET /api/connectors list queries', () => {
  it('returns top-level open task counts and only the latest successful sync', async () => {
    const response = await GET(new Request('http://localhost/api/connectors'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'connector-1',
        lastSyncedAt: '2026-08-03T00:00:00.000Z',
        credentials: {},
        hasCredentials: true,
      }),
      expect.objectContaining({
        id: 'finance-existing',
        credentials: {},
        hasCredentials: true,
        settings: { maxRetries: 1 },
      }),
    ]));
    expect(JSON.stringify(body.connectors)).not.toContain('invented-github-token');
    expect(JSON.stringify(body.connectors)).not.toContain('invented-legacy-token');
    expect(JSON.stringify(body.connectors)).not.toContain('legacy.invalid');
    expect(body.sourceLists).toEqual([
      expect.objectContaining({
        id: 'source-list-1',
        taskCount: 1,
        selectedForSync: true,
      }),
    ]);
  });

  it('persists canonical Tyrion bridge origins and tokens without secret round-trip', async () => {
    const createResponse = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'finance-new',
        type: 'finance-manager',
        name: 'Tyrion',
        credentials: { serviceToken: 'browser-create-token' },
        settings: {
          bridgeUrl: 'http://tyrion-monarch-bridge:8100/',
          householdCurrency: 'USD',
          apiToken: 'browser-settings-token',
          maxRetries: 2,
        },
      }),
    }));
    expect(createResponse.status).toBe(201);

    const [created] = await db.select().from(connectorConfigs)
      .where(eq(connectorConfigs.id, 'finance-new'));
    expect(created.credentials).toEqual({
      serviceToken: 'browser-create-token',
      identityNamespace: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(created.settings).toEqual({
      bridgeUrl: 'http://tyrion-monarch-bridge:8100',
      householdCurrency: 'USD',
      maxRetries: 2,
    });

    const updateResponse = await PATCH(new Request('http://localhost/api/connectors', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'finance-new',
        credentials: { bridgeToken: 'browser-update-token' },
        settings: {
          bridgeUrl: 'http://custom-tyrion-bridge:8100/',
          serviceToken: 'browser-settings-token',
          maxRetries: 3,
        },
      }),
    }));
    expect(updateResponse.status).toBe(200);

    const [updated] = await db.select().from(connectorConfigs)
      .where(eq(connectorConfigs.id, 'finance-new'));
    expect(updated.credentials).toEqual(created.credentials);
    expect(updated.settings).toEqual({
      bridgeUrl: 'http://custom-tyrion-bridge:8100',
      householdCurrency: 'USD',
      maxRetries: 3,
    });

    const publicResponse = await GET(new Request('http://localhost/api/connectors'));
    const publicBody = await publicResponse.json();
    expect(JSON.stringify(publicBody.connectors)).not.toContain('browser-create-token');
    expect(JSON.stringify(publicBody.connectors)).not.toContain('browser-update-token');
    expect(publicBody.connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'finance-new',
        credentials: {},
        hasCredentials: true,
        settings: {
          bridgeUrl: 'http://custom-tyrion-bridge:8100',
          householdCurrency: 'USD',
          maxRetries: 3,
        },
      }),
    ]));
  });

  it('rejects the Tyrion operations UI as a bridge origin', async () => {
    const response = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'finance-public-ui',
        type: 'finance-manager',
        name: 'Unsafe Tyrion',
        credentials: { serviceToken: 'invented-token' },
        settings: { bridgeUrl: 'https://tyrion.example' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('/api/connector/v1'),
    });
    const [persisted] = await db.select().from(connectorConfigs)
      .where(eq(connectorConfigs.id, 'finance-public-ui'));
    expect(persisted).toBeUndefined();
  });

  it('rejects connector type changes that could bypass finance sanitization', async () => {
    const response = await PATCH(new Request('http://localhost/api/connectors', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'connector-1',
        type: 'finance-manager',
        credentials: { serviceToken: 'bypass-token' },
        settings: { bridgeUrl: 'https://bypass.invalid' },
      }),
    }));

    expect(response.status).toBe(400);
    const [connector] = await db.select().from(connectorConfigs)
      .where(eq(connectorConfigs.id, 'connector-1'));
    expect(connector.type).toBe('github-issues');
  });
});
