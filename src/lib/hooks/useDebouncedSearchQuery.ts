'use client';

import { useEffect, useState } from 'react';

export const DESKTOP_SEARCH_DEBOUNCE_MS = 80;
export const MOBILE_SEARCH_DEBOUNCE_MS = 300;
export const KEYWORD_RESULTS_VISIBILITY_BUDGET_MS = 150;

interface UseDebouncedSearchQueryOptions {
  enabled: boolean;
  debounceMs: number;
  immediateQuery?: string;
}

export function useDebouncedSearchQuery(
  query: string,
  {
    enabled,
    debounceMs,
    immediateQuery = '',
  }: UseDebouncedSearchQueryOptions,
): string {
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    if (!enabled) return;

    const normalizedQuery = query.trim();
    const delay = !normalizedQuery || normalizedQuery === immediateQuery.trim()
      ? 0
      : debounceMs;
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(normalizedQuery);
    }, delay);

    return () => window.clearTimeout(timeoutId);
  }, [debounceMs, enabled, immediateQuery, query]);

  return debouncedQuery;
}
