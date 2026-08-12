import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceList } from '@/types';

const insertedBatchSizes: number[] = [];
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(async (rows: unknown[]) => {
      insertedBatchSizes.push(rows.length);
    }),
  })),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@/db', () => ({ default: mockDb }));
vi.mock('@/db/schema', () => ({
  sourceLists: {
    id: 'id',
    sourceId: 'source_id',
    groupId: 'group_id',
    connectorInstanceId: 'connector_instance_id',
  },
  listGroups: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...values: unknown[]) => values),
}));
vi.mock('@/lib/external-identities', () => ({
  canWriteShadowIdentity: vi.fn(() => false),
  persistExternalIdentityBatch: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  syncLogger: { info: vi.fn(), warn: vi.fn() },
}));

describe('source-list persistence batching', () => {
  beforeEach(() => {
    insertedBatchSizes.length = 0;
    vi.clearAllMocks();
  });

  it('bounds bulk inserts and yields between chunks', async () => {
    const { upsertSourceLists } = await import('@/lib/sync/list-manager');
    const lists: SourceList[] = Array.from({ length: 250 }, (_, index) => ({
      id: `list-${index}`,
      connectorInstanceId: 'connector-1',
      sourceId: `remote-${index}`,
      name: `List ${index}`,
      type: 'list',
      taskCount: 0,
      lastSyncedAt: '2026-08-10T00:00:00.000Z',
    }));
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);

    const persisted = await upsertSourceLists('connector-1', lists);

    expect(insertedBatchSizes).toEqual([100, 100, 50]);
    expect(persisted).toHaveLength(250);
    expect(timerFired).toBe(true);
  });
});
