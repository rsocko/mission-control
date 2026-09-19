import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OfflineActionBlockedError,
  getPendingActions,
  queueAction,
  registerActionHandler,
  replayPendingActions,
  unregisterActionHandler,
} from '@/lib/offline-queue';

describe('offline action queue', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  it('preserves ordered actions until their registered handler succeeds', async () => {
    const replayed: number[] = [];
    registerActionHandler('task.patch', async (payload) => {
      replayed.push(payload.order as number);
    });
    await queueAction({ type: 'task.patch', payload: { order: 1 } });
    await queueAction({ type: 'task.patch', payload: { order: 2 } });

    await expect(replayPendingActions()).resolves.toEqual({
      synced: 2,
      failed: 0,
      dropped: 0,
    });
    expect(replayed).toEqual([1, 2]);
    expect(await getPendingActions()).toEqual([]);
    unregisterActionHandler('task.patch');
  });

  it('keeps conflicts for user review instead of discarding them', async () => {
    registerActionHandler('task.patch', async () => {
      throw new OfflineActionBlockedError('Task changed before this update could be applied');
    });
    await queueAction({ type: 'task.patch', payload: { id: 'task-1' } });

    await expect(replayPendingActions()).resolves.toEqual({
      synced: 0,
      failed: 1,
      dropped: 1,
    });
    const [queued] = await getPendingActions();
    expect(queued).toMatchObject({
      state: 'blocked',
      attempts: 1,
      lastError: 'Task changed before this update could be applied',
    });
    unregisterActionHandler('task.patch');
  });
});
