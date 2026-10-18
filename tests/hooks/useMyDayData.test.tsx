import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/useDashboardQueries', () => ({
  useMyDayQueries: () => ({
    itemsQuery: { data: undefined },
    scheduleQuery: { data: undefined },
    calendarQuery: { data: undefined },
    connectorsQuery: { data: undefined },
    energyQuery: { data: undefined },
  }),
}));

import { useMyDayData } from '@/lib/hooks/useMyDayData';

describe('useMyDayData refreshes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cancels stale My Day requests before syncing and refetching', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries');
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ synced: 1 })));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMyDayData('2026-10-18'), { wrapper });

    await act(async () => {
      await result.current.fetchData();
    });

    expect(cancelQueries).toHaveBeenCalledWith(
      { queryKey: ['myDay'], type: 'active' },
      { silent: true },
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/my-day/sync', expect.any(Object));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['myDay'] });
    expect(cancelQueries.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateQueries.mock.invocationCallOrder[0],
    );
  });
});
