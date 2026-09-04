import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-notification-writeback-'));
process.env.MC_DB_PATH = join(testDirectory, 'writebacks.db');

describe('notification writeback outbox', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let enqueue: typeof import('@/lib/notifications/notification-writeback').enqueueNotificationDismissalWritebacks;
  let dismissAndEnqueue: typeof import('@/lib/notifications/notification-writeback').dismissNotificationsAndEnqueueWritebacks;
  let mutateAndEnqueue: typeof import('@/lib/notifications/notification-writeback').mutateNotificationsAndEnqueueWritebacks;
  let wakeDispatcher: typeof import('@/lib/notifications/notification-writeback').wakeNotificationWritebackDispatcher;
  let dispatch: typeof import('@/lib/notifications/notification-writeback').dispatchNotificationWritebacks;
  let connectorRegistry: typeof import('@/lib/connectors').connectorRegistry;

  beforeAll(async () => {
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const database = await import('@/db');
    db = database.default;
    sqlite = database.sqlite;
    const schemaModule = await import('@/db/schema');
    schema = schemaModule;

    // Create a real web repository and mock the worker persistence
    const { createSqliteNotificationWebRepository } = await import(
      '@/db/persistence/sqlite-notification-web-repository'
    );
    const webRepo = createSqliteNotificationWebRepository(sqlite);
    vi.doMock('@/lib/persistence/worker-runtime', () => ({
      getWorkerPersistenceRepositories: () => Promise.resolve({
        notificationDelivery: { web: webRepo },
        connectors: { get: () => Promise.resolve(null) },
      }),
      assertPersistenceCompositionAccessAllowed: () => {},
    }));
    vi.resetModules();

    const [writeback, connectors] = await Promise.all([
      import('@/lib/notifications/notification-writeback'),
      import('@/lib/connectors'),
    ]);
    enqueue = writeback.enqueueNotificationDismissalWritebacks;
    dismissAndEnqueue = writeback.dismissNotificationsAndEnqueueWritebacks;
    mutateAndEnqueue = writeback.mutateNotificationsAndEnqueueWritebacks;
    wakeDispatcher = writeback.wakeNotificationWritebackDispatcher;
    dispatch = writeback.dispatchNotificationWritebacks;
    connectorRegistry = connectors.connectorRegistry;

    // Initialize the cached web persistence by calling resolveWeb
    await enqueue([]);

    const now = new Date().toISOString();
    await db.insert(schema.notifications).values({
      id: 'notification-1',
      sourceId: 'docintel:docintel-action-42',
      connectorType: 'document-intelligence',
      connectorInstanceId: 'docintel-1',
      title: 'Action required',
      receivedAt: now,
      sortAt: now,
    });
  });

  afterAll(() => {
    sqlite.close();
    rmSync(testDirectory, { recursive: true, force: true });
    delete process.env.MC_DB_PATH;
  });

  it('persists one idempotent pending job for replayed enqueue attempts', async () => {
    await expect(enqueue(['notification-1'])).resolves.toBe(1);
    await expect(enqueue(['notification-1'])).resolves.toBe(0);

    const jobs = sqlite.prepare(`
      SELECT status, source_id AS sourceId, attempt_count AS attemptCount
      FROM notification_writeback_jobs
    `).all();
    expect(jobs).toEqual([{
      status: 'pending',
      sourceId: 'action-42',
      attemptCount: 0,
    }]);
  });

  it('does not queue unknown notification IDs', async () => {
    await expect(enqueue(['missing'])).resolves.toBe(0);
  });

  it('requeues a terminally failed dismissal', async () => {
    sqlite.prepare(`
      UPDATE notification_writeback_jobs
      SET status = 'failed', attempt_count = max_attempts, completed_at = ?
      WHERE notification_id = ?
    `).run(new Date().toISOString(), 'notification-1');

    await expect(enqueue(['notification-1'])).resolves.toBe(1);
    const job = sqlite.prepare(`
      SELECT status, attempt_count AS attemptCount, completed_at AS completedAt
      FROM notification_writeback_jobs
      WHERE notification_id = ?
    `).get('notification-1');
    expect(job).toEqual({ status: 'pending', attemptCount: 0, completedAt: null });
  });

  it('wakes at lease expiry and recovers a stranded sending job', async () => {
    vi.useFakeTimers();
    const connector = {
      dismissAlert: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('@/lib/connectors').IConnector;
    const registrySpy = vi.spyOn(connectorRegistry, 'getConnector')
      .mockImplementation((id) => id === 'docintel-1' ? connector : undefined);
    try {
      const leaseExpiresAt = new Date(Date.now() + 1_000).toISOString();
      sqlite.prepare(`
        UPDATE notification_writeback_jobs
        SET status = 'sending', attempt_count = 1, lease_expires_at = ?
        WHERE notification_id = ?
      `).run(leaseExpiresAt, 'notification-1');

      wakeDispatcher();
      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.resolve();
      await Promise.resolve();

      const job = sqlite.prepare(`
        SELECT status, lease_expires_at AS leaseExpiresAt
        FROM notification_writeback_jobs
        WHERE notification_id = ?
      `).get('notification-1');
      expect(job).toEqual({ status: 'succeeded', leaseExpiresAt: null });
    } finally {
      registrySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('processes non-batch connectors one leased job at a time', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.notifications).values([
      {
        id: 'notification-serial-1',
        sourceId: 'serial:first',
        connectorType: 'serial-test',
        connectorInstanceId: 'serial-1',
        title: 'First serial dismissal',
        receivedAt: now,
        sortAt: now,
      },
      {
        id: 'notification-serial-2',
        sourceId: 'serial:second',
        connectorType: 'serial-test',
        connectorInstanceId: 'serial-1',
        title: 'Second serial dismissal',
        receivedAt: now,
        sortAt: now,
      },
    ]);
    await enqueue(['notification-serial-1', 'notification-serial-2']);
    const dismissAlert = vi.fn().mockResolvedValue(undefined);
    const connector: import('@/lib/connectors').IConnector = {
      id: 'serial-1',
      type: 'serial-test',
      displayName: 'Serial test',
      icon: 'test',
      capabilities: { read: true, write: true } as import('@/types').ConnectorCapabilities,
      initialize: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      dispose: vi.fn().mockResolvedValue(undefined),
      fetchTasks: async function* () {},
      fetchNotifications: vi.fn().mockResolvedValue([]),
      fetchSourceLists: vi.fn().mockResolvedValue([]),
      dismissAlert,
    };
    const registrySpy = vi.spyOn(connectorRegistry, 'getConnector')
      .mockImplementation((id) => id === 'serial-1' ? connector : undefined);

    try {
      await dispatch();
    } finally {
      registrySpy.mockRestore();
    }

    expect(dismissAlert.mock.calls).toEqual([['first'], ['second']]);
    const jobs = sqlite.prepare(`
      SELECT status, attempt_count AS attemptCount
      FROM notification_writeback_jobs
      WHERE connector_instance_id = ?
      ORDER BY source_id
    `).all('serial-1');
    expect(jobs).toEqual([
      { status: 'succeeded', attemptCount: 1 },
      { status: 'succeeded', attemptCount: 1 },
    ]);
  });

  it('keeps synchronization settled when an already-succeeded dismissal is repeated', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.notifications).values({
      id: 'notification-repeat',
      sourceId: 'docintel:docintel-action-repeat',
      connectorType: 'document-intelligence',
      connectorInstanceId: 'docintel-1',
      title: 'Already dismissed',
      receivedAt: now,
      sortAt: now,
    });
    expect(dismissAndEnqueue(['notification-repeat'], now).queuedCount).toBe(1);
    sqlite.prepare(`
      UPDATE notification_writeback_jobs
      SET status = 'succeeded', completed_at = ?
      WHERE notification_id = 'notification-repeat'
    `).run(now);
    sqlite.prepare(`
      UPDATE notifications SET sync_state = 'synced'
      WHERE id = 'notification-repeat'
    `).run();

    expect(dismissAndEnqueue(['notification-repeat'], now).queuedCount).toBe(0);
    const notification = sqlite.prepare(`
      SELECT sync_state AS syncState
      FROM notifications
      WHERE id = 'notification-repeat'
    `).get();
    expect(notification).toEqual({ syncState: 'synced' });
  });

  it('rolls back the local dismissal when outbox persistence fails', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.notifications).values({
      id: 'notification-2',
      sourceId: 'docintel:docintel-action-99',
      connectorType: 'document-intelligence',
      connectorInstanceId: 'docintel-1',
      title: 'Must remain unread',
      receivedAt: now,
      sortAt: now,
    });
    sqlite.exec(`
      CREATE TRIGGER fail_notification_writeback
      BEFORE INSERT ON notification_writeback_jobs
      WHEN NEW.notification_id = 'notification-2'
      BEGIN
        SELECT RAISE(ABORT, 'simulated outbox failure');
      END
    `);

    expect(() => dismissAndEnqueue(['notification-2'], now)).toThrow(/simulated outbox failure/);
    const notification = sqlite.prepare(
      'SELECT state, dismissed_at AS dismissedAt FROM notifications WHERE id = ?',
    ).get('notification-2');
    expect(notification).toEqual({ state: 'unread', dismissedAt: null });
  });

  it('atomically maps read, handle, mute, and unmute into typed GitHub jobs', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.notifications).values([
      {
        id: 'github-read',
        sourceId: 'github-instance:gh-notif-10',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-instance',
        title: 'Read me',
        receivedAt: now,
        sortAt: now,
      },
      {
        id: 'github-handle',
        sourceId: 'github-instance:gh-notif-11',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-instance',
        title: 'Handle me',
        receivedAt: now,
        sortAt: now,
        lastSourceActivityKey: '11:v1',
      },
      {
        id: 'github-mute',
        sourceId: 'github-instance:gh-notif-12',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-instance',
        title: 'Mute me',
        receivedAt: now,
        sortAt: now,
      },
    ]);

    expect(await mutateAndEnqueue(['github-read'], 'mark_read', now)).toMatchObject({
      updatedCount: 1,
      queuedCount: 1,
    });
    expect(await mutateAndEnqueue(['github-read'], 'mark_read', now)).toMatchObject({
      updatedCount: 1,
      queuedCount: 0,
    });
    expect(await mutateAndEnqueue(['github-handle'], 'mark_done', now)).toMatchObject({
      updatedCount: 1,
      queuedCount: 1,
    });
    expect(await mutateAndEnqueue(['github-mute'], 'mute', now)).toMatchObject({
      updatedCount: 1,
      queuedCount: 1,
    });
    const unmutedAt = now;
    expect(await mutateAndEnqueue(['github-mute'], 'unmute', unmutedAt)).toMatchObject({
      updatedCount: 1,
      queuedCount: 1,
    });

    expect(sqlite.prepare(`
      SELECT id, read_state AS readState, disposition, muted_at AS mutedAt,
        sync_state AS syncState, handled_source_activity_key AS handledActivity
      FROM notifications
      WHERE id IN ('github-read', 'github-handle', 'github-mute')
      ORDER BY id
    `).all()).toEqual([
      {
        id: 'github-handle',
        readState: 'unread',
        disposition: 'handled',
        mutedAt: null,
        syncState: 'pending',
        handledActivity: '11:v1',
      },
      {
        id: 'github-mute',
        readState: 'read',
        disposition: 'inbox',
        mutedAt: null,
        syncState: 'pending',
        handledActivity: null,
      },
      {
        id: 'github-read',
        readState: 'read',
        disposition: 'inbox',
        mutedAt: null,
        syncState: 'pending',
        handledActivity: null,
      },
    ]);
    expect(sqlite.prepare(`
      SELECT action_type AS action, source_id AS sourceId, status
      FROM notification_writeback_jobs
      WHERE connector_instance_id = 'github-instance'
      ORDER BY action_type
    `).all()).toEqual([
      { action: 'mark_done', sourceId: 'gh-notif-11', status: 'pending' },
      { action: 'mark_read', sourceId: 'gh-notif-10', status: 'pending' },
      { action: 'mute', sourceId: 'gh-notif-12', status: 'superseded' },
      { action: 'unmute', sourceId: 'gh-notif-12', status: 'pending' },
    ]);
  });

  it('retains independent GitHub actions and skips unsupported connector handles', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.notifications).values([
      {
        id: 'github-independent',
        sourceId: 'github-instance:gh-notif-13',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-instance',
        title: 'Independent actions',
        receivedAt: now,
        sortAt: now,
      },
      {
        id: 'local-handle',
        sourceId: 'local:14',
        connectorType: 'local-only',
        connectorInstanceId: 'local-instance',
        title: 'Local handle',
        receivedAt: now,
        sortAt: now,
      },
    ]);

    await mutateAndEnqueue(['github-independent'], 'mark_read', now);
    await mutateAndEnqueue(
      ['github-independent'],
      'mark_done',
      new Date(Date.parse(now) + 1).toISOString(),
    );
    const localResult = await mutateAndEnqueue(['local-handle'], 'mark_done', now);

    expect(sqlite.prepare(`
      SELECT action_type AS action, status
      FROM notification_writeback_jobs
      WHERE notification_id = 'github-independent'
      ORDER BY rowid
    `).all()).toEqual([
      { action: 'mark_read', status: 'pending' },
      { action: 'mark_done', status: 'pending' },
    ]);
    expect(localResult).toMatchObject({
      updatedCount: 1,
      queuedCount: 0,
      results: [{
        id: 'local-handle',
        localStatus: 'updated',
        writebackStatus: 'not_required',
      }],
    });
    expect(sqlite.prepare(`
      SELECT sync_state AS syncState
      FROM notifications
      WHERE id = 'local-handle'
    `).get()).toEqual({ syncState: 'synced' });
  });

  it('dispatches typed actions with the matching connector instance only', async () => {
    const writeNotificationAction = vi.fn().mockResolvedValue(undefined);
    const connector: import('@/lib/connectors').IConnector = {
      id: 'github-instance',
      type: 'github-issues',
      displayName: 'GitHub',
      icon: 'github',
      capabilities: { read: true, write: true } as import('@/types').ConnectorCapabilities,
      initialize: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      dispose: vi.fn().mockResolvedValue(undefined),
      fetchTasks: async function* () {},
      fetchNotifications: vi.fn().mockResolvedValue([]),
      fetchSourceLists: vi.fn().mockResolvedValue([]),
      writeNotificationAction,
    };
    const registrySpy = vi.spyOn(connectorRegistry, 'getConnector')
      .mockImplementation((id) => id === connector.id ? connector : undefined);
    try {
      await dispatch();
    } finally {
      registrySpy.mockRestore();
    }

    expect(writeNotificationAction.mock.calls.map((call) => call.slice(0, 2)))
      .toEqual(expect.arrayContaining([
      ['gh-notif-10', 'mark_read'],
      ['gh-notif-11', 'mark_done'],
      ['gh-notif-12', 'unmute'],
      ]));
    expect(writeNotificationAction.mock.calls.map((call) => call.slice(0, 2)))
      .not.toContainEqual(['gh-notif-12', 'mute']);
    expect(writeNotificationAction.mock.calls.every((call) =>
      call[0].startsWith('gh-notif-'))).toBe(true);
  });

  it('surfaces terminal provider failures without reverting local disposition', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.notifications).values({
      id: 'github-auth-failure',
      sourceId: 'github-failure:gh-notif-99',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-failure',
      title: 'Authentication failure',
      receivedAt: now,
      sortAt: now,
    });
    await mutateAndEnqueue(['github-auth-failure'], 'mark_done', now);
    const { ConnectorWritebackError } = await import('@/lib/connectors');
    const connector: import('@/lib/connectors').IConnector = {
      id: 'github-failure',
      type: 'github-issues',
      displayName: 'GitHub',
      icon: 'github',
      capabilities: { read: true, write: true } as import('@/types').ConnectorCapabilities,
      initialize: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      dispose: vi.fn().mockResolvedValue(undefined),
      fetchTasks: async function* () {},
      fetchNotifications: vi.fn().mockResolvedValue([]),
      fetchSourceLists: vi.fn().mockResolvedValue([]),
      writeNotificationAction: vi.fn().mockRejectedValue(
        new ConnectorWritebackError('HTTP 401', false, undefined, 401),
      ),
    };
    const registrySpy = vi.spyOn(connectorRegistry, 'getConnector')
      .mockImplementation((id) => id === connector.id ? connector : undefined);
    try {
      await dispatch();
    } finally {
      registrySpy.mockRestore();
    }

    expect(sqlite.prepare(`
      SELECT disposition, sync_state AS syncState
      FROM notifications WHERE id = 'github-auth-failure'
    `).get()).toEqual({ disposition: 'handled', syncState: 'failed' });
    expect(sqlite.prepare(`
      SELECT status, retryable, attempt_count AS attemptCount
      FROM notification_writeback_jobs
      WHERE notification_id = 'github-auth-failure'
    `).get()).toEqual({ status: 'failed', retryable: 0, attemptCount: 1 });
  });

  it('does not dispatch a job whose copied connector identity mismatches its notification', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.notifications).values({
      id: 'github-isolated',
      sourceId: 'github-a:gh-notif-100',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-a',
      title: 'Isolated',
      receivedAt: now,
      sortAt: now,
    });
    await mutateAndEnqueue(['github-isolated'], 'mark_read', now);
    sqlite.prepare(`
      UPDATE notification_writeback_jobs
      SET connector_instance_id = 'github-b'
      WHERE notification_id = 'github-isolated'
    `).run();
    const writeNotificationAction = vi.fn();
    const registrySpy = vi.spyOn(connectorRegistry, 'getConnector')
      .mockReturnValue({
        id: 'github-b',
        type: 'github-issues',
        displayName: 'GitHub B',
        icon: 'github',
        capabilities: { read: true, write: true } as import('@/types').ConnectorCapabilities,
        initialize: vi.fn(),
        testConnection: vi.fn(),
        dispose: vi.fn(),
        fetchTasks: async function* () {},
        fetchNotifications: vi.fn(),
        fetchSourceLists: vi.fn(),
        writeNotificationAction,
      });
    try {
      await dispatch();
    } finally {
      registrySpy.mockRestore();
    }
    expect(writeNotificationAction).not.toHaveBeenCalled();
  });
});
