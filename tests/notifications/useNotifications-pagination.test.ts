/**
 * useNotifications hook — pagination & dateRange filter tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNotifications } from '@/lib/hooks/useNotifications';

const mockResponse = (overrides = {}) => ({
  notifications: [],
  stats: { total: 0, unread: 0, urgent: 0, actionNeeded: 0, headsUp: 0, fyi: 0 },
  facets: { level: {}, category: {}, source: {}, state: {}, merchant: [] },
  hasMore: false,
  cursor: null,
  ...overrides,
});

describe('useNotifications — pagination', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse({ hasMore: true, cursor: 'cursor-1' })), { status: 200 })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes loadMore and isLoadingMore', async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(typeof result.current.loadMore).toBe('function');
    expect(result.current.isLoadingMore).toBe(false);
    expect(result.current.hasMore).toBe(true);
  });

  it('loadMore appends notifications from next page', async () => {
    const page1 = [{ id: 'n1', title: 'First', body: '', level: 'fyi', category: 'system', state: 'unread', receivedAt: '2025-01-01T00:00:00Z', connectorType: 'github', connectorInstanceId: 'g1', sourceId: 's1', groupKey: null, actionUrl: null, actions: [], isActionable: false, metadata: {}, sortAt: '2025-01-01T00:00:00Z' }];
    const page2 = [{ id: 'n2', title: 'Second', body: '', level: 'fyi', category: 'system', state: 'unread', receivedAt: '2025-01-02T00:00:00Z', connectorType: 'github', connectorInstanceId: 'g1', sourceId: 's2', groupKey: null, actionUrl: null, actions: [], isActionable: false, metadata: {}, sortAt: '2025-01-02T00:00:00Z' }];

    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse({ notifications: page1, hasMore: true, cursor: 'cursor-1' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse({ notifications: page2, hasMore: false, cursor: null })), { status: 200 }));

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.hasMore).toBe(false);
  });

  it('loadMore sends cursor param in fetch', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse({ hasMore: true, cursor: 'abc-123' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse({ hasMore: false })), { status: 200 }));

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.loadMore();
    });

    const secondCall = fetchSpy.mock.calls[1][0] as string;
    expect(secondCall).toContain('cursor=abc-123');
  });
});

describe('useNotifications — dateRange filter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse()), { status: 200 })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends dateRange param when filter is set', async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.setDateRangeFilter('week');
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
    expect(lastCall).toContain('dateRange=week');
  });

  it('does not send dateRange when null', async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const firstCall = fetchSpy.mock.calls[0][0] as string;
    expect(firstCall).not.toContain('dateRange');
  });
});

describe('useNotifications — sync refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes notifications resolved by a completed connector sync', async () => {
    const notification = {
      id: 'n1',
      title: 'Review requested',
      body: '',
      level: 'action_needed',
      category: 'development',
      state: 'unread',
      receivedAt: '2026-08-11T21:35:48Z',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      sourceId: 'github-1:gh-notif-42',
      groupKey: null,
      actionUrl: null,
      actions: [],
      isActionable: true,
      metadata: {},
      sortAt: '2026-08-11T21:35:48Z',
    };
    let notificationRequests = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/notifications?')) {
        notificationRequests += 1;
        return new Response(JSON.stringify(mockResponse({
          notifications: notificationRequests === 1 ? [notification] : [],
        })), { status: 200 });
      }
      if (url.startsWith('/api/sync')) {
        return new Response(JSON.stringify({ history: [], isSyncing: false }), { status: 200 });
      }
      if (url === '/api/notifications/writebacks') {
        return new Response(JSON.stringify({ counts: {} }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));

    act(() => {
      window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
    });

    await waitFor(() => expect(result.current.notifications).toHaveLength(0));
    expect(fetchSpy.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/notifications?')
    )).toHaveLength(2);
  });
});
