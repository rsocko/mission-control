import { describe, expect, it } from 'vitest';
import {
  mergePendingSourceListRenames,
  resolveSourceListRefresh,
  runSourceListRenameRequest,
} from '@/app/settings/source-list-renames';

describe('mergePendingSourceListRenames', () => {
  const sourceLists = [
    { id: 'list-1', name: 'Remote name', connectorInstanceId: 'connector-1' },
    { id: 'list-2', name: 'Unchanged', connectorInstanceId: 'connector-1' },
  ];

  it('keeps an optimistic rename when a worker-sync refresh returns stale data', () => {
    const result = mergePendingSourceListRenames(
      sourceLists,
      new Map([['list-1', 'Pending local name']]),
    );

    expect(result).toEqual([
      { id: 'list-1', name: 'Pending local name', connectorInstanceId: 'connector-1' },
      sourceLists[1],
    ]);
    expect(sourceLists[0].name).toBe('Remote name');
  });

  it('returns fetched data unchanged when no rename is pending', () => {
    expect(mergePendingSourceListRenames(sourceLists, new Map())).toBe(sourceLists);
  });

  it('rejects a response invalidated when a pending rename settles', () => {
    expect(resolveSourceListRefresh(
      sourceLists,
      new Map(),
      1,
      2,
    )).toBeNull();
  });

  it('merges pending names into connector-specific refresh results', () => {
    const connectorRefresh = [
      sourceLists[1],
      { id: 'list-1', name: 'Stale connector name', connectorInstanceId: 'connector-1' },
    ];

    expect(resolveSourceListRefresh(
      connectorRefresh,
      new Map([['list-1', 'Pending local name']]),
      2,
      2,
    )).toEqual([
      sourceLists[1],
      { id: 'list-1', name: 'Pending local name', connectorInstanceId: 'connector-1' },
    ]);
  });

  it('settles the pending rename when the network request rejects', async () => {
    const networkError = new Error('network unavailable');
    const onSettled = vi.fn().mockResolvedValue(undefined);

    await expect(runSourceListRenameRequest(
      () => Promise.reject(networkError),
      onSettled,
    )).rejects.toBe(networkError);

    expect(onSettled).toHaveBeenCalledOnce();
  });
});
