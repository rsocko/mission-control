import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

describe('notification workflow action recovery', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let getNotifications: typeof import('@/app/api/notifications/route').GET;
  let webRepo: NotificationWebPersistence;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const dbModule = await import('@/db');
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    const schemaModule = await import('@/db/schema');
    schema = schemaModule;

    // Create a real web persistence from the SQLite DB and inject it
    const { createSqliteNotificationWebRepository } = await import(
      '@/db/persistence/sqlite-notification-web-repository'
    );
    webRepo = createSqliteNotificationWebRepository(sqlite);
    vi.doMock('@/lib/notifications/notification-web-service', () => ({
      getNotificationWebPersistence: () => Promise.resolve(webRepo),
    }));
    vi.resetModules();

    const routeModule = await import('@/app/api/notifications/route');
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

  it('atomically locks all mutating provider actions and restores them after failure', async () => {
      const now = new Date().toISOString();
      await db.insert(schema.notifications).values({
        id: 'ha-notification',
        sourceId: 'ha-source',
        connectorType: 'home-assistant',
        connectorInstanceId: 'ha-lake',
        title: 'Router update',
        level: 'heads_up',
        levelRank: 2,
        category: 'system',
        state: 'unread',
        isActionable: true,
        primaryActionId: 'ha-install',
        receivedAt: now,
        sortAt: now,
        metadata: {},
        presentation: {},
      });
      await db.insert(schema.notificationActions).values([
        {
          id: 'ha-install',
          notificationId: 'ha-notification',
          actionType: 'install_update',
          label: 'Install',
          variant: 'primary',
          isPrimary: true,
          sortOrder: 0,
          payload: {},
          createdBy: 'connector',
          requiresConfirmation: true,
        },
        {
          id: 'ha-skip',
          notificationId: 'ha-notification',
          actionType: 'skip_update',
          label: 'Skip',
          variant: 'secondary',
          isPrimary: false,
          sortOrder: 1,
          payload: {},
          createdBy: 'connector',
          requiresConfirmation: true,
        },
        {
          id: 'ha-open',
          notificationId: 'ha-notification',
          actionType: 'open_url',
          label: 'Open in Home Assistant',
          variant: 'secondary',
          isPrimary: false,
          sortOrder: 2,
          payload: {},
          createdBy: 'connector',
          requiresConfirmation: false,
        },
        {
          id: 'ha-task',
          notificationId: 'ha-notification',
          actionType: 'create_task',
          label: 'Create task',
          variant: 'ghost',
          isPrimary: false,
          sortOrder: 3,
          payload: {},
          createdBy: 'connector',
          requiresConfirmation: false,
        },
      ]);

      await expect(webRepo.claimProviderAction({
        notificationId: 'ha-notification',
        actionId: 'ha-install',
        claimedAt: now,
        recoveryCutoff: new Date(Date.now() - 5 * 60_000).toISOString(),
      })).resolves.toBe(true);
      await expect(webRepo.claimProviderAction({
        notificationId: 'ha-notification',
        actionId: 'ha-skip',
        claimedAt: now,
        recoveryCutoff: new Date(Date.now() - 5 * 60_000).toISOString(),
      })).resolves.toBe(false);
      const claimedActions = await db.select().from(schema.notificationActions);
      expect(claimedActions.find(action => action.id === 'ha-open')).toMatchObject({
        executionState: 'pending',
      });
      expect(claimedActions.find(action => action.id === 'ha-task')).toMatchObject({
        executionState: 'running',
      });

      await expect(webRepo.finalizeProviderAction({
        notificationId: 'ha-notification',
        claimedAt: now,
        now,
        success: false,
        error: 'Home Assistant rejected the request',
      })).resolves.toBe(true);

      const actions = await db.select().from(schema.notificationActions);
      const notificationRows = await db.select().from(schema.notifications);
      expect(actions.filter(action => action.notificationId === 'ha-notification'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'ha-install', executionState: 'pending' }),
          expect.objectContaining({ id: 'ha-skip', executionState: 'pending' }),
          expect.objectContaining({ id: 'ha-open', executionState: 'pending' }),
          expect.objectContaining({ id: 'ha-task', executionState: 'pending' }),
        ]));
      expect(notificationRows.find(item => item.id === 'ha-notification')).toMatchObject({
        isActionable: true,
        primaryActionId: 'ha-install',
    });
  });
});
