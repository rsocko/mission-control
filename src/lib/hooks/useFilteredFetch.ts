'use client';

import { useMemo } from 'react';
import { useFetchData } from './useFetchData';

type FilterValue = string | number | boolean | string[] | null | undefined;

/**
 * Builds a URLSearchParams string from a filters object.
 *
 * - `undefined` and `null` values are omitted.
 * - Values matching their `defaults` entry are omitted (avoids sending no-op params).
 * - Arrays are joined with commas.
 * - Booleans are serialized as `'true'` / `'false'`.
 */
export function buildSearchParams(
  filters: Record<string, FilterValue>,
  defaults?: Record<string, FilterValue>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;

    // Skip values that match defaults.
    if (defaults && key in defaults && value === defaults[key]) continue;

    if (Array.isArray(value)) {
      if (value.length > 0) {
        params.set(key, value.join(','));
      }
    } else {
      const str = String(value);
      if (str) params.set(key, str);
    }
  }

  return params.toString();
}

interface UseFilteredFetchOptions<T> {
  /** Default filter values — matching values are excluded from the query string. */
  defaults?: Record<string, FilterValue>;
  /** Initial data before the first fetch completes. */
  initialData?: T;
  /** If false, the hook won't fetch. */
  enabled?: boolean;
}

/**
 * Combines filter state → URLSearchParams → fetch in a single hook.
 *
 * Automatically refetches when filters change.
 *
 * @example
 * const { data, loading, refetch } = useFilteredFetch<TaskResponse>(
 *   '/api/tasks',
 *   {
 *     parentOnly: 'true',
 *     openOnly: showCompleted ? undefined : 'true',
 *     source: sourceFilter || undefined,
 *     tag: tagFilter.length === 1 ? tagFilter[0] : undefined,
 *     tagSlugs: tagFilter.length > 1 ? tagFilter : undefined,
 *     limit: String(PAGE_SIZE),
 *     offset: String(offset),
 *     sortBy: sortBy !== 'priority' ? sortBy : undefined,
 *   },
 * );
 */
export function useFilteredFetch<T>(
  baseUrl: string,
  filters: Record<string, FilterValue>,
  options: UseFilteredFetchOptions<T> = {},
) {
  const { defaults, ...fetchOptions } = options;

  const url = useMemo(() => {
    const qs = buildSearchParams(filters, defaults);
    return qs ? `${baseUrl}?${qs}` : baseUrl;
  }, [baseUrl, filters, defaults]);

  return useFetchData<T>(url, fetchOptions);
}
