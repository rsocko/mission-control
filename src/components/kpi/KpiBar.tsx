'use client';

import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouter } from 'next/navigation';
import { X, ChevronRight, BarChart3 } from 'lucide-react';
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
  visibleSlots: 5,
  rotationInterval: KPI_ROTATION_INTERVAL,
  pauseOnHover: true,
  autoSurface: true,
};

function getStoredConfig(): KpiBarConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG;
  try {
    const stored = localStorage.getItem('dashboard_kpis');
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

function saveConfig(config: KpiBarConfig) {
  try {
    localStorage.setItem('dashboard_kpis', JSON.stringify(config));
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

export function KpiBar({ preset, quickFilter, onFilterClick, unreadNotificationsCount, embedded, collapsed, onToggleCollapse }: KpiBarProps) {
  const router = useRouter();
  const [config, setConfig] = useState<KpiBarConfig>(getStoredConfig);
  const [kpiData, setKpiData] = useState<Record<string, KpiCardData>>({});
  const [autoSurfacedSlugs, setAutoSurfacedSlugs] = useState<string[]>([]);
  const [dismissedSlugs, setDismissedSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [rotationIndex, setRotationIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const today = getClientToday();

  // Load dismissed slugs on mount
  useEffect(() => {
    setDismissedSlugs(getDismissedSlugs());
  }, []);

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
      const slugsToFetch = activeSlugs.filter(s => s !== 'unread-notifications');
      const autoParam = config.autoSurface ? '&autoSurface=true' : '';
      const res = await fetch(`/api/dashboard/kpis?slugs=${slugsToFetch.join(',')}&date=${today}${autoParam}`);
      if (!res.ok) return;
      const json = await res.json();
      const dataMap: Record<string, KpiCardData> = {};
      for (const card of json.cards) {
        dataMap[card.slug] = card;
      }
      // Process auto-surfaced cards
      if (json.autoSurfaced && json.autoSurfaced.length > 0) {
        const surfacedSlugs: string[] = [];
        for (const card of json.autoSurfaced) {
          dataMap[card.slug] = card;
          surfacedSlugs.push(card.slug);
        }
        setAutoSurfacedSlugs(surfacedSlugs);
      }
      setKpiData(dataMap);
    } catch {
      // Silent fail on dashboard
    } finally {
      setLoading(false);
    }
  }, [activeSlugs, today, config.autoSurface]);

  useEffect(() => { fetchKpis(); }, [fetchKpis]);

  // Inject unread-notifications from prop (kept out of fetchKpis to avoid refetch loops)
  useEffect(() => {
    if (unreadNotificationsCount !== undefined && activeSlugs.includes('unread-notifications')) {
      setKpiData(prev => ({
        ...prev,
        'unread-notifications': { slug: 'unread-notifications', value: unreadNotificationsCount },
      }));
    }
  }, [unreadNotificationsCount, activeSlugs]);

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

  const needsRotation = allVisibleSlugs.length > config.visibleSlots;

  // Cards split into pinned (always visible) and rotating pool
  const { pinnedCards, rotatingPool, visibleCards } = useMemo(() => {
    const pinned = allVisibleSlugs.filter(s => config.pinned.includes(s) || quickFilter === getFilterKey(s));
    const pool = allVisibleSlugs.filter(s => !pinned.includes(s));
    const freeSlots = config.visibleSlots - pinned.length;

    let visible: string[];
    if (!needsRotation || freeSlots <= 0) {
      visible = allVisibleSlugs.slice(0, config.visibleSlots);
    } else {
      // Round-robin through the pool
      const rotatingVisible = [];
      for (let i = 0; i < freeSlots; i++) {
        const idx = (rotationIndex + i) % pool.length;
        rotatingVisible.push(pool[idx]);
      }
      visible = [...pinned, ...rotatingVisible];
    }

    return { pinnedCards: pinned, rotatingPool: pool, visibleCards: visible };
  }, [allVisibleSlugs, config.pinned, config.visibleSlots, quickFilter, needsRotation, rotationIndex]);

  // Rotation timer
  useEffect(() => {
    if (!needsRotation || isPaused) return;
    const timer = setInterval(() => {
      setRotationIndex(prev => (prev + 1) % rotatingPool.length);
    }, config.rotationInterval);
    return () => clearInterval(timer);
  }, [needsRotation, isPaused, rotatingPool.length, config.rotationInterval]);

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

  // ── Grid Columns (responsive) ───────────────────────────────────────

  const gridCols = visibleCards.length <= 3
    ? 'grid-cols-2 sm:grid-cols-3'
    : visibleCards.length === 4
    ? 'grid-cols-2 sm:grid-cols-2 md:grid-cols-4'
    : visibleCards.length <= 5
    ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'
    : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6';

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
          <div className={`grid ${gridCols} gap-2 md:gap-3 p-3`}>
            {Array.from({ length: config.visibleSlots }).map((_, i) => (
              <div key={i} className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-3 h-[88px] animate-pulse" />
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
      {/* Mobile: horizontal scroll wrapper */}
      <div className="md:block overflow-x-auto -mx-2 px-2 md:mx-0 md:px-0 scrollbar-none">
        <motion.div
          className={`grid ${gridCols} gap-2 md:gap-3 min-w-[480px] md:min-w-0`}
          variants={staggerContainer}
          initial="hidden"
          animate="show"
        >
          <AnimatePresence mode="popLayout">
            {visibleCards.map((slug) => {
              const def = KPI_REGISTRY[slug];
              const data = kpiData[slug];
              if (!def || !data) return null;

              const isFilterActive = quickFilter === getFilterKey(slug);
              const isAutoSurfaced = autoSurfacedSlugs.includes(slug);

              return (
                <motion.div
                  key={slug}
                  layout
                  variants={kpiRotationVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  className="relative group"
                >
                  <KpiCard
                    definition={def}
                    data={data}
                    onClick={def.clickAction ? () => handleCardClick(slug) : undefined}
                    active={isFilterActive}
                    compact={visibleCards.length >= 6}
                  />
                  {/* Dismiss button for auto-surfaced cards */}
                  {isAutoSurfaced && (
                    <Tooltip content="Dismiss">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDismiss(slug); }}
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-[var(--surface-0)] flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
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
      {needsRotation && rotatingPool.length > 0 && (
        <div className="flex justify-center gap-1 mb-3 -mt-2">
          {rotatingPool.map((slug, i) => {
            const isVisible = visibleCards.includes(slug);
            return (
              <button
                key={slug}
                className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${
                  isVisible ? 'bg-[var(--accent-400)]' : 'bg-[var(--surface-0)]'
                }`}
                onClick={() => {
                  setRotationIndex(i);
                  setIsPaused(true);
                  if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
                  pauseTimeoutRef.current = setTimeout(() => setIsPaused(false), 30000);
                }}
                aria-label={`Show ${KPI_REGISTRY[slug]?.label}`}
              />
            );
          })}
        </div>
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

// Export config utilities for Settings UI
export { getStoredConfig, saveConfig, type KpiBarConfig };
