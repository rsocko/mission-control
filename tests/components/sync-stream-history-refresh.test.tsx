import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSyncStreamConnection } from '@/lib/hooks/useSyncStream';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: toastError }),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  private listeners = new Map<string, EventListener>();
  onerror: (() => void) | null = null;

  constructor() {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  close() {}
}

afterEach(() => {
  MockEventSource.instances = [];
  toastError.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createQueryWrapper(queryClient = new QueryClient()) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useSyncStreamConnection history refresh', () => {
  it('attributes sync failures to the executing worker runtime', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(3_000);
    const { unmount } = renderHook(() => useSyncStreamConnection(), {
      wrapper: createQueryWrapper(),
    });
    const eventSource = MockEventSource.instances[0];

    act(() => {
      eventSource.emit('sync:start', {
        type: 'sync:start',
        connectorId: 'finance-1',
        connectorName: 'Tyrion',
        phase: 'tasks',
      });
      eventSource.emit('sync:error', {
        type: 'sync:error',
        connectorId: 'finance-1',
        queueRemaining: 0,
        error: 'invented failure',
        runtimeRelease: 'sha-fff0872',
      });
    });

    render(toastError.mock.calls[0][0]);
    expect(screen.getByText(/invented failure \[runtime sha-fff0872\]/)).toBeInTheDocument();
    unmount();
  });

  it('notifies Sync History after the terminal sync failure', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const refreshListener = vi.fn();
    window.addEventListener('mission-control:sync-complete', refreshListener);
    const { unmount } = renderHook(() => useSyncStreamConnection(), {
      wrapper: createQueryWrapper(),
    });
    const eventSource = MockEventSource.instances[0];

    act(() => {
      eventSource.emit('sync:error', {
        type: 'sync:error',
        connectorId: 'doc-1',
        queueRemaining: 1,
        error: 'HTTP 502',
      });
    });
    expect(refreshListener).not.toHaveBeenCalled();

    act(() => {
      eventSource.emit('sync:error', {
        type: 'sync:error',
        connectorId: 'doc-1',
        queueRemaining: 0,
        error: 'HTTP 502',
      });
    });
    expect(refreshListener).toHaveBeenCalledTimes(1);

    unmount();
    window.removeEventListener('mission-control:sync-complete', refreshListener);
  });

  it('invalidates active query data after the terminal sync completes', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const queryClient = new QueryClient();
    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries');
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(() => useSyncStreamConnection(), {
      wrapper: createQueryWrapper(queryClient),
    });

    act(() => {
      MockEventSource.instances[0].emit('sync:complete', {
        type: 'sync:complete',
        connectorId: 'todo-1',
        queueRemaining: 0,
        result: {
          tasksAdded: 1,
          tasksUpdated: 0,
          tasksRemoved: 0,
          tasksPushed: 0,
          localOnlyProtected: 0,
          totalLists: 1,
          durationMs: 100,
        },
      });
    });

    await waitFor(() => {
      expect(cancelQueries).toHaveBeenCalledWith({ type: 'active' }, { silent: true });
      expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: 'active' });
    });
    unmount();
  });

  it('restarts an initial query that was in flight when sync completed', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      if (queryFn.mock.calls.length > 1) return Promise.resolve('fresh');
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Cancelled', 'AbortError'));
        }, { once: true });
      });
    });
    const { result, unmount } = renderHook(() => {
      useSyncStreamConnection();
      return useQuery({ queryKey: ['sync-race'], queryFn });
    }, {
      wrapper: createQueryWrapper(queryClient),
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    act(() => {
      MockEventSource.instances[0].emit('sync:complete', {
        type: 'sync:complete',
        connectorId: 'todo-1',
        queueRemaining: 0,
        result: {
          tasksAdded: 1,
          tasksUpdated: 0,
          tasksRemoved: 0,
          tasksPushed: 0,
          localOnlyProtected: 0,
          totalLists: 1,
          durationMs: 100,
        },
      });
    });

    await waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(result.current.data).toBe('fresh');
    });
    unmount();
  });
});
