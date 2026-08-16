'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_STATS, type Stats } from '@/components/triage/types';
import type { TriageItem, TriageSourcePlatform, TriageStatus } from '@/types';
import type { TriageSortBy } from '@/lib/triage/query';

function getValidSelectedId(items: TriageItem[], current: string | null) {
  if (current && items.some((item) => item.id === current)) return current;
  return items[0]?.id || null;
}

interface UseTriageDataParams {
  status: TriageStatus | 'all';
  source: TriageSourcePlatform | 'all';
  query: string;
  sortBy?: TriageSortBy;
}

const PAGE_SIZE = 200;

export function useTriageData({ status, source, query, sortBy }: UseTriageDataParams) {
  const [items, setItems] = useState<TriageItem[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [totalFiltered, setTotalFiltered] = useState(0);
  const offsetRef = useRef(0);

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedId) || null, [items, selectedId]);

  const applyLoadedData = useCallback((data: { items?: TriageItem[]; stats?: Stats; hasMore?: boolean; totalFiltered?: number }) => {
    setItems(data.items || []);
    setStats(data.stats || EMPTY_STATS);
    setHasMore(data.hasMore ?? false);
    setTotalFiltered(data.totalFiltered ?? 0);
    setSelectedId((current) => getValidSelectedId(data.items || [], current));
    offsetRef.current = (data.items || []).length;
  }, []);

  const fetchItems = useCallback(async (offset = 0) => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (source !== 'all') params.set('source', source);
    if (query.trim()) params.set('q', query.trim());
    if (sortBy && sortBy !== 'relevance') params.set('sortBy', sortBy);
    params.set('limit', String(PAGE_SIZE));
    if (offset > 0) params.set('offset', String(offset));
    const response = await fetch(`/api/triage?${params.toString()}`);
    if (!response.ok) throw new Error(`Triage fetch failed: ${response.status}`);
    return response.json();
  }, [query, source, sortBy, status]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchItems(0);
      applyLoadedData(data);
    } catch {
      setItems([]);
      setHasMore(false);
    }
    setLoading(false);
  }, [applyLoadedData, fetchItems]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchItems(offsetRef.current);
      setItems((prev) => {
        const combined = [...prev, ...(data.items || [])];
        offsetRef.current = combined.length;
        return combined;
      });
      setHasMore(data.hasMore ?? false);
      setTotalFiltered(data.totalFiltered ?? 0);
    } catch {
      // Silent — user can retry
    }
    setLoadingMore(false);
  }, [fetchItems, hasMore, loadingMore]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const data = await fetchItems(0);
        if (cancelled) return;
        applyLoadedData(data);
      } catch {
        if (!cancelled) {
          setItems([]);
          setHasMore(false);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLoadedData, fetchItems]);

  // Re-fetch when the tab becomes visible again (e.g. after running
  // an import from the browser extension in another tab/window).
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void loadItems();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadItems]);

  return { items, stats, selectedId, setSelectedId, selectedItem, loading, loadingMore, hasMore, totalFiltered, loadItems, loadMore };
}
