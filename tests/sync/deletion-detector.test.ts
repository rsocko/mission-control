import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import type { SyncAuditEntry } from '@/lib/sync';

describe('deletion detector source ownership', () => {
  beforeAll(() => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  it('deletes missing remote numeric IDs while protecting MC-created subtasks', async () => {
    const [{ default: db }, schema, { detectDeletions }, { eq }] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/sync/deletion-detector'),
      import('drizzle-orm'),
    ]);
    const connectorId = 'numeric-source-connector';
    const now = '2026-08-03T00:00:00.000Z';

    await db.insert(schema.tasks).values([
      {
        id: 'remote-parent-row',
        sourceId: '42',
        connectorType: 'document-intelligence',
        connectorInstanceId: connectorId,
        title: 'Remote numeric task',
        status: 'todo',
        isChecklistItem: false,
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'remote-subtask-row',
        sourceId: '43',
        connectorType: 'numeric-subtask-source',
        connectorInstanceId: connectorId,
        title: 'Remote numeric subtask',
        status: 'todo',
        parentId: 'remote-parent-row',
        isChecklistItem: true,
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'mc-created-subtask',
        sourceId: 'mc-created-subtask',
        connectorType: 'numeric-subtask-source',
        connectorInstanceId: connectorId,
        title: 'MC-created subtask',
        status: 'todo',
        parentId: 'remote-parent-row',
        isChecklistItem: true,
        syncStatus: 'pending_push',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);

    const audit: SyncAuditEntry[] = [];
    const firstResult = await detectDeletions(
      connectorId,
      new Set(['still-present-remotely']),
      true,
      audit,
    );
    expect(firstResult).toEqual({ removed: 0, localOnlyProtected: 1 });

    const result = await detectDeletions(
      connectorId,
      new Set(['still-present-remotely']),
      true,
      audit,
    );
    expect(result).toEqual({ removed: 2, localOnlyProtected: 1 });
    const remaining = await db.select().from(schema.tasks).where(
      eq(schema.tasks.connectorInstanceId, connectorId),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      id: 'mc-created-subtask',
      parentId: null,
      syncStatus: 'pending_push',
    });
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'removed',
        taskSourceId: '42',
      }),
      expect.objectContaining({
        action: 'removed',
        taskSourceId: '43',
      }),
      expect.objectContaining({
        action: 'protected',
        taskSourceId: 'mc-created-subtask',
        reason: 'Locally-created subtask retained after its upstream parent was removed',
      }),
    ]));
  });

  it('yields while reconciling a large retention set', async () => {
    const { detectDeletions } = await import('@/lib/sync/deletion-detector');
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);
    const retainedTasks = Array.from({ length: 25 }, (_, index) => ({
      id: `local-${index}`,
      sourceId: `local:${index}`,
      sourceListId: null,
      syncStatus: 'pending_push',
      status: 'todo',
      title: `Local task ${index}`,
      isChecklistItem: false,
      parentId: null,
    }));

    const result = await detectDeletions(
      'retention-yield-connector',
      new Set(['remote:present']),
      true,
      [],
      retainedTasks,
    );

    expect(result).toEqual({ removed: 0, localOnlyProtected: 25 });
    expect(timerFired).toBe(true);
  });

  it('applies explicit source tombstones immediately while protecting pending edits', async () => {
    const [{ default: db }, schema, { applyExplicitDeletions }, { eq }] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/sync/deletion-detector'),
      import('drizzle-orm'),
    ]);
    const connectorId = 'explicit-tombstone-connector';
    const now = '2026-10-07T00:00:00.000Z';
    await db.insert(schema.tasks).values([
      {
        id: 'deleted-task',
        sourceId: 'list-1:deleted-task',
        connectorType: 'microsoft-todo',
        connectorInstanceId: connectorId,
        title: 'Box of orzo',
        status: 'todo',
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'pending-task',
        sourceId: 'list-1:pending-task',
        connectorType: 'microsoft-todo',
        connectorInstanceId: connectorId,
        title: 'Pending edit',
        status: 'todo',
        syncStatus: 'pending_push',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);
    const audit: SyncAuditEntry[] = [];

    const result = await applyExplicitDeletions(
      connectorId,
      new Set(['list-1:deleted-task', 'list-1:pending-task']),
      audit,
    );

    expect(result).toEqual({ removed: 1, protected: 1 });
    expect(await db.select().from(schema.tasks).where(
      eq(schema.tasks.connectorInstanceId, connectorId),
    )).toEqual([expect.objectContaining({ id: 'pending-task' })]);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'removed', taskSourceId: 'list-1:deleted-task' }),
      expect.objectContaining({ action: 'protected', taskSourceId: 'list-1:pending-task' }),
    ]));
  });
});
