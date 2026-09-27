import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDashboardQueries } from '@/lib/hooks/useDashboardQueries';
import { notifyNavigationCountsChanged } from '@/lib/navigation/badges';
import { notifyTaskChanged } from '@/lib/task-change-events';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDashboardQueries', () => {
  it('refreshes source and list counts for every task-mutation signal', async () => {
    let connectorRequests = 0;
    let sourceCountRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/connectors') {
        connectorRequests += 1;
        return new Response(JSON.stringify({
          connectors: [],
          sourceLists: [{
            id: 'list-1',
            sourceId: 'career',
            connectorInstanceId: 'microsoft-todo',
            name: 'Career',
            taskCount: 9 - connectorRequests,
            groupId: null,
          }],
        }));
      }
      if (url === '/api/tasks?parentOnly=true&openOnly=true&limit=1&countsOnly=true') {
        sourceCountRequests += 1;
        return new Response(JSON.stringify({
          sourceCounts: { 'microsoft-todo': 21 - sourceCountRequests },
        }));
      }
      if (url.startsWith('/api/tasks?')) {
        return new Response(JSON.stringify({
          tasks: [],
          total: 0,
          hasMore: false,
          sourceCounts: {},
          facetCounts: { priorities: {}, statuses: {} },
          availableTags: [],
          stats: {},
        }));
      }
      if (url.startsWith('/api/my-day?')) {
        return new Response(JSON.stringify({ items: [] }));
      }
      if (url === '/api/hub-projects?includePhases=true') {
        return new Response(JSON.stringify({ projects: [] }));
      }
      if (url === '/api/features') {
        return new Response(JSON.stringify({ enabledSources: [] }));
      }
      if (url === '/api/list-groups') {
        return new Response(JSON.stringify({ groups: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useDashboardQueries('parentOnly=true'), { wrapper });

    await waitFor(() => {
      expect(result.current.connectorsQuery.data?.sourceLists[0]?.taskCount).toBe(8);
      expect(result.current.sourceCountsQuery.data?.['microsoft-todo']).toBe(20);
    });

    act(() => {
      notifyTaskChanged('task-1');
    });

    await waitFor(() => {
      expect(result.current.connectorsQuery.data?.sourceLists[0]?.taskCount).toBe(7);
      expect(result.current.sourceCountsQuery.data?.['microsoft-todo']).toBe(19);
    });

    act(() => {
      notifyNavigationCountsChanged();
    });
    await waitFor(() => {
      expect(result.current.connectorsQuery.data?.sourceLists[0]?.taskCount).toBe(6);
      expect(result.current.sourceCountsQuery.data?.['microsoft-todo']).toBe(18);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('mc:task-completed'));
    });
    await waitFor(() => {
      expect(result.current.connectorsQuery.data?.sourceLists[0]?.taskCount).toBe(5);
      expect(result.current.sourceCountsQuery.data?.['microsoft-todo']).toBe(17);
    });
    expect(connectorRequests).toBe(4);
    expect(sourceCountRequests).toBe(4);
  });
});
