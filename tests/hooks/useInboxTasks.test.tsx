import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInboxTasks } from '@/lib/hooks/useInboxTasks';
import type { InboxTaskDto } from '@/lib/inbox/items';

function makeTask(index: number, snoozedUntil?: string): InboxTaskDto {
  return {
    id: `task-${index}`,
    sourceId: `source-${index}`,
    connectorType: 'local',
    connectorInstanceId: 'local',
    title: `Task ${index}`,
    status: 'todo',
    priority: 'none',
    snoozedUntil,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };
}

describe('useInboxTasks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads every API page before applying Inbox status filters', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => makeTask(index));
    const snoozedTask = makeTask(200, '2099-08-02T10:00:00.000Z');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tasks: firstPage, hasMore: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tasks: [snoozedTask], hasMore: false }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useInboxTasks({ query: '', status: 'snoozed' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].id).toBe('task:task-200');
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('offset=200'));
  });

  it('surfaces task fetch failures instead of presenting an empty queue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));

    const { result } = renderHook(() => useInboxTasks({ query: '', status: 'pending' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Network unavailable');
    expect(result.current.items).toEqual([]);
  });
});
