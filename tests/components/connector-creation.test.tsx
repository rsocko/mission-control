import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConnectorCreation } from '@/app/settings/components/useConnectorCreation';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useConnectorCreation', () => {
  it('owns the shared pending and success lifecycle for connector setup', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    })));
    const { result } = renderHook(() => useConnectorCreation());

    let creation!: Promise<unknown>;
    act(() => {
      creation = result.current.create({ type: 'scout', name: 'Scout' });
    });
    expect(result.current.status).toBe('creating');
    expect(result.current.error).toBeNull();

    resolveResponse(new Response(JSON.stringify({ id: 'scout-primary' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    await act(async () => creation);

    expect(result.current.status).toBe('success');
    expect(result.current.connector).toEqual({ id: 'scout-primary' });
    expect(fetch).toHaveBeenCalledWith('/api/connectors', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ type: 'scout', name: 'Scout' }),
    }));
  });

  it('normalizes API and transport failures for every wizard', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('Duplicate connector', { status: 409 }))
      .mockRejectedValueOnce(new Error('Network unavailable')));
    const { result } = renderHook(() => useConnectorCreation());

    await act(async () => {
      await expect(result.current.create({ type: 'scout' })).rejects.toThrow('Duplicate connector');
    });
    expect(result.current).toMatchObject({ status: 'error', error: 'Duplicate connector' });

    await act(async () => {
      await expect(result.current.create({ type: 'github-issues' })).rejects.toThrow('Network unavailable');
    });
    expect(result.current).toMatchObject({ status: 'error', error: 'Network unavailable' });
  });
});
