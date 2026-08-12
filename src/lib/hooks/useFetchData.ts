'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type FetchStatus = 'idle' | 'loading' | 'success' | 'error';

interface UseFetchDataOptions<T> {
  /** Initial data before the first fetch completes. */
  initialData?: T;
  /** If false, the hook won't fetch automatically. Useful for conditional fetching. */
  enabled?: boolean;
}

interface UseFetchDataReturn<T> {
  /** The fetched data (or initialData before the first successful fetch). */
  data: T | undefined;
  /** Current fetch status. */
  status: FetchStatus;
  /** Convenience boolean – true while fetching. */
  loading: boolean;
  /** Error from the most recent fetch, if any. */
  error: Error | null;
  /** Manually trigger a refetch. Stale-request protection is built in. */
  refetch: () => Promise<void>;
  /** Replace the data in state without refetching. */
  setData: React.Dispatch<React.SetStateAction<T | undefined>>;
}

/**
 * Fetches JSON from a URL with built-in loading/error state and stale-request
 * cancellation. Re-fetches automatically when `url` changes.
 *
 * Pass `url = null` to skip fetching (e.g. when a required param isn't ready).
 *
 * @example
 * const { data, loading, refetch } = useFetchData<TaskResponse>(
 *   `/api/tasks?${params.toString()}`
 * );
 */
export function useFetchData<T>(
  url: string | null,
  options: UseFetchDataOptions<T> = {},
): UseFetchDataReturn<T> {
  const { initialData, enabled = true } = options;

  const [data, setData] = useState<T | undefined>(initialData);
  const [status, setStatus] = useState<FetchStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  // Track request identity so stale responses are discarded.
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    if (!url || !enabled) return;

    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setError(null);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as T;

      // Only apply if this is still the latest request.
      if (requestId === requestIdRef.current) {
        setData(json);
        setStatus('success');
      }
    } catch (err) {
      if (requestId === requestIdRef.current) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setStatus('error');
      }
    }
  }, [url, enabled]);

  useEffect(() => {
    if (url && enabled) {
      fetchData();
    }
  }, [fetchData, url, enabled]);

  return {
    data,
    status,
    loading: status === 'loading',
    error,
    refetch: fetchData,
    setData,
  };
}

/**
 * Fetches JSON from multiple URLs in parallel via `Promise.all`, returning
 * a tuple of results. Useful for dashboard-style pages that load from
 * several endpoints simultaneously.
 *
 * @example
 * const { data, loading, refetch } = useMultiFetch({
 *   tasks: '/api/tasks?limit=50',
 *   alerts: '/api/alerts',
 *   projects: '/api/hub-projects',
 * });
 * // data?.tasks, data?.alerts, data?.projects
 */
export function useMultiFetch<T extends Record<string, unknown>>(
  endpoints: Record<keyof T, string | null>,
  options: { enabled?: boolean } = {},
): UseFetchDataReturn<T> {
  const { enabled = true } = options;

  const [data, setData] = useState<T | undefined>(undefined);
  const [status, setStatus] = useState<FetchStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  // Stable key for the endpoints object.
  const endpointsKey = JSON.stringify(endpoints);

  const fetchAll = useCallback(async () => {
    if (!enabled) return;

    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setError(null);

    const keys = Object.keys(endpoints) as (keyof T)[];
    const urls = keys.map((k) => endpoints[k]);

    // Skip if any required URL is null.
    if (urls.some((u) => u === null)) return;

    try {
      const responses = await Promise.all(
        urls.map((url) => fetch(url!)),
      );

      // Check for HTTP errors.
      for (const res of responses) {
        if (!res.ok) {
          throw new Error(`Fetch failed: ${res.status} ${res.statusText} (${res.url})`);
        }
      }

      const results = await Promise.all(responses.map((r) => r.json()));

      if (requestId === requestIdRef.current) {
        const result = {} as Record<keyof T, unknown>;
        keys.forEach((key, i) => {
          result[key] = results[i];
        });
        setData(result as T);
        setStatus('success');
      }
    } catch (err) {
      if (requestId === requestIdRef.current) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setStatus('error');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointsKey, enabled]);

  useEffect(() => {
    if (enabled) {
      fetchAll();
    }
  }, [fetchAll, enabled]);

  return {
    data,
    status,
    loading: status === 'loading',
    error,
    refetch: fetchAll,
    setData,
  };
}
