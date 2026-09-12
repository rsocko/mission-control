import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/lib/search/fts';
import { useProgressiveSearch } from '@/lib/hooks/useProgressiveSearch';
import {
  DESKTOP_SEARCH_DEBOUNCE_MS,
  KEYWORD_RESULTS_VISIBILITY_BUDGET_MS,
  MOBILE_SEARCH_DEBOUNCE_MS,
  useDebouncedSearchQuery,
} from '@/lib/hooks/useDebouncedSearchQuery';

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
    vi.useRealTimers();
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

  it('sends server-side scope, source, status, and date filters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('__status_check__')) {
        return response({ semanticEnabled: false, semanticAvailable: false, results: [] });
      }
      return response({ results: [], durationMs: 5 });
    });

    renderHook(() => useProgressiveSearch({
      query: 'alpha',
      enabled: true,
      type: 'notifications',
      notificationKind: 'notes',
      source: 'Project Alpha',
      status: 'open',
      date: '7d',
    }));

    await waitFor(() => {
      const keywordUrl = fetchSpy.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes('mode=keyword'));
      expect(keywordUrl).toContain('type=notifications');
      expect(keywordUrl).toContain('notificationKind=notes');
      expect(keywordUrl).toContain('source=Project+Alpha');
      expect(keywordUrl).toContain('status=open');
      expect(keywordUrl).toContain('date=7d');
    });
  });

  it.each([
    ['desktop', DESKTOP_SEARCH_DEBOUNCE_MS],
    ['mobile', MOBILE_SEARCH_DEBOUNCE_MS],
  ])(
    'publishes %s keyword results within the post-debounce visibility budget',
    async (_surface, debounceMs) => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.includes('__status_check__')) {
          return new Promise<Response>(() => undefined);
        }
        if (url.includes('mode=keyword')) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              void response({
                results: [searchResult('visible', 'fts')],
                durationMs: KEYWORD_RESULTS_VISIBILITY_BUDGET_MS,
              }).then(resolve);
            }, KEYWORD_RESULTS_VISIBILITY_BUDGET_MS);
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const { result, rerender } = renderHook(
        ({ query }) => {
          const debouncedQuery = useDebouncedSearchQuery(query, {
            enabled: true,
            debounceMs,
          });
          return useProgressiveSearch({ query: debouncedQuery, enabled: true });
        },
        { initialProps: { query: '' } },
      );

      rerender({ query: 'alpha' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(debounceMs);
      });
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('mode=keyword'))).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(KEYWORD_RESULTS_VISIBILITY_BUDGET_MS - 1);
      });
      expect(result.current.results).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(
        result.current.results.map((item) => item.id),
        `Visible-results latency gate failed: ${JSON.stringify({
          surface: _surface,
          configuredDebounceMs: debounceMs,
          breachedBudget: `keyword results visible <= ${KEYWORD_RESULTS_VISIBILITY_BUDGET_MS} ms after debounce`,
          deterministicElapsedMs: debounceMs + KEYWORD_RESULTS_VISIBILITY_BUDGET_MS,
        })}`,
      ).toEqual(['visible']);
    },
  );
});
