import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import type { SourceTaskDependency } from '@/types';
import { bindGitHubTaskIdentities, githubIssueEvidence, mirrorFenceTargets } from '../fixtures/github-node-identity';

describe('task dependency reconciliation', () => {
  beforeAll(() => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  it('imports, retries, removes, and preserves dependencies by provenance', async () => {
    const [{ default: db, sqlite }, schema, manager, { eq }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/sync/task-dependency-manager'),
      import('drizzle-orm'),
    ]);
    const { connectorConfigs, tasks, taskDependencies } = schema;
    await db.insert(connectorConfigs).values({
      id: 'github-1',
      type: 'github-issues',
      name: 'GitHub',
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: true,
        lists: true,
        tags: true,
        tagWriteBack: true,
        dependencyRead: true,
        dependencyWrite: true,
      },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    const taskRows = Array.from({ length: 6 }, (_, index) => ({
      id: `task-${index + 1}`,
      sourceId: `acme/app:${index + 1}`,
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: `Task ${index + 1}`,
      isChecklistItem: false,
      metadata: { issueNumber: index + 1 },
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      lastSyncedAt: '2026-07-30T00:00:00.000Z',
    }));
    await db.insert(tasks).values(taskRows);
    // GitHub identity is permanently NodeID-only: without bound stable identity
    // nothing here resolves, and `source_id` alone is never sufficient.
    bindGitHubTaskIdentities(sqlite, 'github-1', taskRows.map((task, index) => ({
      taskId: task.id,
      owner: 'acme',
      repository: 'app',
      issueNumber: index + 1,
      issueStableId: `I_kwDOissue${index + 1}`,
      repositoryStableId: 'R_kgDOacmeapp',
    })));
    const connectorTaskQuery = db.select({ id: tasks.id }).from(tasks).where(
      eq(tasks.connectorInstanceId, 'github-1'),
    );
    expect(await connectorTaskQuery).toHaveLength(6);

    let remoteEdges: SourceTaskDependency[] = [{
      blockerSourceId: 'acme/app:1',
      blockedSourceId: 'acme/app:2',
    }];
    // `source_id` is only a locator, so every endpoint must also carry NodeID
    // evidence for the stable-only resolver to accept it.
    const evidenceFor = (sourceId: string) => githubIssueEvidence({
      issueStableId: `I_kwDOissue${sourceId.split(':')[1]}`,
      repositoryStableId: 'R_kgDOacmeapp',
      owner: 'acme',
      repository: 'app',
      issueNumber: Number(sourceId.split(':')[1]),
    });
    let completeBlockedSourceIds = taskRows.map((task) => task.sourceId);
    let failWrites = false;
    let failSnapshot = false;
    let snapshotCalls = 0;
    const connector: IConnector = {
      id: 'github-1',
      type: 'github-issues',
      displayName: 'GitHub',
      icon: 'github',
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: true,
        lists: true,
        tags: true,
        tagWriteBack: true,
        dependencyRead: true,
        dependencyWrite: true,
      },
      initialize: async () => undefined,
      testConnection: async () => ({ success: true, message: 'ok' }),
      dispose: async () => undefined,
      fetchTasks: async function* () { yield []; },
      fetchNotifications: async () => [],
      fetchSourceLists: async () => [],
      getLastSyncToken: async () => null,
      fetchTaskDependencies: async () => {
        snapshotCalls++;
        if (failSnapshot) throw new Error('snapshot failed');
        return {
          dependencies: remoteEdges.map((edge) => ({
            ...edge,
            blockerIdentityEvidence: evidenceFor(edge.blockerSourceId),
            blockerIdentityEvidenceState: 'verified' as const,
          })),
          completeBlockedSourceIds: [...completeBlockedSourceIds],
          blockedIdentityEvidence: completeBlockedSourceIds.map((sourceId) => ({
            sourceId,
            evidence: evidenceFor(sourceId),
            state: 'verified' as const,
          })),
        };
      },
      addTaskDependency: async (blockerSourceId, blockedSourceId) => {
        remoteEdges.push({ blockerSourceId, blockedSourceId });
      },
      removeTaskDependency: async (blockerSourceId, blockedSourceId) => {
        remoteEdges = remoteEdges.filter((edge) =>
          edge.blockerSourceId !== blockerSourceId
          || edge.blockedSourceId !== blockedSourceId);
      },
      preflightWriteRoute: async (route) => {
        if (failWrites) throw new Error('write denied');
        return { targets: mirrorFenceTargets(sqlite, route.leaseId) };
      },
      runAuthorizedWrite: async (_route, write) => write(),
    };

    const imported = await manager.reconcileTaskDependencies(
      'github-1',
      connector,
      { full: true },
    );
    expect(imported.imported).toBe(1);
    const [remoteBacked] = await db.select().from(taskDependencies).where(
      eq(taskDependencies.dependsOnTaskId, 'task-1'),
    );
    expect(remoteBacked).toMatchObject({
      taskId: 'task-2',
      connectorInstanceId: 'github-1',
      syncStatus: 'synced',
      syncAction: null,
    });

    const repeated = await manager.reconcileTaskDependencies(
      'github-1',
      connector,
      { full: true },
    );
    expect(repeated.imported).toBe(0);

    remoteEdges = [];
    completeBlockedSourceIds = completeBlockedSourceIds.filter(
      (sourceId) => sourceId !== 'acme/app:2',
    );
    const partial = await manager.reconcileTaskDependencies(
      'github-1',
      connector,
      { full: true },
    );
    expect(partial.removed).toBe(0);
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, remoteBacked.id),
    )).toHaveLength(1);

    await db.insert(taskDependencies).values({
      id: 'local-only',
      taskId: 'task-4',
      dependsOnTaskId: 'task-3',
      type: 'blocks',
      syncStatus: 'local',
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    completeBlockedSourceIds = taskRows.map((task) => task.sourceId);
    const removed = await manager.reconcileTaskDependencies(
      'github-1',
      connector,
      { full: true },
    );
    expect(removed.removed).toBe(1);
    const localOnly = await db.select().from(taskDependencies).where(
      eq(taskDependencies.dependsOnTaskId, 'task-3'),
    );
    expect(localOnly).toHaveLength(1);
    expect(localOnly[0].syncStatus).toBe('local');

    await db.insert(taskDependencies).values([
      {
        id: 'pending-create',
        taskId: 'task-6',
        dependsOnTaskId: 'task-5',
        type: 'blocks',
        connectorInstanceId: 'github-1',
        syncStatus: 'failed',
        syncAction: 'create',
        syncError: 'previous failure',
        createdAt: '2026-07-30T00:00:00.000Z',
      },
      {
        id: 'pending-delete',
        taskId: 'task-3',
        dependsOnTaskId: 'task-2',
        type: 'blocks',
        connectorInstanceId: 'github-1',
        syncStatus: 'failed',
        syncAction: 'delete',
        syncError: 'previous failure',
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    ]);
    remoteEdges = [{
      blockerSourceId: 'acme/app:2',
      blockedSourceId: 'acme/app:3',
    }];
    failWrites = true;
    const failed = await manager.reconcileTaskDependencies('github-1', connector);
    expect(failed.failed).toBe(2);
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.syncStatus, 'failed'),
    )).toHaveLength(2);

    failWrites = false;
    const retried = await manager.reconcileTaskDependencies('github-1', connector);
    expect(retried.pushed).toBe(2);
    const [created] = await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, 'pending-create'),
    );
    expect(created).toMatchObject({
      syncStatus: 'synced',
      syncAction: null,
      syncError: null,
    });
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, 'pending-delete'),
    )).toHaveLength(0);

    remoteEdges = [];
    await manager.reconcileTaskDependencies('github-1', connector, { full: true });
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, 'pending-create'),
    )).toHaveLength(0);
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.syncStatus, 'local'),
    )).toHaveLength(1);

    failSnapshot = true;
    await expect(manager.reconcileTaskDependencies(
      'github-1',
      connector,
      { full: true },
    )).rejects.toThrow('snapshot failed');
    failSnapshot = false;
    const callsBeforeRetry = snapshotCalls;
    await manager.reconcileTaskDependencies('github-1', connector);
    expect(snapshotCalls).toBe(callsBeforeRetry);

    await db.update(connectorConfigs).set({
      capabilities: {
        ...connector.capabilities,
        dependencyRead: false,
        dependencyWrite: true,
      },
    }).where(eq(connectorConfigs.id, 'github-1'));
    await db.insert(taskDependencies).values({
      id: 'write-only-retry',
      taskId: 'task-2',
      dependsOnTaskId: 'task-1',
      type: 'blocks',
      connectorInstanceId: 'github-1',
      syncStatus: 'failed',
      syncAction: 'create',
      syncError: 'previous failure',
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    const writeOnly = await manager.reconcileTaskDependencies('github-1', connector);
    expect(writeOnly.pushed).toBe(1);
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, 'write-only-retry'),
    )).toEqual([
      expect.objectContaining({ syncStatus: 'synced', syncAction: null }),
    ]);

    await db.insert(taskDependencies).values([
      {
        id: 'concurrent-retry-1',
        taskId: 'task-3',
        dependsOnTaskId: 'task-1',
        type: 'blocks',
        connectorInstanceId: 'github-1',
        syncStatus: 'failed',
        syncAction: 'create',
        createdAt: '2026-07-30T00:00:00.000Z',
      },
      {
        id: 'concurrent-retry-2',
        taskId: 'task-6',
        dependsOnTaskId: 'task-4',
        type: 'blocks',
        connectorInstanceId: 'github-1',
        syncStatus: 'failed',
        syncAction: 'create',
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    ]);
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const addTaskDependency = connector.addTaskDependency;
    connector.addTaskDependency = async (...args) => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        await addTaskDependency?.(...args);
      } finally {
        activeWrites--;
      }
    };
    await Promise.all([
      manager.reconcileTaskDependencies('github-1', connector),
      manager.reconcileTaskDependencies('github-1', connector),
    ]);
    expect(maxActiveWrites).toBe(1);
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.syncStatus, 'failed'),
    )).toHaveLength(0);

    const { connectorRegistry } = await import('@/lib/connectors');
    const registeredConnector = await connectorRegistry.createConnector({
      id: 'github-1',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'manual',
      capabilities: connector.capabilities,
      credentials: { token: 'test' },
      settings: { repos: ['acme/app'] },
      syncedLists: ['acme/app'],
    });
    let addCalls = 0;
    let releaseRemove = () => {};
    const removeStarted = new Promise<void>((resolve) => {
      registeredConnector.removeTaskDependency = async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseRemove = release;
        });
      };
    });
    registeredConnector.addTaskDependency = async () => {
      addCalls++;
    };
    registeredConnector.preflightWriteRoute = async (route) => ({
      targets: mirrorFenceTargets(sqlite, route.leaseId),
    });
    registeredConnector.runAuthorizedWrite = async (_route, write) => write();
    await db.insert(taskDependencies).values({
      id: 'create-delete-race',
      taskId: 'task-2',
      dependsOnTaskId: 'task-5',
      type: 'blocks',
      syncStatus: 'local',
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    const raceDependency = {
      id: 'create-delete-race',
      taskId: 'task-2',
      dependsOnTaskId: 'task-5',
      type: 'blocks' as const,
      connectorInstanceId: 'github-1',
      syncStatus: 'local' as const,
      syncAction: null,
      syncError: null,
      lastSyncedAt: null,
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    const blocker = taskRows[4];
    const blocked = taskRows[1];
    const removing = manager.removeTaskDependencyFromSource(
      raceDependency,
      blocker,
      blocked,
    );
    await removeStarted;
    const creating = manager.synchronizeCreatedTaskDependency(
      raceDependency,
      blocker,
      blocked,
    );
    releaseRemove();
    await Promise.all([removing, creating]);
    expect(addCalls).toBe(0);
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, 'create-delete-race'),
    )).toHaveLength(0);

    await db.insert(taskDependencies).values({
      id: 'missing-connector-retry',
      taskId: 'task-1',
      dependsOnTaskId: 'task-6',
      type: 'blocks',
      connectorInstanceId: 'github-1',
      syncStatus: 'failed',
      syncAction: 'create',
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    await db.delete(connectorConfigs).where(eq(connectorConfigs.id, 'github-1'));
    const writesBeforeMissingConnector = addCalls;

    expect(await manager.reconcileTaskDependencies('github-1', connector)).toEqual({
      imported: 0,
      removed: 0,
      pushed: 0,
      failed: 0,
    });
    expect(addCalls).toBe(writesBeforeMissingConnector);
    expect(await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, 'missing-connector-retry'),
    )).toEqual([
      expect.objectContaining({ syncStatus: 'failed', syncAction: 'create' }),
    ]);
  });
});
