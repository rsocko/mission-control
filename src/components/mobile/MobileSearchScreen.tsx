'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Inbox,
  ListTodo,
  Loader2,
  NotebookPen,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fadeSlideUp, modalContent, modalOverlay, staggerContainer } from '@/lib/motion';
import type { SearchResult } from '@/lib/search/fts';
import { useProgressiveSearch } from '@/lib/hooks/useProgressiveSearch';
import { cn } from '@/lib/utils';

export interface MobileSearchScreenProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional initial query (e.g., from drawer search bar) */
  initialQuery?: string;
}

type TypeFilter = 'all' | 'tasks' | 'triage' | 'notes';
type DateFilter = 'all' | '7d' | '30d' | 'overdue';

interface RecentSearchesSectionProps {
  recentSearches: string[];
  onSelect: (query: string) => void;
  onClear: () => void;
}

const RECENT_SEARCHES_KEY = 'mc:recent-searches';
const MAX_RECENT_SEARCHES = 5;
const SEARCH_DEBOUNCE_MS = 300;

const SUGGESTED_SEARCHES = [
  'High priority tasks',
  'Overdue',
  'In progress',
] as const;

const TYPE_FILTERS: ReadonlyArray<{ key: TypeFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'triage', label: 'Triage' },
  { key: 'notes', label: 'Notes' },
];

const DATE_FILTERS: ReadonlyArray<{ key: DateFilter; label: string }> = [
  { key: 'all', label: 'Any time' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'overdue', label: 'Overdue' },
];

function readRecentSearches(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').slice(0, MAX_RECENT_SEARCHES)
      : [];
  } catch {
    return [];
  }
}

function writeRecentSearches(values: string[]) {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(values.slice(0, MAX_RECENT_SEARCHES)));
  } catch {
    // Ignore localStorage failures.
  }
}

function pushRecentSearch(query: string): string[] {
  const normalized = query.trim();
  if (!normalized) return readRecentSearches();

  const updated = [normalized, ...readRecentSearches().filter((item) => item !== normalized)]
    .slice(0, MAX_RECENT_SEARCHES);

  writeRecentSearches(updated);
  return updated;
}

function clearRecentSearches() {
  writeRecentSearches([]);
}

function getString(metadata: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function getNumber(metadata: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function coerceDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return undefined;
}

function getDate(metadata: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const date = coerceDate(metadata[key]);
    if (date) {
      return date;
    }
  }

  return undefined;
}

function formatShortDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function deriveCategory(result: SearchResult): Exclude<TypeFilter, 'all'> {
  if (result.type === 'task') return 'tasks';

  const metadata = result.metadata ?? {};
  const hint = [
    getString(metadata, ['entityType', 'itemType', 'kind', 'recordType', 'category']),
    getString(metadata, ['sourceListName', 'connectorType', 'projectName']),
    result.title,
    result.snippet,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/(capture|note|memo|idea|journal)/.test(hint)) {
    return 'notes';
  }

  return 'triage';
}

function getBadgeConfig(result: SearchResult) {
  const category = deriveCategory(result);

  if (category === 'tasks') {
    return {
      label: 'Task',
      icon: ListTodo,
      className: 'bg-amber-400/15 text-amber-200 ring-1 ring-amber-300/20',
    };
  }

  if (category === 'notes') {
    return {
      label: 'Capture',
      icon: NotebookPen,
      className: 'bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/25',
    };
  }

  return {
    label: 'Triage',
    icon: Inbox,
    className: 'bg-orange-500/15 text-orange-200 ring-1 ring-orange-300/20',
  };
}

function getProjectLabel(result: SearchResult) {
  const metadata = result.metadata ?? {};
  return getString(metadata, ['projectName', 'project', 'projectTitle', 'sourceListName']);
}

function getStatusLabel(result: SearchResult) {
  const metadata = result.metadata ?? {};
  return getString(metadata, ['status', 'category', 'severity', 'state']);
}

function getPriorityLabel(result: SearchResult) {
  const metadata = result.metadata ?? {};
  return getString(metadata, ['priority', 'priorityLabel']);
}

function getSourceLabel(result: SearchResult) {
  const metadata = result.metadata ?? {};
  return (
    getString(metadata, ['sourceListName', 'connectorType', 'projectName', 'project', 'source']) ??
    (deriveCategory(result) === 'notes' ? 'Capture' : result.source.toUpperCase())
  );
}

function getDueDate(result: SearchResult) {
  return getDate(result.metadata ?? {}, ['dueDate', 'dueAt', 'deadline']);
}

function getPrimaryDate(result: SearchResult) {
  const metadata = result.metadata ?? {};
  return (
    getDueDate(result) ??
    getDate(metadata, ['updatedAt', 'receivedAt', 'capturedAt', 'createdAt', 'timestamp'])
  );
}

function getAiScore(result: SearchResult) {
  const metadata = result.metadata ?? {};
  const raw =
    getNumber(metadata, ['aiRelevanceScore', 'semanticScore', 'relevanceScore']) ??
    result.score;

  if (!Number.isFinite(raw)) return undefined;
  return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
}

function formatSourceLine(result: SearchResult) {
  const source = getSourceLabel(result);
  const priority = getPriorityLabel(result);
  const severity = getString(result.metadata ?? {}, ['severity']);

  return [source, priority || severity].filter(Boolean).join(' · ');
}

function formatMetadataLine(result: SearchResult) {
  const parts: string[] = [];
  const dueDate = getDueDate(result);
  const priority = getPriorityLabel(result);
  const status = getStatusLabel(result);
  const aiScore = getAiScore(result);
  const primaryDate = getPrimaryDate(result);

  if (dueDate) parts.push(`Due ${formatShortDate(dueDate)}`);
  if (priority) parts.push(priority);
  if (status && status !== priority) parts.push(status);
  if (aiScore !== undefined) parts.push(`AI ${aiScore}%`);
  if (primaryDate) parts.push(formatShortDate(primaryDate));

  return parts.join(' · ');
}

function renderHighlightedText(value: string) {
  if (!value) return null;

  return value.split(/(<mark>.*?<\/mark>)/g).filter(Boolean).map((part, index) => {
    const match = part.match(/^<mark>(.*)<\/mark>$/);
    if (!match) {
      return <span key={`${part}-${index}`}>{part}</span>;
    }

    return (
      <mark
        key={`${match[1]}-${index}`}
        className="rounded-[6px] bg-sky-500/25 px-1 text-[var(--text-primary)]"
      >
        {match[1]}
      </mark>
    );
  });
}

function matchesDateFilter(result: SearchResult, dateFilter: DateFilter) {
  if (dateFilter === 'all') return true;

  const now = Date.now();
  const dueDate = getDueDate(result);
  const primaryDate = getPrimaryDate(result);

  if (dateFilter === 'overdue') {
    return Boolean(dueDate && dueDate.getTime() < now);
  }

  const compareDate = primaryDate ?? dueDate;
  if (!compareDate) return false;

  const days = dateFilter === '7d' ? 7 : 30;
  return compareDate.getTime() >= now - days * 24 * 60 * 60 * 1000;
}

function uniqueSorted(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function RecentSearchesSection({ recentSearches, onSelect, onClear }: RecentSearchesSectionProps) {
  if (recentSearches.length === 0) return null;

  return (
    <section aria-labelledby="mobile-search-recent">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock3 size={14} className="text-[var(--text-tertiary)]" />
          <h3 id="mobile-search-recent" className="text-sm font-semibold text-[var(--text-primary)]">
            Recent Searches
          </h3>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="min-h-11 rounded-full px-3 text-xs font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
          aria-label="Clear recent searches"
        >
          Clear
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {recentSearches.map((query) => (
          <button
            key={query}
            type="button"
            onClick={() => onSelect(query)}
            className="min-h-11 rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-4 text-sm text-[var(--text-secondary)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            aria-label={`Search for ${query}`}
          >
            {query}
          </button>
        ))}
      </div>
    </section>
  );
}

export function MobileSearchScreen({
  isOpen,
  onClose,
  initialQuery,
}: MobileSearchScreenProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyOpenRef = useRef(false);

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const prefersReducedMotion = useReducedMotion() ?? false;
  const {
    results,
    note,
    keywordLoading: loading,
    semanticLoading,
    keywordDurationMs: durationMs,
    semanticEnabled,
    semanticAvailable,
  } = useProgressiveSearch({
    query: debouncedQuery,
    enabled: isOpen,
    limit: 20,
  });

  useEffect(() => {
    setRecentSearches(readRecentSearches());
  }, []);

  useEffect(() => {
    if (!isOpen) {
      previouslyOpenRef.current = false;
      return;
    }

    if (!previouslyOpenRef.current) {
      const nextQuery = initialQuery?.trim() ?? '';
      setQuery(nextQuery);
      setDebouncedQuery(nextQuery);
      setTypeFilter('all');
      setProjectFilter('all');
      setStatusFilter('all');
      setDateFilter('all');
      previouslyOpenRef.current = true;
    }
  }, [initialQuery, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const timeoutId = window.setTimeout(() => {
      const nextValue = query.trim();
      setDebouncedQuery(nextValue);

      if (!nextValue) {
        setDebouncedQuery('');
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, query]);

  const projectOptions = useMemo(
    () => uniqueSorted(results.map((result) => getProjectLabel(result))),
    [results],
  );

  const statusOptions = useMemo(
    () => uniqueSorted(results.map((result) => getStatusLabel(result))),
    [results],
  );

  const filteredResults = useMemo(() => {
    return results.filter((result) => {
      if (typeFilter !== 'all' && deriveCategory(result) !== typeFilter) return false;
      if (projectFilter !== 'all' && getProjectLabel(result) !== projectFilter) return false;
      if (statusFilter !== 'all' && getStatusLabel(result) !== statusFilter) return false;
      if (!matchesDateFilter(result, dateFilter)) return false;
      return true;
    });
  }, [dateFilter, projectFilter, results, statusFilter, typeFilter]);

  const resultLabel = useMemo(() => {
    if (!debouncedQuery) return '';
    return `${filteredResults.length} result${filteredResults.length === 1 ? '' : 's'} for “${debouncedQuery}”`;
  }, [debouncedQuery, filteredResults.length]);

  const applyQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
    });
  }, []);

  const handleResultOpen = useCallback((result: SearchResult) => {
    if (query.trim()) {
      setRecentSearches(pushRecentSearch(query));
    }

    onClose();
    router.push(result.href);
  }, [onClose, query, router]);

  const handleClearQuery = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    setTypeFilter('all');
    setProjectFilter('all');
    setStatusFilter('all');
    setDateFilter('all');
    inputRef.current?.focus();
  }, []);

  const showAdvancedFilters = loading || Boolean(debouncedQuery) || results.length > 0;

  return (
    <AnimatePresence initial={!prefersReducedMotion}>
      {isOpen ? (
        <motion.div
          className="fixed inset-0 z-[100] sm:hidden"
          initial={prefersReducedMotion ? 'show' : 'hidden'}
          animate="show"
          exit={prefersReducedMotion ? undefined : 'exit'}
        >
          <motion.div
            className="absolute inset-0 bg-black/65 backdrop-blur-sm"
            variants={modalOverlay}
          />

          <motion.section
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-search-title"
            aria-describedby="mobile-search-description"
            className="absolute inset-0 flex h-full flex-col overflow-hidden bg-[var(--surface-0)] text-[var(--text-primary)]"
            variants={modalContent}
          >
            <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-0)]/92 px-4 pb-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
              <div className="mb-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                  aria-label="Close search"
                >
                  <ArrowLeft size={18} />
                </button>

                <div className="min-w-0 flex-1">
                  <h2 id="mobile-search-title" className="text-base font-semibold text-[var(--text-primary)]">
                    Global Search
                  </h2>
                  <p id="mobile-search-description" className="text-xs text-[var(--text-tertiary)]">
                    Search tasks, triage, and captured notes in real time.
                  </p>
                </div>
              </div>

              <div className="input-glow flex min-h-14 items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--surface-1)]/85 px-4 shadow-[0_20px_40px_rgba(2,6,23,0.28)] backdrop-blur-xl">
                <Search size={18} className="shrink-0 text-[var(--text-tertiary)]" />
                <input
                  ref={inputRef}
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder="Search tasks, triage, notes..."
                  className="h-11 w-full bg-transparent text-base text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  aria-label="Search across tasks, triage, and notes"
                  autoCapitalize="none"
                  autoCorrect="off"
                  enterKeyHint="search"
                />
                <div className="flex items-center gap-1">
                  {loading ? (
                    <Loader2 size={18} className="animate-spin text-[var(--accent)]" aria-hidden="true" />
                  ) : null}
                  {query ? (
                    <button
                      type="button"
                      onClick={handleClearQuery}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-tertiary)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                      aria-label="Clear search query"
                    >
                      <X size={18} />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Type filters" role="toolbar">
                {TYPE_FILTERS.map((filter) => {
                  const active = typeFilter === filter.key;
                  return (
                    <button
                      key={filter.key}
                      type="button"
                      onClick={() => setTypeFilter(filter.key)}
                      aria-pressed={active}
                      className={cn(
                        'min-h-11 shrink-0 rounded-full px-4 text-sm font-medium transition',
                        active
                          ? 'bg-sky-500/18 text-sky-200 ring-1 ring-sky-400/30'
                          : 'bg-[var(--surface-1)] text-[var(--text-secondary)] ring-1 ring-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      {filter.label}
                    </button>
                  );
                })}
              </div>

              {showAdvancedFilters ? (
                <div className="mt-2 space-y-2">
                  {projectOptions.length > 0 ? (
                    <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Project filters" role="toolbar">
                      <button
                        type="button"
                        onClick={() => setProjectFilter('all')}
                        aria-pressed={projectFilter === 'all'}
                        className={cn(
                          'min-h-11 shrink-0 rounded-full px-4 text-sm transition',
                          projectFilter === 'all'
                            ? 'bg-[var(--surface-2)] text-[var(--text-primary)] ring-1 ring-[var(--border)]'
                            : 'bg-[var(--surface-1)] text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        All projects
                      </button>
                      {projectOptions.map((project) => (
                        <button
                          key={project}
                          type="button"
                          onClick={() => setProjectFilter(project)}
                          aria-pressed={projectFilter === project}
                          className={cn(
                            'min-h-11 shrink-0 rounded-full px-4 text-sm transition',
                            projectFilter === project
                              ? 'bg-[var(--surface-2)] text-[var(--text-primary)] ring-1 ring-[var(--border)]'
                              : 'bg-[var(--surface-1)] text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)] hover:text-[var(--text-primary)]',
                          )}
                        >
                          {project}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Date filters" role="toolbar">
                    {DATE_FILTERS.map((filter) => (
                      <button
                        key={filter.key}
                        type="button"
                        onClick={() => setDateFilter(filter.key)}
                        aria-pressed={dateFilter === filter.key}
                        className={cn(
                          'min-h-11 shrink-0 rounded-full px-4 text-sm transition',
                          dateFilter === filter.key
                            ? 'bg-[var(--surface-2)] text-[var(--text-primary)] ring-1 ring-[var(--border)]'
                            : 'bg-[var(--surface-1)] text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>

                  {statusOptions.length > 0 ? (
                    <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Status filters" role="toolbar">
                      <button
                        type="button"
                        onClick={() => setStatusFilter('all')}
                        aria-pressed={statusFilter === 'all'}
                        className={cn(
                          'min-h-11 shrink-0 rounded-full px-4 text-sm transition',
                          statusFilter === 'all'
                            ? 'bg-[var(--surface-2)] text-[var(--text-primary)] ring-1 ring-[var(--border)]'
                            : 'bg-[var(--surface-1)] text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        Any status
                      </button>
                      {statusOptions.map((status) => (
                        <button
                          key={status}
                          type="button"
                          onClick={() => setStatusFilter(status)}
                          aria-pressed={statusFilter === status}
                          className={cn(
                            'min-h-11 shrink-0 rounded-full px-4 text-sm transition',
                            statusFilter === status
                              ? 'bg-[var(--surface-2)] text-[var(--text-primary)] ring-1 ring-[var(--border)]'
                              : 'bg-[var(--surface-1)] text-[var(--text-secondary)] ring-1 ring-[var(--border-subtle)] hover:text-[var(--text-primary)]',
                          )}
                        >
                          {status}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {debouncedQuery ? (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-sm text-[var(--text-secondary)]" aria-live="polite">
                    {loading
                      ? results.length === 0
                        ? `Searching for “${debouncedQuery}”…`
                        : `Updating results for “${debouncedQuery}”…`
                      : resultLabel}
                  </p>
                  <div className="flex items-center gap-2">
                    {semanticEnabled && semanticAvailable ? (
                      <span className="text-xs text-[var(--text-tertiary)]">
                        {semanticLoading ? 'Finding related…' : 'Related on'}
                      </span>
                    ) : null}
                    {!loading && durationMs !== null ? (
                      <span className="text-xs text-[var(--text-tertiary)]">{durationMs}ms</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div
              className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4"
              aria-busy={loading}
            >
              {!debouncedQuery ? (
                <div className="space-y-6">
                  <RecentSearchesSection
                    recentSearches={recentSearches}
                    onSelect={applyQuery}
                    onClear={() => {
                      clearRecentSearches();
                      setRecentSearches([]);
                    }}
                  />

                  <section aria-labelledby="mobile-search-suggested">
                    <div className="mb-3 flex items-center gap-2">
                      <Sparkles size={14} className="text-sky-300" />
                      <h3 id="mobile-search-suggested" className="text-sm font-semibold text-[var(--text-primary)]">
                        Suggested Searches
                      </h3>
                    </div>

                    <div className="grid gap-3">
                      {SUGGESTED_SEARCHES.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => applyQuery(suggestion)}
                          className="flex min-h-14 items-center justify-between rounded-[20px] border border-white/10 bg-white/[0.04] px-4 text-left backdrop-blur-xl transition hover:bg-white/[0.06]"
                          aria-label={`Search for ${suggestion}`}
                        >
                          <div>
                            <div className="text-sm font-medium text-[var(--text-primary)]">{suggestion}</div>
                            <div className="mt-1 text-xs text-[var(--text-tertiary)]">Tap to search instantly</div>
                          </div>
                          <Search size={16} className="text-[var(--text-tertiary)]" />
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              ) : loading && filteredResults.length === 0 ? (
                <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 text-center">
                  <Loader2 size={28} className="animate-spin text-[var(--accent)]" />
                  <p className="text-sm text-[var(--text-secondary)]">Searching across Mission Control…</p>
                </div>
              ) : filteredResults.length === 0 ? (
                <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-1)] text-[var(--text-tertiary)] ring-1 ring-[var(--border)]">
                    <Search size={24} />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">No results found</h3>
                  <p className="mt-2 max-w-xs text-sm leading-6 text-[var(--text-secondary)]">
                    Try a broader query, switch filters, or explore one of the suggested searches.
                  </p>
                  {note ? (
                    <p className="mt-3 text-xs text-[var(--text-tertiary)]">{note}</p>
                  ) : null}
                </div>
              ) : (
                <motion.div
                  className="space-y-3"
                  initial={prefersReducedMotion ? 'show' : 'hidden'}
                  animate="show"
                  variants={staggerContainer}
                >
                  {filteredResults.map((result) => {
                    const badge = getBadgeConfig(result);
                    const BadgeIcon = badge.icon;
                    const sourceLine = formatSourceLine(result);
                    const metadataLine = formatMetadataLine(result);

                    return (
                      <motion.button
                        key={`${result.type}-${result.id}`}
                        type="button"
                        onClick={() => handleResultOpen(result)}
                        className="w-full rounded-[24px] border border-white/10 bg-white/[0.04] p-4 text-left shadow-[0_18px_40px_rgba(2,6,23,0.24)] backdrop-blur-xl transition hover:bg-white/[0.06] active:scale-[0.99]"
                        variants={fadeSlideUp}
                        aria-label={`Open ${badge.label} ${result.title}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex min-h-11 min-w-11 items-center justify-center rounded-2xl bg-[var(--surface-1)] text-[var(--text-secondary)] ring-1 ring-[var(--border)]">
                            <BadgeIcon size={18} />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={cn(
                                  'inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold',
                                  badge.className,
                                )}
                              >
                                <BadgeIcon size={12} />
                                {badge.label}
                              </span>
                              {sourceLine ? (
                                <span className="text-xs text-[var(--text-tertiary)]">{sourceLine}</span>
                              ) : null}
                            </div>

                            <div className="mt-2 text-base font-semibold leading-6 text-[var(--text-primary)]">
                              {renderHighlightedText(result.highlights?.title || result.title)}
                            </div>

                            {(result.highlights?.snippet || result.snippet) ? (
                              <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--text-secondary)]">
                                {renderHighlightedText(result.highlights?.snippet || result.snippet)}
                              </p>
                            ) : null}

                            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--text-tertiary)]">
                              {metadataLine ? (
                                <span className="flex items-center gap-1.5">
                                  <CalendarDays size={12} />
                                  {metadataLine}
                                </span>
                              ) : null}
                              <span className="flex items-center gap-1.5">
                                <CheckCircle2 size={12} />
                                {result.source === 'fts' ? 'Keyword' : result.source === 'semantic' ? 'Related' : 'Keyword + related'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </motion.button>
                    );
                  })}

                  {note ? (
                    <div className="rounded-[18px] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 text-xs text-[var(--text-tertiary)]">
                      {note}
                    </div>
                  ) : null}
                </motion.div>
              )}
            </div>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default MobileSearchScreen;
