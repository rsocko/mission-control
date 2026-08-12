import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSystemHealth } from '@/lib/hooks/useSystemHealth';

vi.mock('@/lib/client-logger', () => ({
  uiLogger: { error: vi.fn() },
}));

const unhealthy = {
  overall: 'attention',
  message: '1 connector sync needs attention',
  connectors: [{
    id: 'finance-1',
    type: 'finance-manager',
    name: 'Tyrion',
    status: 'error',
    message: 'Last sync failed',
  }],
  disabledFeatures: [],
};

const healthy = {
  overall: 'healthy',
  message: 'All 1 active connector sync healthy',
  connectors: [{
    id: 'finance-1',
    type: 'finance-manager',
    name: 'Tyrion',
    status: 'healthy',
    message: 'Last sync successful',
  }],
  disabledFeatures: [],
};

describe('system health refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes stale connector sync health when a sync completes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(unhealthy), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(healthy), { status: 200 }));
    const { result } = renderHook(() => useSystemHealth(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current?.overall).toBe('attention');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
      await Promise.resolve();
    });
    expect(result.current?.overall).toBe('healthy');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
  });

  it('keeps the newest health result when responses arrive out of order', async () => {
    let resolveInitial!: (response: Response) => void;
    let resolveRefresh!: (response: Response) => void;
    const initialResponse = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(initialResponse)
      .mockReturnValueOnce(refreshResponse);
    const { result } = renderHook(() => useSystemHealth(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
      resolveRefresh(new Response(JSON.stringify(healthy), { status: 200 }));
      await refreshResponse;
    });
    expect(result.current?.overall).toBe('healthy');

    await act(async () => {
      resolveInitial(new Response(JSON.stringify(unhealthy), { status: 200 }));
      await initialResponse;
    });
    expect(result.current?.overall).toBe('healthy');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
