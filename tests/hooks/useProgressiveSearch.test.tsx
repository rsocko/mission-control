import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/lib/search/fts';
import { useProgressiveSearch } from '@/lib/hooks/useProgressiveSearch';

function searchResult(id: string, source: SearchResult['source']): SearchResult {
  return {
    type: 'task',
    id,
    title: id,
    snippet: '',
    score: 1,
    source,
    href: `/?taskId=${id}`,
    metadata: {},
  };
}

function response(payload: object) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('useProgressiveSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes keyword results before semantic capability detection finishes', async () => {
    let resolveStatus!: (value: Response) => void;
    const pendingStatus = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('__status_check__')) return pendingStatus;
      if (url.includes('mode=keyword')) {
        return response({ results: [searchResult('exact', 'fts')], durationMs: 12 });
      }
      if (url.includes('mode=semantic')) {
        return response({ results: [searchResult('related', 'semantic')], durationMs: 80 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const { result } = renderHook(() => useProgressiveSearch({
      query: 'alpha',
      enabled: true,
    }));

    await waitFor(() => expect(result.current.results.map((item) => item.id)).toEqual(['exact']));
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('mode=semantic'))).toBe(false);

    await act(async () => {
      resolveStatus(new Response(JSON.stringify({
        semanticEnabled: true,
        semanticAvailable: true,
        results: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    await waitFor(() => {
      expect(result.current.results.map((item) => item.id)).toEqual(['exact', 'related']);
    });
  });

  it('does not request a semantic embedding when enrichment is disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('__status_check__')) {
        return response({
          semanticEnabled: false,
          semanticAvailable: true,
          results: [],
        });
      }
      if (url.includes('mode=keyword')) {
        return response({ results: [searchResult('exact', 'fts')], durationMs: 10 });
      }
      throw new Error(`Unexpected semantic request: ${url}`);
    });

    const { result } = renderHook(() => useProgressiveSearch({
      query: 'alpha',
      enabled: true,
    }));

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('mode=semantic'))).toBe(false);
  });

  it('ignores a stale keyword response after the query changes', async () => {
    let resolveAlpha!: (value: Response) => void;
    const pendingAlpha = new Promise<Response>((resolve) => {
      resolveAlpha = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('__status_check__')) {
        return response({ semanticEnabled: false, semanticAvailable: false, results: [] });
      }
      if (url.includes('q=alpha')) return pendingAlpha;
      if (url.includes('q=beta')) {
        return response({ results: [searchResult('beta', 'fts')], durationMs: 8 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const { result, rerender } = renderHook(
      ({ query }) => useProgressiveSearch({ query, enabled: true }),
      { initialProps: { query: 'alpha' } },
    );
    rerender({ query: 'beta' });

    await waitFor(() => expect(result.current.results[0]?.id).toBe('beta'));
    await act(async () => {
      resolveAlpha(new Response(JSON.stringify({
        results: [searchResult('alpha', 'fts')],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    expect(result.current.results[0]?.id).toBe('beta');
  });
});
