import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ConnectorExecutionRepositories,
  ConnectorTaskRecord,
} from '@/db/persistence/connector-execution';

export interface ConnectorExecutionHarness {
  repositories: ConnectorExecutionRepositories;
  seedRetentionLog(input: {
    id: string;
    connectorId: string;
    syncedAt: string;
    details: unknown[];
  }): Promise<void>;
  notificationCounts(sourceId: string): Promise<{
    notifications: number;
    actions: number;
    deliveries: number;
  }>;
  notificationActionState(sourceId: string): Promise<{
    primaryActionId: string | null;
    actionIds: string[];
  } | null>;
  tagCount(slug: string): Promise<number>;
  deletionSnapshotState(snapshotId: string): Promise<{
    recoveryState: string;
    quarantineReason: string | null;
  } | null>;
  syncLogCount(connectorId: string): Promise<number>;
  close(): Promise<void> | void;
}

const NOW = '2026-08-29T20:00:00.000Z';

export function connectorExecutionTask(
  overrides: Partial<ConnectorTaskRecord> = {},
): ConnectorTaskRecord {
  return {
    id: 'portable-task',
    sourceId: 'portable-source',
    connectorType: 'custom-rest',
    connectorInstanceId: 'portable-connector',
    title: 'Portable task',
    description: null,
    status: 'todo',
    localDisposition: 'active',
    priority: 'none',
    planningHorizon: null,
    dueDate: null,
    pushCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    recurrenceGeneratedFromTaskId: null,
    parentId: null,
    depth: 0,
    isChecklistItem: false,
    sourceListId: 'portable-list',
    sourceListName: 'Portable',
    assignee: null,
    microStatus: null,
    statusReason: null,
    metadata: { portable: true },
    syncStatus: 'pending_push',
    lastSyncedAt: NOW,
    pushRetryCount: 0,
    kanbanColumn: null,
    kanbanOrder: null,
    snoozedUntil: null,
    reminderAt: null,
    reminderRelative: null,
    reminderDueTime: null,
    effort: null,
    isBulkImport: false,
    ...overrides,
  };
}

export function describeConnectorExecutionRepositoriesContract(
  name: string,
  createHarness: () => Promise<ConnectorExecutionHarness> | ConnectorExecutionHarness,
): void {
  describe(`${name} connector execution persistence contract`, () => {
    let harness: ConnectorExecutionHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('persists source-list discovery and folder assignment atomically', async () => {
      await harness.repositories.lists.applyDiscovery({
        connectorId: 'portable-connector',
        upserts: [{
          id: 'portable-list',
          connectorInstanceId: 'portable-connector',
          sourceId: 'remote-list',
          name: 'Remote list',
          type: 'list',
          taskCount: 1,
          lastSyncedAt: NOW,
          wellKnownListName: null,
          lastKnownRemoteName: 'Remote list',
        }],
        stale: [],
      });
      await expect(harness.repositories.lists.assignFolderGroups({
        groups: [{ sourceId: 'folder-1', name: 'Folder' }],
        lists: [{ sourceId: 'remote-list', parentFolderGroupId: 'folder-1' }],
        now: NOW,
      })).resolves.toBe(1);

      await expect(harness.repositories.lists.list('portable-connector')).resolves.toEqual([
        expect.objectContaining({
          id: 'portable-list',
          sourceId: 'remote-list',
          groupId: expect.any(String),
        }),
      ]);
      await expect(harness.repositories.lists.applyDiscovery({
        connectorId: 'other-connector',
        upserts: [{
          id: 'portable-list',
          connectorInstanceId: 'other-connector',
          sourceId: 'other-remote-list',
          name: 'Other remote list',
          type: 'list',
          taskCount: 0,
          lastSyncedAt: NOW,
          wellKnownListName: null,
          lastKnownRemoteName: 'Other remote list',
        }],
        stale: [],
      })).rejects.toThrow(/belongs to another connector/);
      await expect(harness.repositories.lists.list('portable-connector')).resolves.toEqual([
        expect.objectContaining({ id: 'portable-list', sourceId: 'remote-list' }),
      ]);
    });

    it('fences push claims and conditional pull updates', async () => {
      const task = connectorExecutionTask();
      const inserted = await harness.repositories.pulls.insertBatch([{
        task,
        tags: [{
          name: 'Portable',
          slug: 'portable',
          type: 'source',
          confirmed: true,
        }],
      }]);
      expect(inserted.insertedIds.has(task.id)).toBe(true);
      await expect(harness.repositories.pulls.listTasks('portable-connector'))
        .resolves.toHaveLength(1);

      const leaseToken = '2026-08-29T20:01:00.000Z';
      await expect(harness.repositories.pushes.claim(
        task.id,
        leaseToken,
        '2026-08-29T19:00:00.000Z',
      )).resolves.toBe(true);
      await expect(harness.repositories.pushes.claim(
        task.id,
        leaseToken,
        '2026-08-29T19:00:00.000Z',
      )).resolves.toBe(false);
      await expect(harness.repositories.pushes.complete({
        taskId: task.id,
        leaseToken,
        sourceId: 'remote-task',
        now: '2026-08-29T20:02:00.000Z',
        expectedTaskVersion: 'wrong-version',
      })).resolves.toBe(false);
      await expect(harness.repositories.pushes.complete({
        taskId: task.id,
        leaseToken,
        sourceId: 'remote-task',
        now: '2026-08-29T20:02:00.000Z',
        expectedTaskVersion: NOW,
      })).resolves.toBe(true);
      await expect(harness.repositories.pulls.listTasks('portable-connector'))
        .resolves.toHaveLength(1);

      await expect(harness.repositories.pulls.applyRemoteUpdate({
        taskId: task.id,
        expectedSyncStatus: 'pending_push',
        values: { title: 'must not win' },
      })).resolves.toBe(false);
      await expect(harness.repositories.pulls.applyRemoteUpdate({
        taskId: task.id,
        expectedSyncStatus: 'synced',
        values: {
          title: 'remote title',
          syncStatus: 'synced',
          lastSyncedAt: '2026-08-29T20:03:00.000Z',
        },
        sourceTags: [],
      })).resolves.toBe(true);
      await expect(harness.repositories.pulls.listTasks('portable-connector'))
        .resolves.toEqual([
          expect.objectContaining({ title: 'remote title', sourceId: 'remote-task' }),
        ]);

      const concurrentEdit = connectorExecutionTask({
        id: 'create-outcome-task',
        sourceId: 'local:create-outcome-task',
        updatedAt: '2026-08-29T20:04:00.000Z',
      });
      await harness.repositories.pulls.insertBatch([{ task: concurrentEdit, tags: [] }]);
      const createLease = '2026-08-29T20:05:00.000Z';
      await expect(harness.repositories.pushes.claim(
        concurrentEdit.id,
        createLease,
        '2026-08-29T19:00:00.000Z',
      )).resolves.toBe(true);
      await expect(harness.repositories.pushes.complete({
        taskId: concurrentEdit.id,
        leaseToken: createLease,
        sourceId: 'remote-create-outcome',
        now: '2026-08-29T20:06:00.000Z',
        expectedTaskVersion: 'concurrent-local-edit',
        createdFromSourceId: concurrentEdit.sourceId,
      })).resolves.toBe(true);
      await expect(harness.repositories.pulls.listTasks('portable-connector'))
        .resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: concurrentEdit.id,
            sourceId: 'remote-create-outcome',
            syncStatus: 'pending_push',
          }),
        ]));
    });

    it('keeps notification, action, and delivery occurrence writes idempotent', async () => {
      const command = {
        input: {
          id: 'portable-notification',
          sourceId: 'portable-connector:notice-1',
          connectorType: 'system',
          connectorInstanceId: 'push-triggers',
          title: 'Portable notice',
          body: null,
          level: 'fyi',
          category: 'general',
          templateKey: 'task_reminder',
          readState: 'unread' as const,
          sourceState: 'active' as const,
          sourceActivityAt: NOW,
          sourceActivityKey: 'occurrence-1',
          reopenPolicy: 'handled' as const,
          occurrenceKey: 'occurrence-1',
          isActionable: true,
          primaryActionId: 'portable-action',
          receivedAt: NOW,
          sortAt: NOW,
          relatedTaskId: null,
          relatedProjectId: null,
          relatedEntityType: null,
          relatedEntityId: null,
          navigationTarget: '/notifications',
          metadata: { portable: true },
          presentation: {},
        },
        actions: [{
          id: 'portable-action',
          notificationId: 'portable-notification',
          actionType: 'open_url',
          label: 'Open',
          variant: 'primary',
          isPrimary: true,
          sortOrder: 0,
          payload: { url: '/notifications' },
          opensExternal: false,
          requiresConfirmation: false,
          createdBy: 'system',
        }],
      };
      const [first] = await harness.repositories.notifications.ingest([command]);
      const regeneratedCommand = {
        input: {
          ...command.input,
          id: 'portable-notification-regenerated',
          primaryActionId: 'portable-action-regenerated',
        },
        actions: [{
          ...command.actions[0],
          id: 'portable-action-regenerated',
          notificationId: 'portable-notification-regenerated',
        }],
      };
      const [second] = await harness.repositories.notifications.ingest([regeneratedCommand]);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      await expect(harness.notificationCounts(command.input.sourceId)).resolves.toEqual({
        notifications: 1,
        actions: 1,
        deliveries: 2,
      });
      await expect(harness.notificationActionState(command.input.sourceId)).resolves.toEqual({
        primaryActionId: command.actions[0].id,
        actionIds: [command.actions[0].id],
      });

      const batchSourceId = 'portable-connector:notice-batch';
      const batchFirst = {
        input: {
          ...command.input,
          id: 'portable-notification-batch-first',
          sourceId: batchSourceId,
          primaryActionId: 'portable-action-batch-first',
        },
        actions: [{
          ...command.actions[0],
          id: 'portable-action-batch-first',
          notificationId: 'portable-notification-batch-first',
        }],
      };
      const batchSecond = {
        input: {
          ...batchFirst.input,
          id: 'portable-notification-batch-second',
          primaryActionId: 'portable-action-batch-second',
        },
        actions: [{
          ...batchFirst.actions[0],
          id: 'portable-action-batch-second',
          notificationId: 'portable-notification-batch-second',
        }],
      };
      const batchResults = await harness.repositories.notifications.ingest([
        batchFirst,
        batchSecond,
      ]);
      expect(batchResults.map(result => result.created)).toEqual([true, false]);
      await expect(harness.notificationActionState(batchSourceId)).resolves.toEqual({
        primaryActionId: batchFirst.actions[0].id,
        actionIds: [batchFirst.actions[0].id],
      });

      const conflictingSourceId = 'portable-connector:notice-conflict';
      await expect(harness.repositories.notifications.ingest([{
        input: {
          ...command.input,
          id: 'portable-notification-conflict',
          sourceId: conflictingSourceId,
          primaryActionId: command.actions[0].id,
        },
        actions: [{
          ...command.actions[0],
          notificationId: 'portable-notification-conflict',
        }],
      }])).rejects.toThrow();
      await expect(harness.notificationCounts(conflictingSourceId)).resolves.toEqual({
        notifications: 0,
        actions: 0,
        deliveries: 0,
      });
    });

    it('quarantines deletion twice and restores the exact snapshot locally', async () => {
      const task = connectorExecutionTask({
        id: 'delete-task',
        sourceId: 'delete-source',
        syncStatus: 'synced',
      });
      await harness.repositories.pulls.insertBatch([{ task, tags: [] }]);
      const fence = {
        identityMode: null,
        identityModeRevision: null,
        issueEntityId: null,
        repositoryEntityId: null,
        hostKey: null,
        locatorRevision: null,
        bindingState: null,
        bindingRevision: null,
      };
      await expect(harness.repositories.deletions.observeMissing({
        connectorId: task.connectorInstanceId,
        taskId: task.id,
        sourceId: task.sourceId,
        now: NOW,
        expectedFence: fence,
      })).resolves.toBe('quarantined');
      const [candidate] = await harness.repositories.deletions
        .listCandidates(task.connectorInstanceId);
      await expect(harness.repositories.deletions.observeMissing({
        connectorId: task.connectorInstanceId,
        taskId: task.id,
        sourceId: task.sourceId,
        now: '2026-08-29T21:00:00.000Z',
        expectedCandidateId: candidate.id,
        expectedFence: fence,
      })).resolves.toBe('ready');
      const archived = await harness.repositories.deletions
        .archiveAndDeleteTask(task.id, 'contract deletion');
      expect(archived).not.toBeNull();
      await expect(harness.repositories.deletions.restoreDeletionSnapshot(
        archived!.snapshotId,
        'local',
      )).resolves.toEqual({ taskId: task.id, alreadyRestored: false });
      await expect(harness.repositories.pulls.listTasks('local')).resolves.toEqual([
        expect.objectContaining({ id: task.id, sourceId: `local:${task.id}` }),
      ]);
    });

    it('persists restore quarantine before reporting an occupied task ID', async () => {
      const task = connectorExecutionTask({
        id: 'restore-conflict-task',
        sourceId: 'restore-conflict-source',
        syncStatus: 'synced',
      });
      await harness.repositories.pulls.insertBatch([{ task, tags: [] }]);
      const archived = await harness.repositories.deletions
        .archiveAndDeleteTask(task.id, 'contract restore conflict');
      expect(archived).not.toBeNull();
      await harness.repositories.pulls.insertBatch([{
        task: connectorExecutionTask({
          id: task.id,
          sourceId: 'occupied-source',
          syncStatus: 'synced',
        }),
        tags: [],
      }]);

      await expect(harness.repositories.deletions.restoreDeletionSnapshot(
        archived!.snapshotId,
        'local',
      )).rejects.toThrow(/task ID is occupied/);
      await expect(harness.deletionSnapshotState(archived!.snapshotId)).resolves.toEqual({
        recoveryState: 'quarantined',
        quarantineReason: 'original_task_id_conflict',
      });
    });

    it('serializes concurrent tag creation by slug', async () => {
      const tag = {
        name: 'Concurrent portable tag',
        slug: 'portable-concurrent',
        type: 'source',
        source: 'portable-connector',
        confirmed: true,
      };
      await Promise.all([
        harness.repositories.pulls.insertBatch([{
          task: connectorExecutionTask({
            id: 'tag-task-one',
            sourceId: 'tag-source-one',
          }),
          tags: [tag],
        }]),
        harness.repositories.pulls.insertBatch([{
          task: connectorExecutionTask({
            id: 'tag-task-two',
            sourceId: 'tag-source-two',
          }),
          tags: [tag],
        }]),
      ]);
      await expect(harness.tagCount(tag.slug)).resolves.toBe(1);
    });

    it('applies conflicts atomically and fences retention detail ownership', async () => {
      const task = connectorExecutionTask({
        id: 'conflict-task',
        sourceId: 'conflict-source',
        syncStatus: 'conflict',
      });
      await harness.repositories.pulls.insertBatch([{ task, tags: [] }]);
      await expect(harness.repositories.retention.findTask({
        connectorId: task.connectorInstanceId,
        taskId: task.id,
        taskSourceId: 'different-source',
      })).resolves.toBeNull();
      await expect(harness.repositories.retention.findTask({
        connectorId: task.connectorInstanceId,
        taskId: task.id,
        taskSourceId: task.sourceId,
      })).resolves.toMatchObject({ id: task.id, sourceId: task.sourceId });
      await harness.repositories.conflicts.applyResolution({
        taskId: task.id,
        connectorId: task.connectorInstanceId,
        winningVersion: {
          title: 'resolved title',
          status: 'todo',
          priority: 'none',
        },
        resolution: 'remote_wins',
        localUpdatedAt: NOW,
        remoteUpdatedAt: '2026-08-29T20:05:00.000Z',
        resolvedAt: '2026-08-29T20:06:00.000Z',
      });
      await expect(harness.repositories.conflicts.listUnresolved()).resolves.toEqual([]);
      await expect(harness.syncLogCount(task.connectorInstanceId)).resolves.toBe(1);

      await harness.seedRetentionLog({
        id: 'retention-log',
        connectorId: task.connectorInstanceId,
        syncedAt: NOW,
        details: [{
          action: 'protected',
          taskId: task.id,
          taskTitle: task.title,
          taskSourceId: task.sourceId,
        }],
      });
      const claim = await harness.repositories.retention.claim({
        syncLogId: 'retention-log',
        detailIndex: 0,
        action: 'keep_local',
        claimId: 'claim-1',
        now: NOW,
        leaseExpiresAt: '2026-08-29T20:05:00.000Z',
      });
      expect(claim.status).toBe('claimed');
      await expect(harness.repositories.retention.renew({
        syncLogId: 'retention-log',
        detailIndex: 0,
        claimId: 'other-claim',
        leaseExpiresAt: '2026-08-29T20:10:00.000Z',
      })).resolves.toBe(false);
      await expect(harness.repositories.retention.finalize({
        syncLogId: 'retention-log',
        detailIndex: 0,
        claimId: 'claim-1',
        resolution: {
          action: 'keep_local',
          status: 'succeeded',
          resolvedAt: NOW,
          message: 'done',
        },
      })).resolves.toBe(true);
    });

    it('converts and deletes a generic retained task tree atomically', async () => {
      const parent = connectorExecutionTask({
        id: 'retained-parent',
        sourceId: 'retained-parent-source',
        syncStatus: 'synced',
      });
      const child = connectorExecutionTask({
        id: 'retained-child',
        sourceId: 'retained-child-source',
        parentId: parent.id,
        depth: 1,
        isChecklistItem: true,
        syncStatus: 'synced',
      });
      await harness.repositories.pulls.insertBatch([
        { task: parent, tags: [] },
        { task: child, tags: [] },
      ]);

      await harness.repositories.retention.convertTaskTreeToLocal(parent.id, false);
      const local = await harness.repositories.pulls.listTasks('local');
      expect(local).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: parent.id, sourceId: `local:${parent.id}` }),
        expect.objectContaining({ id: child.id, sourceId: `local:${child.id}` }),
      ]));

      await harness.repositories.retention.deleteTaskTree(parent.id);
      const remaining = await harness.repositories.pulls.listTasks('local');
      expect(remaining.some((task) => task.id === parent.id || task.id === child.id))
        .toBe(false);
    });
  });
}
