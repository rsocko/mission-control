import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('@/db');
vi.unmock('@/db/schema');
vi.unmock('drizzle-orm');

let db: typeof import('@/db').default;
let tasks: typeof import('@/db/schema').tasks;
let claimTaskForPush: typeof import('@/lib/sync/push-lease').claimTaskForPush;
let completeTaskPush: typeof import('@/lib/sync/push-lease').completeTaskPush;
let failTaskPush: typeof import('@/lib/sync/push-lease').failTaskPush;
let heartbeatTaskPush: typeof import('@/lib/sync/push-lease').heartbeatTaskPush;
let releaseTaskPush: typeof import('@/lib/sync/push-lease').releaseTaskPush;

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  ({ tasks } = await import('@/db/schema'));
  ({
    claimTaskForPush,
    completeTaskPush,
    failTaskPush,
    heartbeatTaskPush,
    releaseTaskPush,
  } = await import('@/lib/sync/push-lease'));

  const now = new Date().toISOString();
  await db.insert(tasks).values({
    id: 'push-task-1',
    sourceId: 'local:push-task-1',
    connectorType: 'microsoft-todo',
    connectorInstanceId: 'todo-1',
    title: 'Push once',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    syncStatus: 'pending_push',
  });
  await db.insert(tasks).values({
    id: 'push-subtask-1',
    sourceId: 'push-subtask-1',
    connectorType: 'microsoft-todo',
    connectorInstanceId: 'todo-1',
    title: 'Push subtask once',
    isChecklistItem: true,
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    syncStatus: 'pending_push',
  });
});

describe('task push lease', () => {
  it('allows only one concurrent remote creator', async () => {
    const claims = await Promise.all([
      claimTaskForPush('push-task-1'),
      claimTaskForPush('push-task-1'),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it('allows only one concurrent remote subtask creator', async () => {
    const claims = await Promise.all([
      claimTaskForPush('push-subtask-1'),
      claimTaskForPush('push-subtask-1'),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it('recovers a stale push lease', async () => {
    await db.update(tasks).set({
      syncStatus: 'pushing',
      lastSyncedAt: '2020-01-01T00:00:00.000Z',
    }).where(eq(tasks.id, 'push-task-1'));

    expect(await claimTaskForPush('push-task-1')).toEqual(expect.any(String));
  });

  it('rejects finalization from a worker that lost its lease', async () => {
    expect(await completeTaskPush(
      'push-task-1',
      'stale-lease-token',
      'list-1:remote-1',
    )).toBe(false);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, 'push-task-1'));
    expect(task.sourceId).toBe('local:push-task-1');
    expect(task.syncStatus).toBe('pushing');
  });

  it('rejects finalization when the task version changed without replacing the claim', async () => {
    const originalVersion = '2026-08-10T12:00:00.000Z';
    await db.insert(tasks).values({
      id: 'push-task-version-race',
      sourceId: 'local:push-task-version-race',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      title: 'Version fenced push',
      createdAt: originalVersion,
      updatedAt: originalVersion,
      lastSyncedAt: originalVersion,
      syncStatus: 'pending_push',
    });
    const token = await claimTaskForPush('push-task-version-race');
    await db.update(tasks).set({
      updatedAt: '2026-08-10T12:01:00.000Z',
    }).where(eq(tasks.id, 'push-task-version-race'));

    expect(await completeTaskPush(
      'push-task-version-race',
      token!,
      'list-1:remote-version-race',
      undefined,
      undefined,
      originalVersion,
    )).toBe(false);
    expect(await failTaskPush(
      'push-task-version-race',
      token!,
      'push_error',
      1,
      originalVersion,
    )).toBe(false);
    expect(await releaseTaskPush(
      'push-task-version-race',
      token!,
      'pending_push',
      originalVersion,
    )).toBe(false);

    const [task] = await db.select().from(tasks)
      .where(eq(tasks.id, 'push-task-version-race'));
    expect(task).toMatchObject({
      sourceId: 'local:push-task-version-race',
      syncStatus: 'pushing',
      updatedAt: '2026-08-10T12:01:00.000Z',
    });
  });

  it('renews the lease token and fences the prior token', async () => {
    const [before] = await db.select().from(tasks).where(eq(tasks.id, 'push-task-1'));
    const renewedToken = await heartbeatTaskPush('push-task-1', before.lastSyncedAt);

    expect(renewedToken).toEqual(expect.any(String));
    expect(await completeTaskPush(
      'push-task-1',
      before.lastSyncedAt,
      'list-1:remote-1',
    )).toBe(false);
    expect(await completeTaskPush(
      'push-task-1',
      renewedToken!,
      'list-1:remote-1',
    )).toBe(true);
  });
});
