import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { IConnector } from '@/lib/connectors';
import type { TaskItem } from '@/types';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('@/db');
vi.unmock('@/db/schema');
vi.unmock('drizzle-orm');

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(async () => null),
}));
vi.mock('@/lib/sync/search-indexer', () => ({
  indexTasksForSearchBatch: vi.fn(async () => undefined),
}));
vi.mock('@/lib/sync/deletion-detector', () => ({
  detectDeletions: vi.fn(async () => ({ removed: 0, localOnlyProtected: 0 })),
}));

let db: typeof import('@/db').default;
let tasks: typeof import('@/db/schema').tasks;
let upsertTasks: typeof import('@/lib/sync/pull-manager').upsertTasks;

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  ({ tasks } = await import('@/db/schema'));
  ({ upsertTasks } = await import('@/lib/sync/pull-manager'));
});

describe('pull marker adoption', () => {
  it('adopts the remote identity on the existing pushing task', async () => {
    const now = new Date().toISOString();
    await db.insert(tasks).values({
      id: 'local-task-1',
      sourceId: 'local:local-task-1',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      title: 'Create remotely',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
      syncStatus: 'pushing',
      metadata: { missionControlTaskId: 'local-task-1' },
    });

    const remoteTask = {
      id: 'remote-1',
      sourceId: 'list-1:remote-1',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      title: 'Create remotely',
      status: 'todo',
      priority: 'none',
      createdAt: now,
      updatedAt: now,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'list-1',
      hubProjectIds: [],
      tags: [],
      metadata: { missionControlTaskId: 'local-task-1' },
      syncStatus: 'synced',
      lastSyncedAt: now,
    } satisfies TaskItem;
    const connector = { id: 'todo-1', type: 'microsoft-todo' } as IConnector;

    const result = await upsertTasks('todo-1', connector, [remoteTask], true);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    const persisted = await db.select().from(tasks)
      .where(eq(tasks.connectorInstanceId, 'todo-1'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(expect.objectContaining({
      id: 'local-task-1',
      sourceId: 'list-1:remote-1',
      syncStatus: 'synced',
    }));
    const { detectDeletions } = await import('@/lib/sync/deletion-detector');
    expect(vi.mocked(detectDeletions)).toHaveBeenCalledWith(
      'todo-1',
      new Set(['list-1:remote-1']),
      true,
      expect.any(Array),
      [expect.objectContaining({
        id: 'local-task-1',
        sourceId: 'list-1:remote-1',
      })],
      expect.objectContaining({
        identityComparison: undefined,
        inaccessibleSourceListIds: expect.any(Set),
      }),
    );
  });

  it('preserves edits made while remote creation was in flight', async () => {
    const createdAt = '2026-08-03T12:00:00.000Z';
    await db.insert(tasks).values({
      id: 'local-task-edited',
      sourceId: 'local:local-task-edited',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-2',
      title: 'Edited locally',
      description: 'Keep this edit',
      createdAt,
      updatedAt: '2026-08-03T12:01:00.000Z',
      lastSyncedAt: createdAt,
      syncStatus: 'pushing',
      metadata: { missionControlTaskId: 'local-task-edited' },
    });

    const remoteTask = {
      id: 'remote-edited',
      sourceId: 'list-1:remote-edited',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-2',
      title: 'Original title',
      description: 'Original description',
      status: 'todo',
      priority: 'none',
      createdAt,
      updatedAt: createdAt,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'list-1',
      hubProjectIds: [],
      tags: [],
      metadata: { missionControlTaskId: 'local-task-edited' },
      syncStatus: 'synced',
      lastSyncedAt: createdAt,
    } satisfies TaskItem;
    const connector = { id: 'todo-2', type: 'microsoft-todo' } as IConnector;

    await upsertTasks('todo-2', connector, [remoteTask]);

    const [persisted] = await db.select().from(tasks)
      .where(eq(tasks.id, 'local-task-edited'));
    expect(persisted).toEqual(expect.objectContaining({
      sourceId: 'list-1:remote-edited',
      title: 'Edited locally',
      description: 'Keep this edit',
      syncStatus: 'pending_push',
    }));
  });
});
