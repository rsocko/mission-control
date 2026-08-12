'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KpiCardData } from '@/lib/kpi/registry';
import type { StatsSnapshot } from '@/lib/stats';

interface UseStatsOptions {
  slugs?: string[];
  /** Auto-refresh interval in milliseconds (default: 60000 = 1 min) */
  refreshInterval?: number;
  /** Include auto-surfaced KPIs */
  autoSurface?: boolean;
}

interface StatsResponse {
  cards: KpiCardData[];
  autoSurfaced: (KpiCardData & { reason: string })[];
}

/**
 * React hook for fetching KPI stats from the dashboard KPI API.
 * Supports selective slug fetching and auto-refresh.
 */
export function useStats(options: UseStatsOptions = {}) {
  const { slugs, refreshInterval = 60_000, autoSurface = false } = options;
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (slugs && slugs.length > 0) {
        params.set('slugs', slugs.join(','));
      }
      if (autoSurface) {
        params.set('autoSurface', 'true');
      }
      const url = `/api/dashboard/kpis${params.toString() ? `?${params}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Stats API error: ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [slugs?.join(','), autoSurface]);

  useEffect(() => {
    fetchStats();
    if (refreshInterval > 0) {
      const interval = setInterval(fetchStats, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [fetchStats, refreshInterval]);

  /** Get a single KPI result by slug */
  const getKpi = useCallback((slug: string): KpiCardData | undefined => {
    return data?.cards.find(c => c.slug === slug);
  }, [data]);

  return {
    cards: data?.cards ?? [],
    autoSurfaced: data?.autoSurfaced ?? [],
    loading,
    error,
    refetch: fetchStats,
    getKpi,
  };
}

/**
 * Hook for fetching from the shared stats engine directly (for insights page).
 * Returns the full StatsSnapshot with all computed KPIs.
 */
export function useStatsSnapshot(options: { slugs?: string[]; today?: string } = {}) {
  const { slugs, today } = options;
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    if (slugs && slugs.length > 0) params.set('slugs', slugs.join(','));
    if (today) params.set('today', today);

    fetch(`/api/stats${params.toString() ? `?${params}` : ''}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setSnapshot(data); })
      .finally(() => setLoading(false));
  }, [slugs?.join(','), today]);

  return { snapshot, loading };
}
