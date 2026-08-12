'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Crosshair, Flame, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { cn } from '@/lib/utils/cn';
import type { TriageItem, TriageSourcePlatform } from '@/types';
import { CONTENT_TYPE_OPTIONS, SOURCE_OPTIONS } from '@/components/triage/types';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';

interface MobileTriageStreamProps {
  items: TriageItem[];
  loading: boolean;
  onItemTap: (id: string) => void;
  onSwitchToFocus?: () => void;
  onRefresh?: () => Promise<void>;
  activeSourceFilter: TriageSourcePlatform | 'all';
  onSourceFilterChange: (source: TriageSourcePlatform | 'all') => void;
  activeTypeFilter: string | null;
  onTypeFilterChange: (type: string | null) => void;
}

type PriorityFilter = 'all' | TriageItem['aiUrgency'];

const SOURCE_BRAND: Record<string, { bg: string; ring: string; text: string }> = {
  reddit: { bg: 'bg-orange-500/15', ring: 'ring-orange-400/30', text: 'text-orange-200' },
  github: { bg: 'bg-violet-500/15', ring: 'ring-violet-400/30', text: 'text-violet-300' },
  youtube: { bg: 'bg-red-500/15', ring: 'ring-red-400/30', text: 'text-red-300' },
  twitter: { bg: 'bg-sky-500/15', ring: 'ring-sky-400/30', text: 'text-sky-300' },
  instagram: { bg: 'bg-pink-500/15', ring: 'ring-pink-400/30', text: 'text-pink-300' },
  facebook: { bg: 'bg-blue-500/15', ring: 'ring-blue-400/30', text: 'text-blue-300' },
  tiktok: { bg: 'bg-cyan-500/15', ring: 'ring-cyan-400/30', text: 'text-cyan-300' },
  pinterest: { bg: 'bg-rose-500/15', ring: 'ring-rose-400/30', text: 'text-rose-300' },
  web: { bg: 'bg-slate-500/15', ring: 'ring-slate-400/30', text: 'text-slate-300' },
};

const PRIORITY_OPTIONS: Array<{
  value: PriorityFilter;
  label: string;
  activeClassName: string;
}> = [
  { value: 'all', label: 'All priorities', activeClassName: 'bg-white/10 text-white ring-white/15' },
  { value: 'time_sensitive', label: 'Time sensitive', activeClassName: 'bg-red-500/15 text-red-200 ring-red-400/30' },
  { value: 'trending', label: 'Trending', activeClassName: 'bg-amber-500/15 text-amber-200 ring-amber-400/30' },
  { value: 'evergreen', label: 'Evergreen', activeClassName: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30' },
];

function formatTimeAgo(dateStr: string) {
  const timestamp = new Date(dateStr).getTime();
  if (Number.isNaN(timestamp)) return 'Just now';

  const diffMs = timestamp - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour');
  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 7) return formatter.format(diffDays, 'day');
  const diffWeeks = Math.round(diffDays / 7);
  if (Math.abs(diffWeeks) < 5) return formatter.format(diffWeeks, 'week');
  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) return formatter.format(diffMonths, 'month');
  return formatter.format(Math.round(diffDays / 365), 'year');
}

function getUrgencyLabel(urgency: TriageItem['aiUrgency']) {
  if (urgency === 'time_sensitive') return 'Time sensitive';
  if (urgency === 'trending') return 'Trending';
  return 'Evergreen';
}

function getUrgencyClasses(urgency: TriageItem['aiUrgency']) {
  if (urgency === 'time_sensitive') return 'border-red-400/20 bg-red-500/12 text-red-200';
  if (urgency === 'trending') return 'border-amber-400/20 bg-amber-500/12 text-amber-200';
  return 'border-emerald-400/20 bg-emerald-500/12 text-emerald-200';
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="px-4 text-xs font-medium uppercase tracking-[0.24em] text-[var(--text-muted)]">
        {label}
      </div>
      <div className="overflow-x-auto px-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-max items-center gap-2 pb-1">
          {children}
        </div>
      </div>
    </div>
  );
}

export default function MobileTriageStream({
  items,
  loading,
  onItemTap,
  onSwitchToFocus,
  onRefresh,
  activeSourceFilter,
  onSourceFilterChange,
  activeTypeFilter,
  onTypeFilterChange,
}: MobileTriageStreamProps) {
  const [activePriorityFilter, setActivePriorityFilter] = useState<PriorityFilter>('all');
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  const handleRefresh = useCallback(async () => {
    await onRefresh?.();
  }, [onRefresh]);

  const { containerRef, isRefreshing, pullDistance, containerProps, contentStyle } = usePullToRefresh({
    onRefresh: handleRefresh,
    enabled: !!onRefresh,
  });

  const sourceOptions = useMemo(
    () => SOURCE_OPTIONS.filter((option) => option.value === 'all' || items.some((item) => item.sourcePlatform === option.value)),
    [items],
  );

  const typeOptions = useMemo(
    () => CONTENT_TYPE_OPTIONS.filter((option) => items.some((item) => item.contentType === option.value)),
    [items],
  );

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (activeSourceFilter !== 'all' && item.sourcePlatform !== activeSourceFilter) return false;
      if (activeTypeFilter && item.contentType !== activeTypeFilter) return false;
      if (activePriorityFilter !== 'all' && item.aiUrgency !== activePriorityFilter) return false;
      return true;
    });
  }, [activePriorityFilter, activeSourceFilter, activeTypeFilter, items]);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-0 flex-col overflow-y-auto overscroll-y-contain bg-slate-950 text-white sm:hidden"
      {...containerProps}
    >
      {/* Pull-to-refresh indicator — absolutely positioned so it doesn't push the title bar */}
      {(pullDistance > 0 || isRefreshing) && (
        <div className="absolute left-0 right-0 top-0 z-50 flex items-center justify-center pointer-events-none" style={{ height: `${pullDistance}px` }}>
          <RefreshCw
            size={18}
            className={cn('text-sky-300', isRefreshing && 'animate-spin')}
            style={{ opacity: Math.min(pullDistance / 32, 1), transform: `rotate(${pullDistance * 3}deg)` }}
          />
        </div>
      )}

      <div style={contentStyle}>
      <div className="sticky top-0 z-20 border-b border-white/5 bg-slate-950/95 pb-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <div className="flex items-start justify-between gap-3 px-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-[var(--text-muted)]">Triage stream</p>
            <h2 className="mt-1 text-xl font-semibold text-white">Inbox feed</h2>
            <p className="mt-1 text-sm text-slate-400">{filteredItems.length} item{filteredItems.length === 1 ? '' : 's'} in view</p>
          </div>

          <button
            type="button"
            onClick={onSwitchToFocus}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-white/[0.06] px-4 text-sm font-medium text-white ring-1 ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-50"
            disabled={!onSwitchToFocus}
          >
            <Crosshair size={16} className="text-sky-300" />
            Focus mode
          </button>
        </div>

        <div className="mt-3">
          <button
            type="button"
            onClick={() => setFiltersExpanded((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium uppercase tracking-[0.24em] text-[var(--text-muted)] transition-colors hover:text-slate-300"
            aria-expanded={filtersExpanded}
            aria-label="Toggle filters"
          >
            <span>Filters{activeSourceFilter !== 'all' || activeTypeFilter || activePriorityFilter !== 'all' ? ' (active)' : ''}</span>
            <ChevronDown
              size={14}
              className={cn('transition-transform', filtersExpanded && 'rotate-180')}
            />
          </button>
          {filtersExpanded && (
            <div className="mt-1 space-y-3 pb-1">
              <FilterRow label="Sources">
                {sourceOptions.map((option) => {
                  const isActive = activeSourceFilter === option.value;
                  const brand = option.value === 'all'
                    ? { bg: 'bg-white/[0.06]', ring: 'ring-white/10', text: 'text-slate-200' }
                    : SOURCE_BRAND[option.value] || SOURCE_BRAND.web;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onSourceFilterChange(option.value)}
                      aria-pressed={isActive}
                      className={cn(
                        'inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium ring-1 transition',
                        isActive
                          ? `${brand.bg} ${brand.ring} ${brand.text}`
                          : 'bg-white/[0.04] text-slate-300 ring-white/8 hover:bg-white/[0.08]',
                      )}
                    >
                      {option.value === 'all' ? (
                        <span className="h-2.5 w-2.5 rounded-full bg-slate-400" />
                      ) : (
                        <TriageSourceIcon source={option.value} size={16} className="shrink-0" decorative />
                      )}
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </FilterRow>

              <FilterRow label="Priority">
                {PRIORITY_OPTIONS.map((option) => {
                  const isActive = activePriorityFilter === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setActivePriorityFilter(option.value)}
                      aria-pressed={isActive}
                      className={cn(
                        'inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium ring-1 transition',
                        isActive
                          ? option.activeClassName
                          : 'bg-white/[0.04] text-slate-300 ring-white/8 hover:bg-white/[0.08]',
                      )}
                    >
                      {option.value === 'time_sensitive' ? <Flame size={14} /> : null}
                      {option.label}
                    </button>
                  );
                })}
              </FilterRow>

              <FilterRow label="Type">
                <button
                  type="button"
                  onClick={() => onTypeFilterChange(null)}
                  aria-pressed={!activeTypeFilter}
                  className={cn(
                    'inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 transition',
                    !activeTypeFilter
                      ? 'bg-sky-500/15 text-sky-200 ring-sky-400/30'
                      : 'bg-white/[0.04] text-slate-300 ring-white/8 hover:bg-white/[0.08]',
                  )}
                >
                  All types
                </button>
                {typeOptions.map((option) => {
                  const isActive = activeTypeFilter === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onTypeFilterChange(isActive ? null : option.value)}
                      aria-pressed={isActive}
                      className={cn(
                        'inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 transition',
                        isActive
                          ? 'bg-sky-500/15 text-sky-200 ring-sky-400/30'
                          : 'bg-white/[0.04] text-slate-300 ring-white/8 hover:bg-white/[0.08]',
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </FilterRow>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 px-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] pt-4">
        {loading ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <Loader2 size={24} className="animate-spin text-sky-300" />
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center rounded-3xl bg-white/[0.03] px-6 text-center ring-1 ring-white/5">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.05] ring-1 ring-white/10">
              <Sparkles size={22} className="text-sky-300" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-white">Nothing matches these filters</h3>
            <p className="mt-2 max-w-[18rem] text-sm text-slate-400">
              Try a different source, priority, or content type to widen your stream.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredItems.map((item) => {
              const sourceBrand = SOURCE_BRAND[item.sourcePlatform] || SOURCE_BRAND.web;
              const preview = item.aiSummary || item.description || 'No preview available yet.';

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onItemTap(item.id)}
                  className={cn(
                    'w-full rounded-2xl bg-white/[0.04] p-4 text-left backdrop-blur-xl ring-1 ring-white/5 transition active:scale-[0.99]',
                    'hover:bg-white/[0.06]',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className={cn('inline-flex h-9 w-9 items-center justify-center rounded-full ring-1', sourceBrand.bg, sourceBrand.ring)}>
                      <TriageSourceIcon source={item.sourcePlatform} size={16} className="shrink-0" />
                    </div>

                    <div className="flex items-center gap-2 pl-2">
                      <span className="text-sm font-semibold text-sky-300 [font-variant-numeric:tabular-nums]">
                        {item.aiRelevanceScore}
                      </span>
                      <ChevronRight size={16} className="text-[var(--text-muted)]" />
                    </div>
                  </div>

                  <h3 className="mt-3 line-clamp-2 text-base font-semibold text-white">
                    {item.title}
                  </h3>

                  {item.thumbnailUrl && (
                    <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-white/10">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        className="h-32 w-full bg-slate-900 object-cover"
                        loading="lazy"
                      />
                    </div>
                  )}

                  <p className="mt-2 line-clamp-2 text-sm text-slate-400">
                    {preview}
                  </p>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>{formatTimeAgo(item.capturedAt || item.ingestedAt)}</span>
                    {item.aiUrgency !== 'evergreen' && (
                      <span className={cn('inline-flex items-center rounded-full border px-2 py-1 font-medium', getUrgencyClasses(item.aiUrgency))}>
                        {getUrgencyLabel(item.aiUrgency)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
