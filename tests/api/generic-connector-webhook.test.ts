import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('generic connector webhooks', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let receive: typeof import('@/app/api/webhooks/[connectorId]/route').POST;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    // The route now resolves its persistence through the worker composition, so
    // the SQLite composition must be registered before the handler runs.
    const dbModule = await importInitializedSqliteDatabase();
    const [schemaModule, routeModule] = await Promise.all([
      import('@/db/schema'),
      import('@/app/api/webhooks/[connectorId]/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    receive = routeModule.POST;
  });

  beforeEach(async () => {
    await db.delete(schema.tasks);
    await db.delete(schema.notificationActions);
    await db.delete(schema.notifications);
    await db.delete(schema.syncLog);
    await db.delete(schema.connectorConfigs);
    const now = new Date().toISOString();
    await db.insert(schema.connectorConfigs).values({
      id: 'custom-rest-webhook',
      type: 'custom-rest',
      name: 'Custom REST webhook',
      enabled: true,
      syncMode: 'webhook',
      pollIntervalMinutes: null,
      capabilities: {},
      credentials: {},
      settings: {
        notificationTemplateKeyField: 'event_kind',
      },
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    sqlite.close();
    await (await import('@/db/runtime')).shutdownRuntimeDatabase();
    delete process.env.MC_DB_PATH;
  });

  it('persists the configured notification type key without trusting payload eligibility', async () => {
    const response = await receive(new Request(
      'http://localhost/api/webhooks/custom-rest-webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'door-42',
          severity: 'high',
          message: 'Garage door open',
          event_kind: 'door_open',
          pushEligible: true,
        }),
      },
    ), {
      params: Promise.resolve({ connectorId: 'custom-rest-webhook' }),
    });

    expect(response.status).toBe(200);
    const [notification] = await db.select().from(schema.notifications);
    expect(notification).toMatchObject({
      sourceId: 'webhook:door-42',
      connectorInstanceId: 'custom-rest-webhook',
      templateKey: 'door_open',
    });
  });

  it('preserves local disposition when a Microsoft task refresh arrives', async () => {
    await db.delete(schema.connectorConfigs);
    const now = new Date().toISOString();
    await db.insert(schema.connectorConfigs).values({
      id: 'microsoft-webhook',
      type: 'microsoft-todo',
      name: 'Microsoft Todo webhook',
      enabled: true,
      syncMode: 'webhook',
      pollIntervalMinutes: null,
      capabilities: {},
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.tasks).values({
      id: 'task-handled',
      sourceId: 'mstodo:graph-task-1',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'microsoft-webhook',
      title: 'Handled task',
      status: 'todo',
      localDisposition: 'handled',
      priority: 'none',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });

    const response = await receive(new Request(
      'http://localhost/api/webhooks/microsoft-webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: [{
            changeType: 'updated',
            resourceData: { id: 'graph-task-1', title: 'Remote refresh' },
          }],
        }),
      },
    ), {
      params: Promise.resolve({ connectorId: 'microsoft-webhook' }),
    });

    expect(response.status).toBe(200);
    const [task] = await db.select().from(schema.tasks);
    expect(task.localDisposition).toBe('handled');
  });

  it('does not ingest tasks from notification-only connectors', async () => {
    await db.delete(schema.connectorConfigs);
    const now = new Date().toISOString();
    await db.insert(schema.connectorConfigs).values({
      id: 'monarch-webhook',
      type: 'monarch-money',
      name: 'Monarch webhook',
      enabled: true,
      syncMode: 'webhook',
      pollIntervalMinutes: null,
      capabilities: { read: true, write: true, taskCreate: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });

    const response = await receive(new Request(
      'http://localhost/api/webhooks/monarch-webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'budget-alert-1',
          title: 'Budget exceeded',
          severity: 'high',
        }),
      },
    ), {
      params: Promise.resolve({ connectorId: 'monarch-webhook' }),
    });

    expect(response.status).toBe(200);
    expect(await db.select().from(schema.tasks)).toEqual([]);
    expect(await db.select().from(schema.notifications)).toHaveLength(1);
  });
});
