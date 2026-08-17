'use client';

import { useState, useCallback, useRef, useEffect, memo, useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { EmojiClickData } from 'emoji-picker-react';
import emojilib from 'emojilib';
import { Search, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
  type IconSource,
  type ParsedIcon,
  POPULAR_LUCIDE,
  POPULAR_MDI,
  POPULAR_PHOSPHOR,
  POPULAR_DASHBOARD_ICONS,
  POPULAR_SIMPLE_ICONS,
  serializeIconValue,
  getIconUrl,
} from './types';

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false });

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const ICON_COLORS = [
  '#ffffff',  // white (default)
  '#94a3b8',  // slate
  '#3b82f6',  // blue
  '#8b5cf6',  // violet
  '#ec4899',  // pink
  '#f59e0b',  // amber
  '#10b981',  // emerald
  '#06b6d4',  // cyan
  '#ef4444',  // red
  '#f97316',  // orange
];

const SEARCH_DEBOUNCE_MS = 200;

/** Source filter chips — user can optionally narrow results */
interface SourceFilter {
  id: IconSource;
  label: string;
  prefix?: string; // Iconify prefix for API-searched sources
}

const ALL_SOURCE_FILTERS: SourceFilter[] = [
  { id: 'emoji', label: 'Emoji' },
  { id: 'lucide', label: 'Lucide', prefix: 'lucide' },
  { id: 'mdi', label: 'Material', prefix: 'mdi' },
  { id: 'ph', label: 'Phosphor', prefix: 'ph' },
  { id: 'dash', label: 'Apps' },
  { id: 'si', label: 'Brands' },
];

// ─── EMOJI SEARCH (via emojilib) ────────────────────────────────────────────

/** Fast emoji keyword search — returns up to `limit` matching emoji */
function searchEmoji(query: string, limit = 16): string[] {
  const lower = query.toLowerCase();
  const results: string[] = [];
  for (const [emoji, keywords] of Object.entries(emojilib)) {
    if (results.length >= limit) break;
    if (keywords.some((kw: string) => kw.includes(lower))) {
      results.push(emoji);
    }
  }
  return results;
}

// ─── ICONIFY API SEARCH ─────────────────────────────────────────────────────

interface IconifySearchResult {
  icons: string[];
  total: number;
}

const searchCache = new Map<string, string[]>();
const MAX_CACHE_SIZE = 200;

async function searchIconify(
  query: string,
  prefix: string,
  limit = 16,
): Promise<string[]> {
  const cacheKey = `${prefix}:${query}:${limit}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey)!;

  try {
    const url = `https://api.iconify.design/search?query=${encodeURIComponent(query)}&prefix=${prefix}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data: IconifySearchResult = await res.json();
    const names = data.icons.map((icon) => icon.replace(`${prefix}:`, ''));
    // Evict oldest entries if cache is full
    if (searchCache.size >= MAX_CACHE_SIZE) {
      const firstKey = searchCache.keys().next().value;
      if (firstKey) searchCache.delete(firstKey);
    }
    searchCache.set(cacheKey, names);
    return names;
  } catch {
    return [];
  }
}

// ─── DASHBOARD ICONS TREE ───────────────────────────────────────────────────

let dashboardIconsCache: string[] | null = null;

async function getDashboardIcons(): Promise<string[]> {
  if (dashboardIconsCache) return dashboardIconsCache;

  try {
    const res = await fetch(
      'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json',
    );
    if (!res.ok) return POPULAR_DASHBOARD_ICONS;
    const data = await res.json();
    const svgList: string[] = data.svg || [];
    const names = svgList
      .map((f: string) => f.replace('.svg', ''))
      .filter((n: string) => !n.endsWith('-light') && !n.endsWith('-dark'));
    dashboardIconsCache = names;
    return names;
  } catch {
    return POPULAR_DASHBOARD_ICONS;
  }
}

// ─── SIMPLE ICONS LIST ──────────────────────────────────────────────────────

let simpleIconsCache: string[] | null = null;

async function getSimpleIcons(): Promise<string[]> {
  if (simpleIconsCache) return simpleIconsCache;

  try {
    // Use the official simple-icons npm CDN which always has the latest data
    const res = await fetch(
      'https://cdn.jsdelivr.net/npm/simple-icons/_data/simple-icons.json',
    );
    if (!res.ok) return POPULAR_SIMPLE_ICONS;
    const data = await res.json();
    const names = (data.icons || []).map((icon: { slug?: string; title: string }) =>
      icon.slug || icon.title.toLowerCase().replace(/[^a-z0-9]/g, ''),
    );
    simpleIconsCache = names;
    return names;
  } catch {
    return POPULAR_SIMPLE_ICONS;
  }
}

// ─── GROUPED SEARCH RESULT ─────────────────────────────────────────────────

interface SourceGroup {
  source: IconSource;
  label: string;
  icons: string[];
}

// ─── POPULAR EMOJI (for browse mode) ───────────────────────────────────────

const POPULAR_EMOJI = [
  '🚀', '⭐', '🎯', '🔥', '💡', '🎨', '📦', '🏠',
  '💰', '📊', '🔒', '⚡', '🌍', '📝', '🎵', '📸',
  '🛠️', '🎮', '📱', '💻', '🧪', '🔔', '💎', '🏆',
];

// ─── PROPS ──────────────────────────────────────────────────────────────────

export interface IconPickerProps {
  /** Current icon value */
  value: string | null;
  /** Called when the user picks an icon */
  onChange: (value: string) => void;
  /** Called when the picker should close */
  onClose?: () => void;
  /** Selected icon color (for SVG icons) */
  color?: string;
  /** Called when color changes */
  onColorChange?: (color: string) => void;
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────────────

export const IconPicker = memo(function IconPicker({
  value,
  onChange,
  onClose,
  color,
  onColorChange,
}: IconPickerProps) {
  const [query, setQuery] = useState('');
  const [sourceGroups, setSourceGroups] = useState<SourceGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRequestId = useRef(0);
  const [activeFilters, setActiveFilters] = useState<Set<IconSource>>(new Set());
  const [dashIcons, setDashIcons] = useState<string[]>([]);
  const [siIcons, setSiIcons] = useState<string[]>([]);
  const [showBrowseEmoji, setShowBrowseEmoji] = useState(false);

  // Load service icon lists lazily
  useEffect(() => {
    getDashboardIcons().then(setDashIcons);
    getSimpleIcons().then(setSiIcons);
  }, []);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  // Toggle a source filter chip
  function toggleFilter(source: IconSource) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  // Which sources should we search? (empty = all)
  const activeSources = useMemo(() => {
    if (activeFilters.size === 0) return ALL_SOURCE_FILTERS;
    return ALL_SOURCE_FILTERS.filter((s) => activeFilters.has(s.id));
  }, [activeFilters]);

  // Unified search across all active sources (including emoji)
  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setSourceGroups([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      const requestId = ++searchRequestId.current;
      const lower = q.toLowerCase();
      // More results when fewer sources are active
      const perSource = activeSources.length <= 2 ? 48 : activeSources.length <= 4 ? 32 : 24;

      const promises = activeSources.map(async (sf): Promise<SourceGroup> => {
        // Emoji search (sync, via emojilib)
        if (sf.id === 'emoji') {
          const emojis = searchEmoji(q, perSource);
          return { source: 'emoji', label: 'Emoji', icons: emojis };
        }
        // Iconify API search (lucide, mdi, ph)
        if (sf.prefix) {
          const icons = await searchIconify(q, sf.prefix, perSource);
          return { source: sf.id, label: sf.label, icons };
        }
        // Dashboard Icons (local filter)
        if (sf.id === 'dash') {
          const all = dashIcons.length > 0 ? dashIcons : POPULAR_DASHBOARD_ICONS;
          const filtered = all.filter((n) => n.includes(lower)).slice(0, perSource);
          return { source: 'dash', label: sf.label, icons: filtered };
        }
        // Simple Icons (local filter)
        if (sf.id === 'si') {
          const all = siIcons.length > 0 ? siIcons : POPULAR_SIMPLE_ICONS;
          const filtered = all.filter((n) => n.includes(lower)).slice(0, perSource);
          return { source: 'si', label: sf.label, icons: filtered };
        }
        return { source: sf.id, label: sf.label, icons: [] };
      });

      const groups = await Promise.all(promises);
      // Only update state if this is still the latest search request
      if (requestId !== searchRequestId.current) return;
      setSourceGroups(groups.filter((g) => g.icons.length > 0));
      setLoading(false);
    },
    [activeSources, dashIcons, siIcons],
  );

  // Debounced search
  const handleSearch = useCallback(
    (q: string) => {
      setQuery(q);
      setShowBrowseEmoji(false);
      if (searchTimer.current) clearTimeout(searchTimer.current);

      if (!q.trim()) {
        setSourceGroups([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      searchTimer.current = setTimeout(() => void runSearch(q), SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  // Re-run search when filters change (if there's a query)
  useEffect(() => {
    if (query.trim()) {
      void runSearch(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilters]);

  // Re-run search when catalog data arrives (dashboard/simple icons loaded async)
  useEffect(() => {
    if (query.trim() && (dashIcons.length > 0 || siIcons.length > 0)) {
      void runSearch(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashIcons, siIcons]);

  function handleIconSelect(source: IconSource, name: string) {
    const serialized = serializeIconValue({ source, name });
    onChange(serialized);
  }

  // Default display: popular emoji + popular icons from each source
  const defaultDisplay = useMemo((): SourceGroup[] => {
    const groups: SourceGroup[] = [];
    const show = activeSources;
    const perSource = show.length <= 2 ? 48 : show.length <= 4 ? 32 : 24;

    for (const sf of show) {
      if (sf.id === 'emoji') groups.push({ source: 'emoji', label: 'Emoji', icons: POPULAR_EMOJI });
      else if (sf.id === 'lucide') groups.push({ source: 'lucide', label: 'Lucide', icons: POPULAR_LUCIDE.slice(0, perSource) });
      else if (sf.id === 'mdi') groups.push({ source: 'mdi', label: 'Material', icons: POPULAR_MDI.slice(0, perSource) });
      else if (sf.id === 'ph') groups.push({ source: 'ph', label: 'Phosphor', icons: POPULAR_PHOSPHOR.slice(0, perSource) });
      else if (sf.id === 'dash') groups.push({ source: 'dash', label: 'Apps', icons: (dashIcons.length > 0 ? dashIcons : POPULAR_DASHBOARD_ICONS).slice(0, perSource) });
      else if (sf.id === 'si') groups.push({ source: 'si', label: 'Brands', icons: (siIcons.length > 0 ? siIcons : POPULAR_SIMPLE_ICONS).slice(0, perSource) });
    }
    return groups;
  }, [activeSources, dashIcons, siIcons]);

  const isSearching = query.trim().length > 0;
  const displayGroups = isSearching ? sourceGroups : defaultDisplay;

  return (
    <div className="flex flex-col w-[420px] max-h-[520px] bg-[var(--surface-1)] rounded-xl border border-[var(--border)] shadow-2xl overflow-hidden">
      {/* ── Search Bar (always visible, top of picker) ────── */}
      <div className="input-glow flex items-center gap-1.5 px-3 py-2.5 border-b border-[var(--border)] bg-[var(--surface-0)]">
        <Search size={15} className="shrink-0 text-[var(--text-muted)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search emoji, icons, brands…"
          className="w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          autoFocus
        />
        {loading && (
          <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-tertiary)]" />
        )}
        {query && !loading && (
          <button
            onClick={() => handleSearch('')}
            className="shrink-0 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            type="button"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* ── Filter Chips ────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border)]">
        {ALL_SOURCE_FILTERS.map((sf) => {
          const active = activeFilters.size === 0 || activeFilters.has(sf.id);
          return (
            <button
              key={sf.id}
              type="button"
              onClick={() => toggleFilter(sf.id)}
              className={cn(
                'px-2 py-0.5 rounded-md text-[10px] font-medium transition-all border',
                active
                  ? 'border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'border-transparent bg-[var(--surface-2)] text-[var(--text-muted)] opacity-40 hover:opacity-70',
              )}
            >
              {sf.label}
            </button>
          );
        })}
      </div>

      {/* ── Color Picker Row (only when color is controllable) ── */}
      {onColorChange && (
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)]">
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-medium mr-0.5">Color</span>
        {ICON_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onColorChange?.(c)}
            className={cn(
              'w-4 h-4 rounded-full border transition-transform hover:scale-125 flex items-center justify-center flex-shrink-0',
              color === c ? 'border-[var(--accent)] scale-110' : 'border-[var(--border-subtle,var(--border))]',
            )}
            style={{ backgroundColor: c }}
            title={c}
          >
            {color === c && (
              <span
                className="w-1 h-1 rounded-full"
                style={{ backgroundColor: c === '#ffffff' ? '#000' : '#fff' }}
              />
            )}
          </button>
        ))}
      </div>
      )}

      {/* ── Results / Browse Area ────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {/* Browse emoji (full picker widget) — shown when user clicks "Browse all emoji" */}
        {showBrowseEmoji && !isSearching ? (
          <div>
            <button
              type="button"
              onClick={() => setShowBrowseEmoji(false)}
              className="flex items-center gap-1 px-3 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              ← Back to all icons
            </button>
            <EmojiPicker
              onEmojiClick={(emojiData: EmojiClickData) => {
                handleIconSelect('emoji', emojiData.emoji);
              }}
              autoFocusSearch={false}
              theme={'dark' as import('emoji-picker-react').Theme}
              height={400}
              width={418}
              searchPlaceHolder="Search emoji…"
              previewConfig={{ showPreview: false }}
            />
          </div>
        ) : loading && displayGroups.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
            <Loader2 size={18} className="animate-spin mr-2" />
            <span className="text-xs">Searching…</span>
          </div>
        ) : displayGroups.length === 0 && isSearching ? (
          <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
            <span className="text-xs">No results for &ldquo;{query}&rdquo;</span>
          </div>
        ) : (
          displayGroups.map((group) => (
            <div key={group.source} className="border-b border-[var(--border)] last:border-b-0">
              {/* Source label */}
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {group.label}
                </span>
                <span className="text-[9px] text-[var(--text-muted)] opacity-60">
                  {group.icons.length}
                </span>
                {/* "Browse all" link for emoji group (only in default/non-search view) */}
                {group.source === 'emoji' && !isSearching && (
                  <button
                    type="button"
                    onClick={() => setShowBrowseEmoji(true)}
                    className="ml-auto text-[10px] text-[var(--accent)] hover:underline"
                  >
                    Browse all →
                  </button>
                )}
              </div>
              {/* Icons grid */}
              <div className={cn(
                'gap-0.5 px-1.5 pb-2',
                group.source === 'emoji' ? 'flex flex-wrap' : 'grid grid-cols-8',
              )}>
                {group.icons.map((name) => (
                  group.source === 'emoji' ? (
                    <button
                      key={name}
                      type="button"
                      onClick={() => handleIconSelect('emoji', name)}
                      className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-[var(--surface-2)] transition-colors text-xl"
                      title={name}
                    >
                      {name}
                    </button>
                  ) : (
                    <IconGridItem
                      key={`${group.source}:${name}`}
                      name={name}
                      source={group.source}
                      color={group.source !== 'dash' && group.source !== 'si' ? color : undefined}
                      onClick={() => handleIconSelect(group.source, name)}
                    />
                  )
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
});

// ─── GRID ITEM ──────────────────────────────────────────────────────────────

const IconGridItem = memo(function IconGridItem({
  name,
  source,
  color,
  onClick,
}: {
  name: string;
  source: IconSource;
  color?: string;
  onClick: () => void;
}) {
  const parsed: ParsedIcon = { source, name };
  const url = getIconUrl(parsed, color);

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center p-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors duration-75 group"
      title={`${source}:${name}`}
    >
      {url ? (
        <img
          src={url}
          alt={name}
          width={22}
          height={22}
          loading="lazy"
          className={cn(
            'w-[22px] h-[22px]',
            !color && ['lucide', 'mdi', 'ph', 'dash'].includes(source) && 'dark:invert',
          )}
          onError={(e) => {
            (e.target as HTMLImageElement).style.opacity = '0.2';
          }}
        />
      ) : (
        <span className="text-lg">{name}</span>
      )}
      <span className="text-[8px] text-[var(--text-muted)] truncate w-full text-center mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {name.length > 10 ? `${name.slice(0, 10)}…` : name}
      </span>
    </button>
  );
});
