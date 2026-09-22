import { describe, expect, it, vi } from 'vitest';
import { collectPostgresHealthSnapshotData } from '@/db/postgres/health-snapshot-data';
import { HealthSnapshotDeferredError } from '@/lib/telemetry/health-snapshot-status';

/**
 * A minimal fake of the drizzle `PostgresDatabase` query surface used by
 * `collectPostgresHealthSnapshotData`. Each call to `db.select()` pops the
 * next queued result and returns a thenable chain that resolves to it
 * regardless of which further chain methods (`.from`/`.where`/`.limit`/
 * `.groupBy`/`.orderBy`) are appended — the exact SQL shape is exercised by
 * the live-PostgreSQL integration test; this fake only needs to prove
 * *how many* queries are attempted, in what order, and how deferral/limit
 * checkpoints gate them.
 */
function makeFakeDb(resultQueue: unknown[]) {
  let index = 0;
  const select = vi.fn(() => {
    if (index >= resultQueue.length) {
      throw new Error(`Unexpected extra db.select() call (call #${index + 1})`);
    }
    const result = resultQueue[index];
    index += 1;
    const node: {
      from: () => typeof node;
      where: () => typeof node;
      limit: () => typeof node;
      groupBy: () => typeof node;
      orderBy: () => typeof node;
      then: (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise<unknown>;
    } = {
      from: () => node,
      where: () => node,
      limit: () => node,
      groupBy: () => node,
      orderBy: () => node,
      then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return node;
  });
  return { select, callCount: () => index };
}

describe('collectPostgresHealthSnapshotData', () => {
  it('throws when the connector limit is exceeded, without querying anything else', async () => {
    const fakeDb = makeFakeDb([
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    ]);

    await expect(
      collectPostgresHealthSnapshotData(fakeDb as never, { maxConnectors: 2 }),
    ).rejects.toThrow('Health snapshot connector limit of 2 exceeded');
    expect(fakeDb.callCount()).toBe(1);
  });

  it('short-circuits the sync-log and dependency-health queries when there are no connectors', async () => {
    const fakeDb = makeFakeDb([[]]);

    const result = await collectPostgresHealthSnapshotData(fakeDb as never, { maxConnectors: 10 });

    expect(result).toEqual({
      configs: [],
      latestSyncPerConnector: [],
      latestSuccessfulSyncPerConnector: [],
      dependencyHealth: new Map(),
    });
    expect(fakeDb.callCount()).toBe(1);
  });

  it('defers (throws HealthSnapshotDeferredError) right after the configs read, before any further query', async () => {
    const fakeDb = makeFakeDb([
      [{ id: 'connector-1' }],
    ]);
    const shouldDefer = vi.fn(() => true);

    await expect(
      collectPostgresHealthSnapshotData(fakeDb as never, { maxConnectors: 10, shouldDefer }),
    ).rejects.toBeInstanceOf(HealthSnapshotDeferredError);
    expect(shouldDefer).toHaveBeenCalledTimes(1);
    // Only the configs query ran; the sync-log/dependency-health queries were never attempted.
    expect(fakeDb.callCount()).toBe(1);
  });

  it('proceeds past the first checkpoint but defers before the dependency-health computation', async () => {
    const fakeDb = makeFakeDb([
      [{ id: 'connector-1' }],
      [{ id: 'sync-1', connectorId: 'connector-1', success: true, syncedAt: '2026-01-01T00:00:00.000Z' }],
      [{ connectorId: 'connector-1', syncedAt: '2026-01-01T00:00:00.000Z' }],
    ]);
    let calls = 0;
    const shouldDefer = vi.fn(() => {
      calls += 1;
      // Pass the first two checkpoints (after configs, after latest sync,
      // after latest successful sync), then defer right before the
      // dependency-reconciliation health computation begins.
      return calls >= 3;
    });

    await expect(
      collectPostgresHealthSnapshotData(fakeDb as never, { maxConnectors: 10, shouldDefer }),
    ).rejects.toBeInstanceOf(HealthSnapshotDeferredError);
    // configs + latestSyncPerConnector + latestSuccessfulSyncPerConnector were queried;
    // the dependency-reconciliation snapshot queries never ran.
    expect(fakeDb.callCount()).toBe(3);
  });
});
