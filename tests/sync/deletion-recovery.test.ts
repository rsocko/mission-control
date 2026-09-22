import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import type { IConnector } from '@/lib/connectors';

describe('sync deletion recovery', () => {
  beforeEach(() => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.MC_MODE = 'live';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MC_MODE;
  });

  async function setupTask(sourceId = 'remote:missing') {
    const [{ default: db }, schema] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
    ]);
    const now = '2026-08-03T12:00:00.000Z';
    await db.insert(schema.tasks).values({
      id: 'task-1',
      sourceId,
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'connector-1',
      title: 'Recover me',
      description: 'Preserve this description',
      status: 'todo',
      priority: 'high',
      createdAt: now,
      updatedAt: now,
      metadata: {},
      syncStatus: 'synced',
      lastSyncedAt: now,
    });
    await db.insert(schema.taskTags).values({ taskId: 'task-1', tagId: 'tag-1' });
    return { db, schema };
  }

  it('quarantines once, archives on the second full sync, and restores locally', async () => {
    const { db, schema } = await setupTask();
    const [{ detectDeletions }, { restoreDeletionSnapshot }] = await Promise.all([
      import('@/lib/sync/deletion-detector'),
      import('@/lib/sync/deletion-recovery'),
    ]);
    expect(await db.select().from(schema.syncDeletionCandidates)).toEqual([]);
    expect(await db.select().from(schema.tasks)).toHaveLength(1);

    const firstAudit: Array<{
      action: 'added' | 'updated' | 'removed' | 'pushed' | 'push_failed' | 'protected' | 'conflict_resolved' | 'skipped';
      taskTitle: string;
      taskSourceId: string;
      taskId?: string;
      deletionSnapshotId?: string;
      reason?: string;
    }> = [];
    const first = await detectDeletions(
      'connector-1',
      new Set(['remote:still-present']),
      true,
      firstAudit,
      [{
        id: 'task-1',
        sourceId: 'remote:missing',
        sourceListId: null,
        syncStatus: 'synced',
        status: 'todo',
        title: 'Recover me',
        isChecklistItem: false,
        parentId: null,
        metadata: {},
      }],
    );

    expect(first.removed).toBe(0);
    expect(firstAudit).toContainEqual(expect.objectContaining({
      action: 'protected',
      taskId: 'task-1',
      reason: expect.stringContaining('quarantined'),
    }));
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
    expect(await db.select().from(schema.syncDeletionCandidates)).toHaveLength(1);

    const secondAudit: typeof firstAudit = [];
    const second = await detectDeletions(
      'connector-1',
      new Set(['remote:still-present']),
      true,
      secondAudit,
      [{
        id: 'task-1',
        sourceId: 'remote:missing',
        sourceListId: null,
        syncStatus: 'synced',
        status: 'todo',
        title: 'Recover me',
        isChecklistItem: false,
        parentId: null,
        metadata: {},
      }],
    );

    expect(second.removed).toBe(1);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
    const [snapshot] = await db.select().from(schema.syncDeletionSnapshots);
    expect(snapshot.taskTitle).toBe('Recover me');
    expect(secondAudit).toContainEqual(expect.objectContaining({
      action: 'removed',
      taskId: 'task-1',
      deletionSnapshotId: snapshot.id,
    }));

    const restored = await restoreDeletionSnapshot(snapshot.id, 'local');
    expect(restored).toEqual({ taskId: 'task-1', alreadyRestored: false });
    const [task] = await db.select().from(schema.tasks);
    expect(task).toMatchObject({
      id: 'task-1',
      sourceId: 'local:task-1',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Recover me',
      description: 'Preserve this description',
    });
    expect(await db.select().from(schema.taskTags)).toEqual([
      { taskId: 'task-1', tagId: 'tag-1' },
    ]);
    expect(await restoreDeletionSnapshot(snapshot.id, 'local')).toEqual({
      taskId: 'task-1',
      alreadyRestored: true,
    });
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
  }, 15_000);

  it('cancels quarantine when the task reappears on the next full sync', async () => {
    const { db, schema } = await setupTask('remote:returns');
    const { detectDeletions } = await import('@/lib/sync/deletion-detector');

    await detectDeletions(
      'connector-1',
      new Set(['remote:other']),
      true,
      [],
      [{
        id: 'task-1',
        sourceId: 'remote:returns',
        sourceListId: null,
        syncStatus: 'synced',
        status: 'todo',
        title: 'Recover me',
        isChecklistItem: false,
        parentId: null,
        metadata: {},
      }],
    );
    expect(await db.select().from(schema.syncDeletionCandidates)).toHaveLength(1);

    await detectDeletions(
      'connector-1',
      new Set(['remote:returns']),
      true,
      [],
      [{
        id: 'task-1',
        sourceId: 'remote:returns',
        sourceListId: null,
        syncStatus: 'synced',
        status: 'todo',
        title: 'Recover me',
        isChecklistItem: false,
        parentId: null,
        metadata: {},
      }],
    );

    expect(await db.select().from(schema.syncDeletionCandidates)).toHaveLength(0);
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
    expect(await db.select().from(schema.syncDeletionSnapshots)).toHaveLength(0);
  });

  it('restores a source subtask with an identity routed through subtask creation', async () => {
    const { db, schema } = await setupTask('remote:child');
    const now = '2026-08-03T12:00:00.000Z';
    await db.insert(schema.tasks).values({
      id: 'parent-1',
      sourceId: '42',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'connector-1',
      title: 'Parent',
      status: 'todo',
      priority: 'normal',
      createdAt: now,
      updatedAt: now,
      metadata: {},
      syncStatus: 'synced',
      lastSyncedAt: now,
    });
    await db.update(schema.tasks).set({
      isChecklistItem: true,
      parentId: 'parent-1',
    }).where((await import('drizzle-orm')).eq(schema.tasks.id, 'task-1'));

    const { archiveAndDeleteTask, restoreDeletionSnapshot } = await import('@/lib/sync/deletion-recovery');
    const archived = await archiveAndDeleteTask('task-1', 'remote_missing');
    expect(archived).not.toBeNull();

    const restored = await restoreDeletionSnapshot(archived!.snapshotId, 'source');
    const [task] = await db.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, restored.taskId));
    expect(task).toMatchObject({
      isChecklistItem: true,
      parentId: 'parent-1',
      connectorInstanceId: 'connector-1',
      syncStatus: 'pending_push',
    });
    expect(task.sourceId).toBe(restored.taskId);

    const { pushPendingChanges } = await import('@/lib/sync/push-manager');
    const connector: Partial<IConnector> = {
      createSubTask: vi.fn().mockRejectedValue(new Error('Remote request failed: 404')),
    };
    const pushResult = await pushPendingChanges('connector-1', connector as IConnector);
    expect(pushResult.errors).toHaveLength(1);
    expect(connector.createSubTask).toHaveBeenCalledWith('42', expect.objectContaining({
      title: 'Recover me',
    }));
    const [retainedTask] = await db.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, restored.taskId));
    expect(retainedTask).toMatchObject({
      id: restored.taskId,
      syncStatus: 'push_error',
      pushRetryCount: 1,
    });

    for (let attempt = 2; attempt <= 5; attempt++) {
      const retryResult = await pushPendingChanges('connector-1', connector as IConnector);
      expect(retryResult.errors).toHaveLength(1);
    }
    const exhaustedResult = await pushPendingChanges('connector-1', connector as IConnector);
    expect(exhaustedResult.errors).toHaveLength(0);
    const [exhaustedTask] = await db.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, restored.taskId));
    expect(exhaustedTask).toMatchObject({
      id: restored.taskId,
      syncStatus: 'push_failed',
      pushRetryCount: 5,
    });
  });

  it('flattens a locally restored subtask when its parent no longer exists', async () => {
    const { db, schema } = await setupTask('remote:child');
    const { eq } = await import('drizzle-orm');
    await db.update(schema.tasks).set({
      isChecklistItem: true,
      parentId: 'missing-parent',
    }).where(eq(schema.tasks.id, 'task-1'));

    const { archiveAndDeleteTask, restoreDeletionSnapshot } = await import('@/lib/sync/deletion-recovery');
    const archived = await archiveAndDeleteTask('task-1', 'remote_missing');
    expect(archived).not.toBeNull();
    const restored = await restoreDeletionSnapshot(archived!.snapshotId, 'local');
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, restored.taskId));
    expect(task).toMatchObject({
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'local',
    });
  });

  it('detaches canonical descendants without leaving dangling parent references', async () => {
    const { db, schema } = await setupTask('remote:parent');
    const now = '2026-08-03T12:00:00.000Z';
    await db.insert(schema.tasks).values([
      {
        id: 'canonical-child',
        sourceId: 'remote:child',
        connectorType: 'github-issues',
        connectorInstanceId: 'connector-1',
        title: 'Child',
        createdAt: now,
        updatedAt: now,
        parentId: 'task-1',
        depth: 1,
        metadata: {},
        lastSyncedAt: now,
      },
      {
        id: 'canonical-grandchild',
        sourceId: 'remote:grandchild',
        connectorType: 'github-issues',
        connectorInstanceId: 'connector-1',
        title: 'Grandchild',
        createdAt: now,
        updatedAt: now,
        parentId: 'canonical-child',
        depth: 2,
        metadata: {},
        lastSyncedAt: now,
      },
    ]);

    const { archiveAndDeleteTask } = await import('@/lib/sync/deletion-recovery');
    await archiveAndDeleteTask('task-1', 'remote_missing');
    const rows = await db.select().from(schema.tasks);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get('canonical-child')).toMatchObject({ parentId: null, depth: 0 });
    expect(byId.get('canonical-grandchild')).toMatchObject({
      parentId: 'canonical-child',
      depth: 1,
    });
  });

  it('preserves linked-source rows and normalized identity associations in snapshots', async () => {
    const { db, schema } = await setupTask();
    const now = '2026-08-03T12:00:00.000Z';
    await db.insert(schema.connectorConfigs).values({
      id: 'github-linked',
      type: 'github-issues',
      name: 'GitHub linked source',
      enabled: true,
      syncMode: 'manual',
      pollIntervalMinutes: 5,
      capabilities: {},
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.externalEntities).values({
      id: 'external-issue-1',
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'issue',
      stableId: 'I_snapshot',
      identityVersion: 1,
      nextLocatorRevision: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    await db.insert(schema.taskLinkedSources).values({
      id: 'linked-snapshot',
      taskId: 'task-1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-linked',
      sourceId: 'owner/repo:1',
      title: 'Linked issue',
      linkedAt: now,
      metadata: {},
    });
    await db.insert(schema.taskLinkedSourceEntities).values({
      linkedSourceId: 'linked-snapshot',
      connectorInstanceId: 'github-linked',
      externalEntityId: 'external-issue-1',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const { archiveAndDeleteTask, restoreDeletionSnapshot } = await import(
      '@/lib/sync/deletion-recovery'
    );

    const archived = await archiveAndDeleteTask('task-1', 'remote_missing');
    expect(archived).not.toBeNull();
    expect(await db.select().from(schema.taskLinkedSources)).toEqual([]);
    expect(await db.select().from(schema.taskLinkedSourceEntities)).toEqual([]);

    expect(await restoreDeletionSnapshot(archived!.snapshotId, 'local')).toEqual({
      taskId: 'task-1',
      alreadyRestored: false,
    });
    expect(await db.select().from(schema.taskLinkedSources)).toEqual([
      expect.objectContaining({
        id: 'linked-snapshot',
        taskId: 'task-1',
        sourceId: 'owner/repo:1',
      }),
    ]);
    expect(await db.select().from(schema.taskLinkedSourceEntities)).toEqual([
      expect.objectContaining({
        linkedSourceId: 'linked-snapshot',
        connectorInstanceId: 'github-linked',
        externalEntityId: 'external-issue-1',
      }),
    ]);
  });

  it('preflights a verified NodeID binding and restores the original ID to pending source push', async () => {
    const { db, schema, now } = await setupGitHubTask();
    const { archiveAndDeleteTask, restoreDeletionSnapshot } = await import('@/lib/sync/deletion-recovery');
    const archived = await archiveAndDeleteTask('task-1', 'remote_missing');
    expect(archived).not.toBeNull();
    const [snapshot] = await db.select().from(schema.syncDeletionSnapshots);
    expect(snapshot).toMatchObject({
      originalTaskId: 'task-1',
      identityMode: 'stable',
      identityModeRevision: 3,
      issueEntityId: 'issue-entity',
      repositoryEntityId: 'repo-entity',
      locatorRevision: 1,
      bindingState: 'active',
      bindingRevision: now,
    });
    const preflight = vi.fn(async () => ({
      targets: {
        primary_issue: {
          repositoryStableId: 'R_repo',
          issueStableId: 'I_issue',
        },
      },
    }));

    await expect(restoreDeletionSnapshot(snapshot.id, 'source', preflight))
      .resolves.toEqual({ taskId: 'task-1', alreadyRestored: false });
    expect(preflight).toHaveBeenCalledWith({
      targets: [{
        role: 'primary_issue',
        owner: 'owner',
        repository: 'repo',
        issueNumber: 7,
      }],
    });
    const [restored] = await db.select().from(schema.tasks);
    expect(restored).toMatchObject({
      id: 'task-1',
      sourceId: 'local:task-1',
      connectorInstanceId: 'github-recovery',
      syncStatus: 'pending_push',
    });
  });

  it('does not quarantine a snapshot concurrently marked restored during remote preflight', async () => {
    const { db, schema, now } = await setupGitHubTask();
    const { archiveAndDeleteTask, restoreDeletionSnapshot } = await import('@/lib/sync/deletion-recovery');
    const archived = await archiveAndDeleteTask('task-1', 'remote_missing');
    expect(archived).not.toBeNull();
    const [snapshot] = await db.select().from(schema.syncDeletionSnapshots);

    await expect(restoreDeletionSnapshot(snapshot.id, 'source', async () => {
      db.update(schema.syncDeletionSnapshots).set({
        recoveryState: 'restored',
        restoredTaskId: 'task-1',
        restoredAt: now,
      }).run();
      throw new Error('preflight failed after concurrent restore');
    })).rejects.toThrow('remote_identity_inaccessible');

    const [after] = await db.select().from(schema.syncDeletionSnapshots);
    expect(after).toMatchObject({
      recoveryState: 'restored',
      restoredTaskId: 'task-1',
      quarantineReason: null,
    });
  });

  it('preserves the original ID and quarantines a stable snapshot fenced by rollback', async () => {
    const { db, schema, now } = await setupGitHubTask();
    const { eq } = await import('drizzle-orm');
    const identity = await import('@/lib/external-identities');
    const { archiveAndDeleteTask, restoreDeletionSnapshot } = await import('@/lib/sync/deletion-recovery');
    db.update(schema.githubIdentityMigrations).set({
      phase: 'complete',
    }).where(eq(schema.githubIdentityMigrations.connectorInstanceId, 'github-recovery')).run();
    db.update(schema.githubIdentityControls).set({
      modeRevision: 4,
    }).where(eq(schema.githubIdentityControls.connectorInstanceId, 'github-recovery')).run();
    db.update(schema.externalEntityBindings).set({
      state: 'active',
    }).where(eq(schema.externalEntityBindings.connectorInstanceId, 'github-recovery')).run();

    const archived = await archiveAndDeleteTask('task-1', 'stable_remote_missing');
    const snapshot = db.select().from(schema.syncDeletionSnapshots)
      .where(eq(schema.syncDeletionSnapshots.id, archived!.snapshotId)).get()!;
    expect(snapshot).toMatchObject({
      originalTaskId: 'task-1',
      identityMode: 'stable',
      identityModeRevision: 4,
      bindingState: 'active',
    });
    // A connector identity epoch bump must fence a recovery frozen at the old one.
    db.update(schema.githubIdentityControls).set({ modeRevision: 5, updatedAt: now })
      .where(eq(schema.githubIdentityControls.connectorInstanceId, 'github-recovery')).run();
    expect(await identity.getGitHubIdentityModeSnapshot('github-recovery'))
      .toMatchObject({ modeRevision: 5 });
    await expect(restoreDeletionSnapshot(snapshot.id, 'local'))
      .rejects.toThrow('stale_mode_revision');
    expect(db.select().from(schema.syncDeletionSnapshots)
      .where(eq(schema.syncDeletionSnapshots.id, snapshot.id)).get()).toMatchObject({
      originalTaskId: 'task-1',
      restoredTaskId: null,
      recoveryState: 'quarantined',
      quarantineReason: 'stale_mode_revision',
    });
    expect(db.select().from(schema.tasks).all()).toEqual([]);
  });

  it('atomically rejects archive when the frozen deletion revision is stale', async () => {
    const { db, schema, now } = await setupGitHubTask();
    const { eq } = await import('drizzle-orm');
    const { archiveAndDeleteTask } = await import('@/lib/sync/deletion-recovery');
    db.update(schema.githubIdentityControls).set({
      modeRevision: 4,
    }).where(eq(schema.githubIdentityControls.connectorInstanceId, 'github-recovery')).run();

    await expect(archiveAndDeleteTask('task-1', 'stale_delete', {
      identityMode: 'stable',
      identityModeRevision: 3,
      issueEntityId: 'issue-entity',
      repositoryEntityId: 'repo-entity',
      hostKey: 'github.com',
      locatorRevision: 1,
      bindingState: 'active',
      bindingRevision: now,
      sourceId: 'owner/repo:7',
    })).resolves.toBeNull();
    expect(await db.select().from(schema.tasks)).toEqual([
      expect.objectContaining({ id: 'task-1', sourceId: 'owner/repo:7' }),
    ]);
    expect(await db.select().from(schema.syncDeletionSnapshots)).toEqual([]);
  });
});

async function setupGitHubTask() {
  const [{ default: db }, schema] = await Promise.all([
    importInitializedSqliteDatabase(),
    import('@/db/schema'),
  ]);
  const now = '2026-08-03T12:00:00.000Z';
  db.insert(schema.connectorConfigs).values({
    id: 'github-recovery',
    type: 'github-issues',
    name: 'GitHub',
    capabilities: {},
    credentials: {},
    settings: {},
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: 'github-recovery',
    phase: 'complete',
    updatedAt: now,
  }).run();
  db.insert(schema.githubIdentityControls).values({
    connectorInstanceId: 'github-recovery',
    modeRevision: 3,
    updatedAt: now,
  }).run();
  db.insert(schema.sourceLists).values({
    id: 'repo-list',
    connectorInstanceId: 'github-recovery',
    sourceId: 'owner/repo',
    name: 'owner/repo',
    type: 'repo',
  }).run();
  db.insert(schema.tasks).values({
    id: 'task-1',
    sourceId: 'owner/repo:7',
    sourceListId: 'owner/repo',
    connectorType: 'github-issues',
    connectorInstanceId: 'github-recovery',
    title: 'Recover GitHub issue',
    status: 'todo',
    priority: 'normal',
    createdAt: now,
    updatedAt: now,
    metadata: {},
    syncStatus: 'synced',
    lastSyncedAt: now,
  }).run();
  db.insert(schema.externalEntities).values([
    {
      id: 'repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository',
      stableId: 'R_repo',
      firstSeenAt: now,
      lastSeenAt: now,
    },
    {
      id: 'issue-entity',
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'issue',
      stableId: 'I_issue',
      firstSeenAt: now,
      lastSeenAt: now,
    },
  ]).run();
  db.insert(schema.externalEntityLocators).values([
    {
      id: 'repo-locator',
      externalEntityId: 'repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      owner: 'owner',
      repository: 'repo',
      ownerKey: 'owner',
      repositoryKey: 'repo',
      locatorRevision: 1,
      observationSource: 'rest',
      validFrom: now,
      lastSeenAt: now,
    },
    {
      id: 'issue-locator',
      externalEntityId: 'issue-entity',
      repositoryEntityId: 'repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      owner: 'owner',
      repository: 'repo',
      ownerKey: 'owner',
      repositoryKey: 'repo',
      issueNumber: 7,
      locatorRevision: 1,
      observationSource: 'rest',
      validFrom: now,
      lastSeenAt: now,
    },
  ]).run();
  db.insert(schema.externalEntityBindings).values([
    {
      id: 'repo-binding',
      externalEntityId: 'repo-entity',
      connectorInstanceId: 'github-recovery',
      bindingType: 'source_list',
      localId: 'repo-list',
      state: 'active',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'issue-binding',
      externalEntityId: 'issue-entity',
      connectorInstanceId: 'github-recovery',
      bindingType: 'task',
      localId: 'task-1',
      state: 'active',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]).run();
  return { db, schema, now };
}
