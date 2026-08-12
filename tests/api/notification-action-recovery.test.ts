import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('notification workflow action recovery', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let getNotifications: typeof import('@/app/api/notifications/route').GET;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const [dbModule, schemaModule, routeModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/notifications/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    getNotifications = routeModule.GET;
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  it('restores a stale claimed primary action to the actionable queue', async () => {
    const now = new Date().toISOString();
    const staleClaim = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db.insert(schema.notifications).values({
      id: 'notification-1',
      sourceId: 'source-1',
      connectorType: 'n8n',
      connectorInstanceId: 'n8n-1',
      title: 'Run backup',
      level: 'action_needed',
      levelRank: 1,
      category: 'automation',
      state: 'unread',
      isActionable: false,
      primaryActionId: null,
      receivedAt: now,
      sortAt: now,
      metadata: {},
      presentation: {},
    });
    await db.insert(schema.notificationActions).values({
      id: 'action-1',
      notificationId: 'notification-1',
      actionType: 'run_workflow',
      label: 'Run backup',
      variant: 'primary',
      isPrimary: true,
      sortOrder: 0,
      payload: { workflowId: 'backup' },
      createdBy: 'connector',
      executionState: 'running',
      claimedAt: staleClaim,
    });

    const response = await getNotifications(new Request('http://localhost/api/notifications'));
    const body = await response.json();
    expect(body.notifications[0]).toMatchObject({
      id: 'notification-1',
      isActionable: true,
      primaryActionId: 'action-1',
      actions: [
        expect.objectContaining({
          id: 'action-1',
          executionState: 'pending',
          claimedAt: null,
        }),
      ],
    });

    const [persistedAction] = await db.select().from(schema.notificationActions);
    const [persistedNotification] = await db.select().from(schema.notifications);
    expect(persistedAction).toMatchObject({ executionState: 'pending', claimedAt: null });
    expect(persistedNotification).toMatchObject({
      isActionable: true,
      primaryActionId: 'action-1',
    });
  });
});
