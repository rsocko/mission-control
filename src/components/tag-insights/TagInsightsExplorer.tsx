'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Network, Search, Table2, Tags } from 'lucide-react';
import TagGalaxy from './TagGalaxy';
import TagInsightsMatrix from './TagInsightsMatrix';
import { filterTagInsights, TAG_GALAXY_EDGE_LIMIT } from '@/lib/tag-insights/galaxy';
import type { TagInsights } from '@/lib/tag-insights/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TOP_N_OPTIONS = [10, 15, 20, 25, 30];
type TagView = 'galaxy' | 'matrix';
interface TagInsightsResult {
  data: TagInsights;
  queryKey: string;
}

export default function TagInsightsExplorer({
  initialView = 'galaxy',
}: {
  initialView?: TagView;
}) {
  const [view, setView] = useState<TagView>(initialView);
  const [topN, setTopN] = useState(15);
  const [minCooccurrence, setMinCooccurrence] = useState(2);
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<TagInsightsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/tag-insights?topN=${topN}&minCooccurrence=${minCooccurrence}`,
          { signal: controller.signal },
        );
        const nextData = await response.json() as TagInsights & { error?: string };
        if (!response.ok) throw new Error(nextData.error ?? 'Tag insights could not be loaded.');
        setResult({
          data: nextData,
          queryKey: `${topN}:${minCooccurrence}`,
        });
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setError(fetchError instanceof Error ? fetchError.message : 'Tag insights could not be loaded.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 150);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [topN, minCooccurrence, reloadKey]);

  const data = result?.data ?? null;
  const visibleData = useMemo(
    () => data ? filterTagInsights(data, search) : null,
    [data, search],
  );

  return (
    <main className="h-full overflow-y-auto bg-[var(--background)] text-[var(--text-primary)]">
      <div className="mx-auto max-w-[100rem] px-3 py-4 sm:px-5">
        <header className="mb-4 flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <div className="flex items-center gap-2">
              <Tags className="text-[var(--accent-400)]" aria-hidden="true" />
              <h1 className="text-xl font-bold">Tag relationships</h1>
            </div>
            <p className="mt-1 text-sm text-[var(--text-tertiary)]">
              Explore deterministic task co-occurrence with exact task provenance.
            </p>
          </div>
          <div className="flex rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-1" aria-label="Tag visualization">
            <button
              type="button"
              aria-pressed={view === 'galaxy'}
              onClick={() => setView('galaxy')}
              className="flex h-8 items-center gap-1.5 rounded-md px-3 text-xs aria-pressed:bg-[var(--accent-600)] aria-pressed:text-white"
            >
              <Network size={14} aria-hidden="true" /> Galaxy
            </button>
            <button
              type="button"
              aria-pressed={view === 'matrix'}
              onClick={() => setView('matrix')}
              className="flex h-8 items-center gap-1.5 rounded-md px-3 text-xs aria-pressed:bg-[var(--accent-600)] aria-pressed:text-white"
            >
              <Table2 size={14} aria-hidden="true" /> Matrix
            </button>
          </div>
        </header>

        <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-0)]">
          <div className="flex flex-wrap items-end gap-4 border-b border-[var(--border)] p-4">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Tags shown</span>
              <Select value={String(topN)} onValueChange={(value) => setTopN(Number(value))}>
                <SelectTrigger aria-label="Tags shown" className="h-9 min-h-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                {TOP_N_OPTIONS.map((count) => (
                    <SelectItem key={count} value={String(count)}>Top {count}</SelectItem>
                ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid min-w-52 flex-1 gap-1 text-sm sm:max-w-sm">
              <span className="flex justify-between font-medium">
                <span>Minimum shared tasks</span>
                <output>{minCooccurrence}</output>
              </span>
              <input
                aria-label="Minimum shared tasks"
                type="range"
                min="1"
                max="20"
                value={minCooccurrence}
                onChange={(event) => setMinCooccurrence(Number(event.target.value))}
                className="accent-[var(--accent-500)]"
              />
            </label>
            <label className="grid min-w-52 flex-1 gap-1 text-sm sm:max-w-sm">
              <span className="font-medium">Filter tags</span>
              <span className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tag names"
                  className="h-9 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-1)] pl-8 pr-3"
                />
              </span>
            </label>
            <p className="text-xs text-[var(--text-muted)]">
              Limits: 30 tags · {TAG_GALAXY_EDGE_LIMIT} relationships · 5,000 tasks
            </p>
            {data?.meta.truncated ? (
              <p className="w-full text-xs text-amber-400">
                Showing relationships from the first {data.meta.taskLimit.toLocaleString()} tagged tasks.
              </p>
            ) : null}
          </div>

          {loading && !data ? (
            <div className="flex min-h-[30rem] items-center justify-center" role="status">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--accent-400)]" />
              <span className="sr-only">Loading tag relationships</span>
            </div>
          ) : error ? (
            <div className="flex min-h-[30rem] flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
              <AlertCircle className="text-red-400" aria-hidden="true" />
              <p className="text-sm text-red-400">{error}</p>
              <button
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
                className="rounded-md bg-[var(--surface-2)] px-3 py-2 text-sm hover:bg-[var(--surface-3)]"
              >
                Retry
              </button>
            </div>
          ) : data && data.tags.length === 0 ? (
            <div className="flex min-h-[30rem] flex-col items-center justify-center gap-2 p-6 text-center">
              <Tags className="text-[var(--text-muted)]" aria-hidden="true" />
              <h2 className="font-semibold">No tag relationships yet</h2>
              <p className="max-w-md text-sm text-[var(--text-tertiary)]">
                Add at least one non-system tag to a task to begin exploring tag activity.
              </p>
            </div>
          ) : visibleData && visibleData.tags.length === 0 ? (
            <div className="flex min-h-[30rem] flex-col items-center justify-center gap-2 p-6 text-center">
              <Search className="text-[var(--text-muted)]" aria-hidden="true" />
              <h2 className="font-semibold">No matching tags</h2>
              <p className="text-sm text-[var(--text-tertiary)]">Clear or change the tag filter.</p>
            </div>
          ) : visibleData ? (
            <div aria-busy={loading}>
              {view === 'galaxy'
                ? (
                    <TagGalaxy
                      data={visibleData}
                      layoutKey={`${result?.queryKey}:${search}`}
                    />
                  )
                : <TagInsightsMatrix data={visibleData} />}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
