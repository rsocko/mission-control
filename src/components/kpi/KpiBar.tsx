'use client';

import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { X, ChevronLeft, ChevronRight, BarChart3, RotateCcw } from 'lucide-react';
import { staggerContainer } from '@/lib/motion';
import { KpiCard } from '@/components/kpi/KpiCard';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  KPI_REGISTRY, KPI_PRESETS, DEFAULT_KPI_SLUGS, MAX_KPI_CARDS,
  type KpiCardData,
} from '@/lib/kpi/registry';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import type { Variants } from 'motion/react';

const KPI_ROTATION_INTERVAL = 8000; // 8 seconds
const DISMISSED_KEY = 'dashboard_kpis_dismissed';

interface KpiBarConfig {
  cards: string[];
  pinned: string[];
  visibleSlots: number;
  rotationInterval: number;
  pauseOnHover: boolean;
  autoSurface: boolean;
}

const DEFAULT_CONFIG: KpiBarConfig = {
  cards: DEFAULT_KPI_SLUGS,
  pinned: [],
  visibleSlots: 4,
  rotationInterval: KPI_ROTATION_INTERVAL,
  pauseOnHover: true,
  autoSurface: true,
};

function normalizeConfig(value: unknown): KpiBarConfig {
  const candidate = value && typeof value === 'object'
    ? value as Partial<KpiBarConfig>
    : {};
  const cards = Array.isArray(candidate.cards)
    ? [...new Set(candidate.cards.filter((slug): slug is string => (
      typeof slug === 'string' && slug in KPI_REGISTRY
    )))]
    : [];
  const normalizedCards = cards.length > 0 ? cards : [...DEFAULT_KPI_SLUGS];
  const pinned = Array.isArray(candidate.pinned)
    ? [...new Set(candidate.pinned.filter((slug): slug is string => (
      typeof slug === 'string' && normalizedCards.includes(slug)
    )))]
    : [];
  const visibleSlots = Number.isInteger(candidate.visibleSlots)
    ? Math.min(MAX_KPI_CARDS, Math.max(3, candidate.visibleSlots as number))
    : DEFAULT_CONFIG.visibleSlots;
  const normalizedPinned = pinned.slice(0, visibleSlots);
  const rotationInterval = typeof candidate.rotationInterval === 'number'
    && Number.isFinite(candidate.rotationInterval)
    ? Math.min(60_000, Math.max(5_000, candidate.rotationInterval))
    : DEFAULT_CONFIG.rotationInterval;

  return {
    cards: normalizedCards,
    pinned: normalizedPinned,
    visibleSlots,
    rotationInterval,
    pauseOnHover: typeof candidate.pauseOnHover === 'boolean'
      ? candidate.pauseOnHover
      : DEFAULT_CONFIG.pauseOnHover,
    autoSurface: typeof candidate.autoSurface === 'boolean'
      ? candidate.autoSurface
      : DEFAULT_CONFIG.autoSurface,
  };
}

function getStoredConfig(): KpiBarConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG;
  try {
    const stored = localStorage.getItem('dashboard_kpis');
    if (stored) return normalizeConfig(JSON.parse(stored));
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

function saveConfig(config: KpiBarConfig) {
  try {
    localStorage.setItem('dashboard_kpis', JSON.stringify(normalizeConfig(config)));
  } catch { /* ignore */ }
}

function getDismissedSlugs(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* ignore */ }
  return new Set();
}

function dismissSlug(slug: string) {
  try {
    const dismissed = getDismissedSlugs();
    dismissed.add(slug);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch { /* ignore */ }
}

// ─── Rotation Animation Variants ────────────────────────────────────────────

const kpiRotationVariants: Variants = {
  enter: {
    opacity: 0,
    y: 12,
    filter: 'blur(4px)',
  },
  center: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.3, ease: [0.32, 0.72, 0, 1] as [number, number, number, number] },
  },
  exit: {
    opacity: 0,
    y: -12,
    filter: 'blur(2px)',
    transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] as [number, number, number, number] },
  },
};

// ─── KPI Bar Component ──────────────────────────────────────────────────────

interface KpiBarProps {
  /** Override which preset to use (default reads from localStorage) */
  preset?: 'default' | 'progress' | 'operations';
  /** Quick-filter state from parent — used to auto-pin filter cards */
  quickFilter?: string | null;
  /** Callback when a filter-action KPI is clicked */
  onFilterClick?: (filterKey: string | null) => void;
  /** Unread notifications count — passed for the unread-notifications card */
  unreadNotificationsCount?: number;
  /** When true, suppresses outer spacing for embedding in a CollapsibleSection */
  embedded?: boolean;
  /** Whether the KPI section is collapsed */
  collapsed?: boolean;
  /** Toggle collapse callback */
  onToggleCollapse?: () => void;
}

export function KpiBar({ preset, quickFilter, onFilterClick, unreadNotificationsCount, collapsed, onToggleCollapse }: KpiBarProps) {
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion();
  const [config] = useState<KpiBarConfig>(getStoredConfig);
  const [kpiData, setKpiData] = useState<Record<string, KpiCardData>>({});
  const [autoSurfacedSlugs, setAutoSurfacedSlugs] = useState<string[]>([]);
  const [dismissedSlugs, setDismissedSlugs] = useState<Set<string>>(getDismissedSlugs);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [rotationIndex, setRotationIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const today = getClientToday();

  // Determine active card slugs
  const activeSlugs = useMemo(() => {
    if (preset && KPI_PRESETS[preset]) {
      return KPI_PRESETS[preset].slugs;
    }
    return config.cards;
  }, [preset, config.cards]);

  // Merge active + auto-surfaced (minus dismissed, up to max)
  const allVisibleSlugs = useMemo(() => {
    const base = [...activeSlugs];
    if (config.autoSurface) {
      for (const slug of autoSurfacedSlugs) {
        if (!base.includes(slug) && !dismissedSlugs.has(slug) && base.length < MAX_KPI_CARDS) {
          base.push(slug);
        }
      }
    }
    return base;
  }, [activeSlugs, autoSurfacedSlugs, dismissedSlugs, config.autoSurface]);

  // Fetch KPI data
  const fetchKpis = useCallback(async () => {
    try {
      setLoadError(false);
      const autoParam = config.autoSurface ? '&autoSurface=true' : '';
      const res = await fetch(`/api/dashboard/kpis?slugs=${activeSlugs.join(',')}&date=${today}${autoParam}`);
      if (!res.ok) throw new Error(`KPI request failed with ${res.status}`);
      const json = await res.json();
      const dataMap: Record<string, KpiCardData> = {};
      for (const card of json.cards) {
        dataMap[card.slug] = card;
      }
      // Process auto-surfaced cards
      const surfacedSlugs: string[] = [];
      if (json.autoSurfaced) {
        for (const card of json.autoSurfaced) {
          dataMap[card.slug] = card;
          surfacedSlugs.push(card.slug);
        }
      }
      setAutoSurfacedSlugs(surfacedSlugs);
      setKpiData(dataMap);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [activeSlugs, today, config.autoSurface]);

  useEffect(() => {
    // Network-backed state is intentionally synchronized when the selected KPI pool changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchKpis();
  }, [fetchKpis]);

  const displayedKpiData = useMemo(() => {
    if (
      unreadNotificationsCount === undefined
      || !activeSlugs.includes('unread-notifications')
    ) {
      return kpiData;
    }
    return {
      ...kpiData,
      'unread-notifications': {
        slug: 'unread-notifications',
        value: unreadNotificationsCount,
      },
    };
  }, [activeSlugs, kpiData, unreadNotificationsCount]);

  // Clean up pause timeout on unmount
  useEffect(() => {
    return () => {
      if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
    };
  }, []);

  // ── Dismiss auto-surfaced card ────────────────────────────────────────

  const handleDismiss = useCallback((slug: string) => {
    dismissSlug(slug);
    setDismissedSlugs(prev => new Set([...prev, slug]));
    setAutoSurfacedSlugs(prev => prev.filter(s => s !== slug));
  }, []);

  // ── Rotation Logic ──────────────────────────────────────────────────────

  // Cards split into pinned (always visible) and rotating pool
  const { rotatingPool, visibleCards, rotationActive } = useMemo(() => (
    getKpiRotationState({
      slugs: allVisibleSlugs,
      pinnedSlugs: config.pinned,
      quickFilter,
      visibleSlots: config.visibleSlots,
      rotationIndex,
      data: displayedKpiData,
    })
  ), [allVisibleSlugs, config.pinned, config.visibleSlots, quickFilter, rotationIndex, displayedKpiData]);

  // Rotation timer
  useEffect(() => {
    if (!rotationActive || isPaused || prefersReducedMotion) return;
    const timer = setInterval(() => {
      setRotationIndex(prev => (prev + 1) % rotatingPool.length);
    }, config.rotationInterval);
    return () => clearInterval(timer);
  }, [rotationActive, isPaused, prefersReducedMotion, rotatingPool.length, config.rotationInterval]);

  const browseRotation = useCallback((direction: -1 | 1, index?: number) => {
    if (rotatingPool.length === 0) return;
    setRotationIndex((current) => (
      index ?? (current + direction + rotatingPool.length) % rotatingPool.length
    ));
    setIsPaused(true);
    if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
    pauseTimeoutRef.current = setTimeout(() => setIsPaused(false), 30_000);
  }, [rotatingPool.length]);

  // Hover pause
  const handleMouseEnter = useCallback(() => {
    if (!config.pauseOnHover) return;
    setIsPaused(true);
    if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
  }, [config.pauseOnHover]);

  const handleMouseLeave = useCallback(() => {
    if (!config.pauseOnHover) return;
    pauseTimeoutRef.current = setTimeout(() => setIsPaused(false), 3000);
  }, [config.pauseOnHover]);

  // ── Click Handlers ────────────────────────────────────────────────────

  const handleCardClick = useCallback((slug: string) => {
    const def = KPI_REGISTRY[slug];
    if (!def?.clickAction) return;

    if (def.clickAction.type === 'navigate') {
      router.push(def.clickAction.path);
    } else if (def.clickAction.type === 'filter' && onFilterClick) {
      const filterKey = def.clickAction.key;
      onFilterClick(quickFilter === filterKey ? null : filterKey);
    }
  }, [router, onFilterClick, quickFilter]);

  if (loading) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-[var(--surface-2)] transition-colors duration-75 select-none"
          aria-expanded={!collapsed}
        >
          <ChevronRight
            size={14}
            className={`text-[var(--text-secondary)] transition-transform duration-150 flex-shrink-0 ${!collapsed ? 'rotate-90' : ''}`}
          />
          <BarChart3 size={14} className="text-violet-400 flex-shrink-0" />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">KPIs</span>
        </button>
        {!collapsed && (
          <div className="flex divide-x divide-[var(--border)] border-t border-[var(--border)]">
            {Array.from({ length: config.visibleSlots }).map((_, i) => (
              <div key={i} className="h-14 flex-1 animate-pulse bg-[var(--surface-2)]" />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onKeyDown={(event) => {
        if (!rotationActive) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          browseRotation(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          browseRotation(1);
        }
      }}
      aria-label="Dashboard KPIs"
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-[var(--surface-2)] transition-colors duration-75 select-none"
        aria-expanded={!collapsed}
      >
        <ChevronRight
          size={14}
          className={`text-[var(--text-secondary)] transition-transform duration-150 flex-shrink-0 ${!collapsed ? 'rotate-90' : ''}`}
        />
        <BarChart3 size={14} className="text-violet-400 flex-shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">KPIs</span>
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="kpi-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
      {loadError && Object.keys(displayedKpiData).length === 0 ? (
        <div className="flex min-h-14 items-center justify-between gap-3 border-t border-[var(--border)] px-4 text-sm text-[var(--text-secondary)]">
          <span>KPIs are unavailable right now.</span>
          <button
            type="button"
            onClick={fetchKpis}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[var(--accent-400)] hover:bg-[var(--surface-2)]"
          >
            <RotateCcw size={13} />
            Retry
          </button>
        </div>
      ) : (
        <>
      <div className="overflow-x-auto border-t border-[var(--border)] scrollbar-none">
        <motion.div
          className="flex min-w-[560px] divide-x divide-[var(--border)]"
          variants={staggerContainer}
          initial="hidden"
          animate="show"
        >
          <AnimatePresence mode="popLayout">
            {visibleCards.map((slug) => {
              const def = KPI_REGISTRY[slug];
              const data = displayedKpiData[slug];
              if (!def || !data) return null;

              const isFilterActive = quickFilter === getFilterKey(slug);
              const isPinned = config.pinned.includes(slug) || isFilterActive;
              const isAutoSurfaced = autoSurfacedSlugs.includes(slug);

              return (
                <motion.div
                  key={slug}
                  layout
                  variants={kpiRotationVariants}
                  initial={prefersReducedMotion ? false : 'enter'}
                  animate="center"
                  exit="exit"
                  className="group relative flex min-w-0 flex-1"
                >
                  <KpiCard
                    definition={def}
                    data={data}
                    onClick={def.clickAction ? () => handleCardClick(slug) : undefined}
                    active={isFilterActive}
                    pinned={isPinned}
                    compact={visibleCards.length >= 6}
                    inline
                  />
                  {/* Dismiss button for auto-surfaced cards */}
                  {isAutoSurfaced && (
                    <Tooltip content="Dismiss">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleDismiss(slug); }}
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-[var(--surface-0)] flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                        aria-label={`Dismiss ${def.label}`}
                      >
                        <X size={10} />
                      </button>
                    </Tooltip>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* Rotation dot indicators */}
      {rotationActive && (
        <div className="flex min-h-8 items-center justify-center gap-1 border-t border-[var(--border)]/60 px-2">
          {isPaused && (
            <button
              type="button"
              onClick={() => browseRotation(-1)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
              aria-label="Show previous KPIs"
            >
              <ChevronLeft size={14} />
            </button>
          )}
          {rotatingPool.map((slug, i) => {
            const isVisible = visibleCards.includes(slug);
            return (
              <button
                type="button"
                key={slug}
                className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--surface-2)]"
                onClick={() => browseRotation(1, i)}
                aria-label={`Show ${KPI_REGISTRY[slug]?.label}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${
                  isVisible ? 'bg-[var(--accent-400)]' : 'bg-[var(--text-muted)]/35'
                }`} />
              </button>
            );
          })}
          {isPaused && (
            <button
              type="button"
              onClick={() => browseRotation(1)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
              aria-label="Show next KPIs"
            >
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
        </>
      )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getFilterKey(slug: string): string | undefined {
  const def = KPI_REGISTRY[slug];
  if (def?.clickAction?.type === 'filter') return def.clickAction.key;
  return undefined;
}

const ATTENTION_KPIS = new Set([
  'overdue',
  'unread-notifications',
  'high-priority',
  'needs-horizon',
  'triage-stale',
  'doc-statements-missing',
  'doc-eob-unmatched',
]);

function getRotationPriority(slug: string, data: KpiCardData | undefined): number {
  if (data && data.value > 0 && ATTENTION_KPIS.has(slug)) return 0;
  if (data && data.value > 0) return 1;
  if (data) return 2;
  return 3;
}

interface KpiRotationInput {
  slugs: string[];
  pinnedSlugs: string[];
  quickFilter?: string | null;
  visibleSlots: number;
  rotationIndex: number;
  data: Record<string, KpiCardData>;
}

function getKpiRotationState({
  slugs,
  pinnedSlugs,
  quickFilter,
  visibleSlots,
  rotationIndex,
  data,
}: KpiRotationInput) {
  const activeFilterSlug = quickFilter
    ? slugs.find(slug => quickFilter === getFilterKey(slug))
    : undefined;
  const pinned = [
    ...(activeFilterSlug ? [activeFilterSlug] : []),
    ...slugs.filter(slug => (
      pinnedSlugs.includes(slug) && slug !== activeFilterSlug
    )),
  ];
  const rawPool = slugs.filter(slug => !pinned.includes(slug));
  const visiblePinned = pinned.slice(0, visibleSlots);
  const freeSlots = Math.max(0, visibleSlots - visiblePinned.length);
  const rotationActive = freeSlots > 0 && rawPool.length > freeSlots;
  const rotatingPool = (rotationActive ? rawPool : [...rawPool])
    .map((slug, index) => ({ slug, index }))
    .sort((a, b) => {
      if (!rotationActive) return a.index - b.index;
      const priorityDiff = getRotationPriority(a.slug, data[a.slug])
        - getRotationPriority(b.slug, data[b.slug]);
      return priorityDiff || a.index - b.index;
    })
    .map(({ slug }) => slug);

  if (freeSlots <= 0) {
    return { rotatingPool, visibleCards: visiblePinned, rotationActive };
  }
  if (!rotationActive) {
    return {
      rotatingPool,
      visibleCards: [...visiblePinned, ...rotatingPool].slice(0, visibleSlots),
      rotationActive,
    };
  }

  const rotatingVisible = Array.from({ length: freeSlots }, (_, offset) => (
    rotatingPool[(rotationIndex + offset) % rotatingPool.length]
  ));
  return {
    rotatingPool,
    visibleCards: [...visiblePinned, ...rotatingVisible],
    rotationActive,
  };
}

// Export config utilities for Settings UI
export {
  getKpiRotationState,
  getStoredConfig,
  normalizeConfig,
  saveConfig,
  type KpiBarConfig,
};
