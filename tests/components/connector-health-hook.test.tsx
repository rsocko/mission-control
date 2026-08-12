import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConnectorHealth } from '@/app/settings/components/useConnectorHealth';
import type { ConnectorConfig } from '@/app/settings/components/types';

const connector: ConnectorConfig = {
  id: 'doc-intelligence',
  type: 'document-intelligence',
  name: 'Document Intelligence',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 60,
  capabilities: {},
  credentials: {},
  settings: {},
  syncedLists: [],
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
  deletedAt: null,
};

function healthyResponse() {
  return Promise.resolve({
    ok: true,
    json: async () => ({ overall: 'healthy', modules: [] }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useConnectorHealth', () => {
  it('does not refetch when an equivalent connector array is passed', async () => {
    const fetchMock = vi.fn(healthyResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = renderHook(
      ({ connectors }: { connectors: ConnectorConfig[] }) => useConnectorHealth(connectors),
      { initialProps: { connectors: [connector] } }
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ connectors: [{ ...connector }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not overlap health polls for the same connector', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useConnectorHealth([connector]));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately when requested after a connection test', async () => {
    const fetchMock = vi.fn(healthyResponse);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useConnectorHealth([connector]));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => result.current.refreshHealth(connector.id));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('clears cached health while a re-enabled connector is checked again', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(healthyResponse)
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useConnectorHealth([{ ...connector, enabled }]),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(result.current.getHealthState(connector)?.data?.overall).toBe('healthy'));
    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.getHealthState(connector)).toBeUndefined());
  });

  it('times out a hung request so polling can retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useConnectorHealth([connector]));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.getHealthState(connector)?.data).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
