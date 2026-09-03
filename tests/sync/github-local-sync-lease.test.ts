import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import type { SourceList } from '@/types';

const NOW = '2026-08-10T16:00:00.000Z';

function sourceList(
  connectorId: string,
  sourceId: string,
  repositoryEvidence: ExternalIdentityEvidence['entity'],
): SourceList {
  return {
    id: `${connectorId}:repo:${sourceId}`,
    connectorInstanceId: connectorId,
    sourceId,
    name: sourceId,
    type: 'repo',
    taskCount: 0,
    lastSyncedAt: NOW,
    externalIdentity: { entity: repositoryEvidence },
  };
}

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
    db.insert(schema.connectorConfigs).values({
      id: 'local-sync-lease',
      type: 'github-issues',
      name: 'Local sync lease',
      capabilities: { read: true, write: true, sync: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: 'local-sync-lease',
      phase: 'complete',
      updatedAt: NOW,
    }).run();
    db.insert(schema.githubIdentityControls).values({
      connectorInstanceId: 'local-sync-lease',
      modeRevision: 1,
      updatedAt: NOW,
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
    const scheduler = new sync.SyncExecutionPipeline();
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
    expect(await identity.getGitHubIdentityStatus('local-sync-lease', { now: NOW }))
      .toMatchObject({ identity: { model: 'github_node_id', permanent: true } });

    releaseNotifications([]);
    await expect(running).resolves.toMatchObject({ success: true });
    expect(db.select().from(schema.connectorOperationLeases).all()).toEqual([]);
  }, 15_000);

  it('keeps a persisted source-list collision fail-closed on retry', async () => {
    const [{ default: db }, schema, sync, primaryIdentity] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/sync'),
      import('@/lib/external-identities/primary-identity'),
    ]);
    const connectorId = 'local-source-list-collision';
    db.insert(schema.connectorConfigs).values({
      id: connectorId,
      type: 'github-issues',
      name: 'Local source-list collision',
      capabilities: { read: true, write: true, sync: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    db.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: connectorId,
      phase: 'complete',
      updatedAt: NOW,
    }).run();
    db.insert(schema.githubIdentityControls).values({
      connectorInstanceId: connectorId,
      modeRevision: 1,
      updatedAt: NOW,
    }).run();
    const repositoryEvidence: ExternalIdentityEvidence['entity'] = {
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'repository',
        stableId: 'R_kgSYNTHETIC_COLLISION',
      },
      locator: {
        owner: 'synthetic-owner',
        repository: 'synthetic-repo',
      },
      observationSource: 'graphql',
      observedAt: NOW,
    };
    const sourceLists = [
      sourceList(connectorId, 'synthetic-owner/synthetic-repo', repositoryEvidence),
      sourceList(connectorId, 'synthetic-owner/synthetic-alias', repositoryEvidence),
    ];
    db.insert(schema.sourceLists).values(sourceLists.map((list) => ({
      id: list.id,
      connectorInstanceId: connectorId,
      sourceId: list.sourceId,
      name: list.name,
      type: list.type,
    }))).run();
    await primaryIdentity.persistGitHubPrimaryIdentityBatch(
      sourceLists.map((list) => ({
        target: {
          connectorInstanceId: connectorId,
          bindingType: 'source_list' as const,
          localId: list.id,
          legacyIdentity: list.sourceId,
        },
        evidence: { entity: repositoryEvidence },
      })),
      {
        connectorInstanceId: connectorId,
        effectiveMode: 'stable',
        modeRevision: 1,
        capturedAt: NOW,
      },
    );
    const connector = {
      id: connectorId,
      type: 'github-issues',
      displayName: 'Local source-list collision',
      capabilities: {
        read: true,
        write: true,
        sync: true,
        dependencyRead: false,
      },
      fetchNotifications: vi.fn(async () => []),
      fetchSourceLists: vi.fn(async () => sourceLists),
      async *fetchTasks() {
        yield [];
      },
    } as unknown as IConnector;
    const scheduler = new sync.SyncExecutionPipeline();
    const internal = scheduler as unknown as {
      initializeConnectorFromDb: (id: string) => Promise<IConnector | null>;
    };
    internal.initializeConnectorFromDb = vi.fn(async () => connector);

    const persistedCollisions = db.select()
      .from(schema.githubIdentityCollisions)
      .all();
    const first = await scheduler.runSyncLocally(connectorId, { full: true });
    const retry = await scheduler.runSyncLocally(connectorId, { full: true });

    expect(first.success).toBe(false);
    expect(persistedCollisions).toEqual([
      expect.objectContaining({
        connectorInstanceId: connectorId,
        bindingType: 'source_list',
        state: 'open',
      }),
    ]);
    expect(retry.success).toBe(false);
    expect(
      db.select({ success: schema.syncLog.success })
        .from(schema.syncLog)
        .all()
        .map((row) => row.success),
    ).toEqual([false, false]);
  }, 15_000);
});
