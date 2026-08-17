'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Search, X, Loader2, Check } from 'lucide-react';
import { toast } from 'sonner';
import emojilib from 'emojilib';
import { cn } from '@/lib/utils/cn';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
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
} from '@/components/ui/icon-picker/types';

// ─── TYPES ──────────────────────────────────────────────────────────────────

type CopyFormat = 'name' | 'svg' | 'url' | 'react' | 'css';
type IconSize = 'sm' | 'md' | 'lg';

interface SourceGroup {
  source: IconSource;
  label: string;
  icons: string[];
}

interface SourceFilterDef {
  id: IconSource;
  label: string;
  shortLabel: string;
  prefix?: string;
}

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const SOURCE_FILTERS: SourceFilterDef[] = [
  { id: 'emoji', label: 'Emoji', shortLabel: '😀' },
  { id: 'lucide', label: 'Lucide', shortLabel: '◇', prefix: 'lucide' },
  { id: 'mdi', label: 'MDI', shortLabel: '⬡', prefix: 'mdi' },
  { id: 'ph', label: 'Phosphor', shortLabel: '◈', prefix: 'ph' },
  { id: 'dash', label: 'Dashboard', shortLabel: '⊞' },
  { id: 'si', label: 'Simple Icons', shortLabel: '◎' },
];

const COLOR_SWATCHES = [
  { name: 'White', value: '#ffffff' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Rose', value: '#f43f5e' },
];

const FORMAT_OPTIONS: { id: CopyFormat; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'svg', label: 'SVG' },
  { id: 'url', label: 'URL' },
  { id: 'react', label: 'React' },
  { id: 'css', label: 'CSS' },
];

const ICON_SIZE_MAP: Record<IconSize, number> = { sm: 24, md: 36, lg: 48 };
const GRID_COLS_MAP: Record<IconSize, string> = {
  sm: 'grid-cols-[repeat(auto-fill,minmax(56px,1fr))]',
  md: 'grid-cols-[repeat(auto-fill,minmax(72px,1fr))]',
  lg: 'grid-cols-[repeat(auto-fill,minmax(88px,1fr))]',
};

const SEARCH_DEBOUNCE_MS = 200;

const POPULAR_EMOJI = [
  '🚀', '⭐', '🎯', '🔥', '💡', '🎨', '📦', '🏠',
  '💰', '📊', '🔒', '⚡', '🌍', '📝', '🎵', '📸',
  '🛠️', '🎮', '📱', '💻', '🧪', '🔔', '💎', '🏆',
  '❤️', '🌈', '🎉', '✨', '🍕', '🌸', '🐱', '🦊',
];

// ─── SEARCH UTILITIES ───────────────────────────────────────────────────────

function searchEmoji(query: string, limit = 48): string[] {
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

const searchCache = new Map<string, string[]>();
const MAX_CACHE_SIZE = 300;

async function searchIconify(query: string, prefix: string, limit = 48): Promise<string[]> {
  const cacheKey = `${prefix}:${query}:${limit}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey)!;

  try {
    const url = `https://api.iconify.design/search?query=${encodeURIComponent(query)}&prefix=${prefix}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const names = (data.icons || []).map((icon: string) => icon.replace(`${prefix}:`, ''));
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

let dashboardIconsCache: string[] | null = null;
async function getDashboardIcons(): Promise<string[]> {
  if (dashboardIconsCache) return dashboardIconsCache;
  try {
    const res = await fetch('https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json');
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

let simpleIconsCache: string[] | null = null;
async function getSimpleIcons(): Promise<string[]> {
  if (simpleIconsCache) return simpleIconsCache;
  try {
    const res = await fetch('https://cdn.jsdelivr.net/npm/simple-icons/_data/simple-icons.json');
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

// ─── COPY UTILITIES ─────────────────────────────────────────────────────────

function getIconCopyValue(source: IconSource, name: string, format: CopyFormat, color: string): string {
  const serialized = serializeIconValue({ source, name });

  switch (format) {
    case 'name':
      return serialized;

    case 'url': {
      if (source === 'emoji') return serialized;
      const parsed: ParsedIcon = { source, name };
      return getIconUrl(parsed, color) || serialized;
    }

    case 'svg': {
      if (source === 'emoji') return serialized;
      const parsed2: ParsedIcon = { source, name };
      const url = getIconUrl(parsed2, color);
      return url ? `<img src="${url}" alt="${name}" width="24" height="24" />` : serialized;
    }

    case 'react': {
      if (source === 'emoji') return `<span role="img" aria-label="${name}">${name}</span>`;
      if (source === 'lucide') {
        const pascal = name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        return `<${pascal} />`;
      }
      return `<IconRenderer value="${serialized}" size={24} color="${color}" />`;
    }

    case 'css': {
      if (source === 'emoji') return serialized;
      const parsed3: ParsedIcon = { source, name };
      const url = getIconUrl(parsed3, color);
      return url ? `background-image: url('${url}');` : serialized;
    }

    default:
      return serialized;
  }
}

// ─── MAIN PAGE COMPONENT ────────────────────────────────────────────────────

export default function IconsPage() {
  const [query, setQuery] = useState('');
  const [sourceGroups, setSourceGroups] = useState<SourceGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<IconSource>>(new Set());
  const [color, setColor] = useState('#ffffff');
  const [customColor, setCustomColor] = useState('');
  const [format, setFormat] = useState<CopyFormat>('name');
  const [iconSize, setIconSize] = useState<IconSize>('md');
  const [dashIcons, setDashIcons] = useState<string[]>([]);
  const [siIcons, setSiIcons] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRequestId = useRef(0);

  // Load icon catalogs
  useEffect(() => {
    getDashboardIcons().then(setDashIcons);
    getSimpleIcons().then(setSiIcons);
  }, []);

  // Auto-focus on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // ⌘K / Ctrl+K → focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      // Esc → clear search
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setQuery('');
        setSourceGroups([]);
      }
      // 1-6 toggles source filter (only when not typing)
      if (document.activeElement !== searchInputRef.current) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= 6) {
          e.preventDefault();
          const source = SOURCE_FILTERS[num - 1];
          if (source) toggleFilter(source.id);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Active sources computation
  const activeSources = useMemo(() => {
    if (activeFilters.size === 0) return SOURCE_FILTERS;
    return SOURCE_FILTERS.filter((s) => activeFilters.has(s.id));
  }, [activeFilters]);

  function toggleFilter(source: IconSource) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  // Search logic
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
      const perSource = activeSources.length <= 2 ? 64 : activeSources.length <= 4 ? 48 : 32;

      const promises = activeSources.map(async (sf): Promise<SourceGroup> => {
        if (sf.id === 'emoji') {
          return { source: 'emoji', label: 'Emoji', icons: searchEmoji(q, perSource) };
        }
        if (sf.prefix) {
          const icons = await searchIconify(q, sf.prefix, perSource);
          return { source: sf.id, label: sf.label, icons };
        }
        if (sf.id === 'dash') {
          const all = dashIcons.length > 0 ? dashIcons : POPULAR_DASHBOARD_ICONS;
          return { source: 'dash', label: sf.label, icons: all.filter((n) => n.includes(lower)).slice(0, perSource) };
        }
        if (sf.id === 'si') {
          const all = siIcons.length > 0 ? siIcons : POPULAR_SIMPLE_ICONS;
          return { source: 'si', label: sf.label, icons: all.filter((n) => n.includes(lower)).slice(0, perSource) };
        }
        return { source: sf.id, label: sf.label, icons: [] };
      });

      const groups = await Promise.all(promises);
      if (requestId !== searchRequestId.current) return;
      setSourceGroups(groups.filter((g) => g.icons.length > 0));
      setLoading(false);
    },
    [activeSources, dashIcons, siIcons],
  );

  const handleSearch = useCallback(
    (q: string) => {
      setQuery(q);
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

  // Re-run search when filters change
  useEffect(() => {
    if (query.trim()) void runSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilters]);

  // Re-run when catalog data arrives
  useEffect(() => {
    if (query.trim() && (dashIcons.length > 0 || siIcons.length > 0)) {
      void runSearch(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashIcons, siIcons]);

  // Default display
  const defaultDisplay = useMemo((): SourceGroup[] => {
    const groups: SourceGroup[] = [];
    const perSource = activeSources.length <= 2 ? 64 : activeSources.length <= 4 ? 48 : 32;
    for (const sf of activeSources) {
      if (sf.id === 'emoji') groups.push({ source: 'emoji', label: 'Emoji', icons: POPULAR_EMOJI });
      else if (sf.id === 'lucide') groups.push({ source: 'lucide', label: 'Lucide', icons: POPULAR_LUCIDE.slice(0, perSource) });
      else if (sf.id === 'mdi') groups.push({ source: 'mdi', label: 'MDI', icons: POPULAR_MDI.slice(0, perSource) });
      else if (sf.id === 'ph') groups.push({ source: 'ph', label: 'Phosphor', icons: POPULAR_PHOSPHOR.slice(0, perSource) });
      else if (sf.id === 'dash') groups.push({ source: 'dash', label: 'Dashboard', icons: (dashIcons.length > 0 ? dashIcons : POPULAR_DASHBOARD_ICONS).slice(0, perSource) });
      else if (sf.id === 'si') groups.push({ source: 'si', label: 'Simple Icons', icons: (siIcons.length > 0 ? siIcons : POPULAR_SIMPLE_ICONS).slice(0, perSource) });
    }
    return groups;
  }, [activeSources, dashIcons, siIcons]);

  const isSearching = query.trim().length > 0;
  const displayGroups = isSearching ? sourceGroups : defaultDisplay;
  const totalResults = displayGroups.reduce((sum, g) => sum + g.icons.length, 0);
  const sourcesWithResults = displayGroups.length;

  // Copy handler
  async function handleCopy(source: IconSource, name: string) {
    const value = getIconCopyValue(source, name, format, color);
    try {
      await navigator.clipboard.writeText(value);
      const displayName = source === 'emoji' ? name : `${source}:${name}`;
      toast.success(`Copied! ${displayName} → clipboard`, { duration: 2000 });
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }

  // Custom color handler
  function handleCustomColor(hex: string) {
    setCustomColor(hex);
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setColor(hex);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white flex flex-col">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 bg-[#0a0a0f]/95 backdrop-blur-md border-b border-[#1e1e2e]">
        <div className="max-w-[1600px] mx-auto px-4 py-3">
          {/* Search row */}
          <div className="flex items-center gap-3 mb-3">
            <div className="input-glow flex items-center gap-2 flex-1 bg-[#111118] border border-[#1e1e2e] rounded-xl px-4 py-2.5">
              <Search size={18} className="shrink-0 text-gray-500" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search icons… (⌘K)"
                className="w-full bg-transparent text-base text-white outline-none placeholder:text-gray-600"
              />
              {loading && <Loader2 size={16} className="shrink-0 animate-spin text-gray-500" />}
              {query && !loading && (
                <button
                  onClick={() => handleSearch('')}
                  className="shrink-0 p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-[#1e1e2e] transition-colors"
                  type="button"
                  aria-label="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-4 flex-wrap">
            {/* Source filter chips */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveFilters(new Set())}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-medium transition-all border',
                  activeFilters.size === 0
                    ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                    : 'border-[#1e1e2e] bg-[#111118] text-gray-500 hover:text-gray-300',
                )}
              >
                All
              </button>
              {SOURCE_FILTERS.map((sf, i) => {
                const active = activeFilters.has(sf.id);
                return (
                  <button
                    key={sf.id}
                    type="button"
                    onClick={() => toggleFilter(sf.id)}
                    className={cn(
                      'px-2.5 py-1 rounded-lg text-xs font-medium transition-all border',
                      active
                        ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                        : 'border-[#1e1e2e] bg-[#111118] text-gray-500 hover:text-gray-300',
                    )}
                    title={`${sf.label} (press ${i + 1})`}
                  >
                    {sf.shortLabel} {sf.label}
                  </button>
                );
              })}
            </div>

            <div className="w-px h-5 bg-[#1e1e2e]" />

            {/* Color swatches */}
            <div className="flex items-center gap-1.5">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch.value}
                  type="button"
                  onClick={() => { setColor(swatch.value); setCustomColor(''); }}
                  className={cn(
                    'w-5 h-5 rounded-full border-2 transition-transform hover:scale-125',
                    color === swatch.value ? 'border-white scale-110' : 'border-[#1e1e2e]',
                  )}
                  style={{ backgroundColor: swatch.value }}
                  title={swatch.name}
                />
              ))}
              <input
                type="text"
                value={customColor}
                onChange={(e) => handleCustomColor(e.target.value)}
                placeholder="#hex"
                className="w-16 px-2 py-0.5 text-xs bg-[#111118] border border-[#1e1e2e] rounded-md text-gray-300 outline-none font-mono"
              />
            </div>

            <div className="w-px h-5 bg-[#1e1e2e]" />

            {/* Copy format toggle */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 font-medium">Copy:</span>
              {FORMAT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setFormat(opt.id)}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-xs font-medium transition-all border',
                    format === opt.id
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                      : 'border-transparent text-gray-500 hover:text-gray-300',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="w-px h-5 bg-[#1e1e2e]" />

            {/* Size toggle */}
            <div className="flex items-center gap-1">
              {(['sm', 'md', 'lg'] as IconSize[]).map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setIconSize(size)}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-xs font-medium transition-all border uppercase',
                    iconSize === size
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                      : 'border-transparent text-gray-500 hover:text-gray-300',
                  )}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* ── Results info ── */}
      <div className="max-w-[1600px] mx-auto w-full px-4 pt-4 pb-2">
        <p className="text-xs text-gray-500">
          {isSearching
            ? `${totalResults} results for '${query}' across ${sourcesWithResults} source${sourcesWithResults !== 1 ? 's' : ''}`
            : `Popular icons from ${sourcesWithResults} sources — type to search`}
        </p>
      </div>

      {/* ── Results grid ── */}
      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 pb-8">
        {loading && displayGroups.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-500">
            <Loader2 size={20} className="animate-spin mr-2" />
            <span className="text-sm">Searching…</span>
          </div>
        ) : displayGroups.length === 0 && isSearching ? (
          <div className="flex items-center justify-center py-20 text-gray-500">
            <span className="text-sm">No results for &ldquo;{query}&rdquo;</span>
          </div>
        ) : (
          <div className="space-y-6">
            {displayGroups.map((group) => (
              <section key={group.source}>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-sm font-semibold text-gray-300">{group.label}</h2>
                  <span className="text-xs text-gray-600 bg-[#111118] px-2 py-0.5 rounded-full">
                    {group.icons.length}
                  </span>
                </div>
                <div className={cn('grid gap-1', GRID_COLS_MAP[iconSize])}>
                  {group.icons.map((name) => (
                    <IconTile
                      key={`${group.source}:${name}`}
                      source={group.source}
                      name={name}
                      color={color}
                      size={ICON_SIZE_MAP[iconSize]}
                      onClick={() => handleCopy(group.source, name)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-[#1e1e2e] py-3 text-center text-xs text-gray-600">
        Icon Finder — Data from Iconify, jsDelivr, Simple Icons CDN • Click any icon to copy
      </footer>
    </div>
  );
}

// ─── ICON TILE COMPONENT ────────────────────────────────────────────────────

function IconTile({
  source,
  name,
  color,
  size,
  onClick,
}: {
  source: IconSource;
  name: string;
  color: string;
  size: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 p-2 rounded-xl border border-[#1e1e2e] bg-[#111118] hover:border-blue-500/30 hover:bg-[#161622] hover:scale-105 transition-all duration-150 cursor-pointer group"
      title={source === 'emoji' ? name : `${source}:${name}`}
    >
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <IconRenderer
          value={source === 'emoji' ? name : `${source}:${name}`}
          size={size * 0.75}
          color={source !== 'dash' ? color : undefined}
        />
      </div>
      <span className="text-[9px] text-gray-600 group-hover:text-gray-400 truncate w-full text-center font-mono transition-colors">
        {name.length > 12 ? `${name.slice(0, 12)}…` : name}
      </span>
    </button>
  );
}
