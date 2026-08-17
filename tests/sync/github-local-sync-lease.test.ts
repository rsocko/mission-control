import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConnector } from '@/lib/connectors';

describe('local GitHub sync operation visibility', () => {
  beforeEach(() => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.LOG_LEVEL = 'silent';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MC_DB_PATH;
  });

  it('holds a durable sync lease until identity evidence is finalized', async () => {
    const [{ default: db }, schema, sync, identity] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/sync'),
      import('@/lib/external-identities'),
    ]);
    const now = '2026-08-10T16:00:00.000Z';
    db.insert(schema.connectorConfigs).values({
      id: 'local-sync-lease',
      type: 'github-issues',
      name: 'Local sync lease',
      capabilities: { read: true, write: true, sync: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: 'local-sync-lease',
      phase: 'complete',
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityControls).values({
      connectorInstanceId: 'local-sync-lease',
      modeRevision: 1,
      updatedAt: now,
    }).run();

    let releaseNotifications!: (value: []) => void;
    const notifications = new Promise<[]>((resolve) => {
      releaseNotifications = resolve;
    });
    const connector = {
      id: 'local-sync-lease',
      type: 'github-issues',
      displayName: 'Local sync lease',
      capabilities: {
        read: true,
        write: true,
        sync: true,
        dependencyRead: false,
      },
      fetchNotifications: vi.fn(() => notifications),
      fetchSourceLists: vi.fn(async () => []),
      async *fetchTasks() {
        yield [];
      },
    } as unknown as IConnector;
    const scheduler = new sync.SyncScheduler();
    const internal = scheduler as unknown as {
      initializeConnectorFromDb: (connectorId: string) => Promise<IConnector | null>;
    };
    internal.initializeConnectorFromDb = vi.fn(async () => connector);

    const running = scheduler.runSyncLocally('local-sync-lease', { full: true });
    await vi.waitFor(() => expect(connector.fetchNotifications).toHaveBeenCalled());
    expect(db.select().from(schema.connectorOperationLeases).all()).toEqual([
      expect.objectContaining({
        connectorId: 'local-sync-lease',
        operationType: 'sync',
      }),
    ]);
    expect(identity.getGitHubIdentityStatus('local-sync-lease', { now }))
      .toMatchObject({ identity: { model: 'github_node_id', permanent: true } });

    releaseNotifications([]);
    await expect(running).resolves.toMatchObject({ success: true });
    expect(db.select().from(schema.connectorOperationLeases).all()).toEqual([]);
  }, 15_000);
});
