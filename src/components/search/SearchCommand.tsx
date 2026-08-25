'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Bell, Calendar, Filter, ListTodo, Loader2, Plus, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fadeSlideUp, modalContent, modalOverlay, staggerContainer } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { parseTaskInput, parseTaskInputForSubmission, type QuickAddProject } from '@/lib/parse-task-input';
import {
  DEFAULT_QUICK_ADD_PREFERENCES,
  getQuickAddPreferences,
  QUICK_ADD_PREFERENCES_EVENT,
  type QuickAddPreferences,
} from '@/lib/quick-add-preferences';
import { toast } from 'sonner';
import { taskLogger } from '@/lib/client-logger';
import { useProgressiveSearch } from '@/lib/hooks/useProgressiveSearch';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';

type TypeFilter = 'all' | 'tasks' | 'notifications';

interface SearchResult {
  type: 'task' | 'notification';
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: 'fts' | 'semantic' | 'hybrid';
  href: string;
  highlights?: {
    title?: string;
    snippet?: string;
  };
  metadata: Record<string, unknown>;
}

interface ActiveFilters {
  type: TypeFilter;
  source: string | null;
  status: string | null;
  excludeDone: boolean;
}

const RECENT_SEARCHES_KEY = 'mc:recent-searches';
const MAX_RECENT_SEARCHES = 5;

const SUGGESTED_SEARCHES = [
  { label: 'High priority tasks', query: 'high priority' },
  { label: 'Unread notifications', query: 'unread notification' },
  { label: 'In progress', query: 'in progress' },
];

function getRecentSearches(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
    return stored ? (JSON.parse(stored) as string[]).slice(0, MAX_RECENT_SEARCHES) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(query: string) {
  if (typeof window === 'undefined' || !query.trim()) return;
  try {
    const existing = getRecentSearches().filter((q) => q !== query.trim());
    const updated = [query.trim(), ...existing].slice(0, MAX_RECENT_SEARCHES);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
  } catch {
    // localStorage unavailable
  }
}

function renderHighlightedText(value: string) {
  if (!value) {
    return null;
  }

  return value.split(/(<mark>.*?<\/mark>)/g).filter(Boolean).map((part, index) => {
    const marked = part.match(/^<mark>(.*)<\/mark>$/);
    if (!marked) {
      return <span key={`${part}-${index}`}>{part}</span>;
    }

    return (
      <mark
        key={`${marked[1]}-${index}`}
        className="rounded-[4px] bg-yellow-300 px-0.5 font-semibold text-yellow-950"
      >
        {marked[1]}
      </mark>
    );
  });
}

function extractRefiners(results: SearchResult[]) {
  const sources = new Set<string>();
  const statuses = new Set<string>();

  for (const result of results) {
    const source = result.metadata.sourceListName || result.metadata.connectorType;
    if (source) sources.add(String(source));
    const status = result.metadata.status || result.metadata.category;
    if (status) statuses.add(String(status));
  }

  return { sources: Array.from(sources).sort(), statuses: Array.from(statuses).sort() };
}

export function SearchCommand() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);
  const [filters, setFilters] = useState<ActiveFilters>({ type: 'all', source: null, status: null, excludeDone: true });
  const [showFilters, setShowFilters] = useState(false);
  const [projects, setProjects] = useState<QuickAddProject[]>([]);
  const [projectsLoadState, setProjectsLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [quickAddPreferences, setQuickAddPreferencesState] = useState<QuickAddPreferences>(DEFAULT_QUICK_ADD_PREFERENCES);
  const [creatingTask, setCreatingTask] = useState(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const parsedCreateTask = useMemo(
    () => parseTaskInput(query, { ...quickAddPreferences, projects }),
    [query, quickAddPreferences, projects],
  );
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
    enabled: open,
    type: filters.type,
    limit: 30,
    source: filters.source,
    status: filters.status,
    excludeDone: filters.excludeDone,
  });

  useEffect(() => {
    const syncPreferences = () => setQuickAddPreferencesState(getQuickAddPreferences());
    syncPreferences();
    window.addEventListener(QUICK_ADD_PREFERENCES_EVENT, syncPreferences);
    window.addEventListener('storage', syncPreferences);

    fetch('/api/hub-projects')
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load projects (${response.status})`);
        return response.json();
      })
      .then((data) => {
        setProjects(data.projects || []);
        setProjectsLoadState('ready');
      })
      .catch((error) => {
        setProjectsLoadState('error');
        taskLogger.error('Failed to load projects for command palette', { error });
      });

    return () => {
      window.removeEventListener(QUICK_ADD_PREFERENCES_EVENT, syncPreferences);
      window.removeEventListener('storage', syncPreferences);
    };
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);

    if (!nextOpen) {
      setActiveIndex(-1);
      setPreviewTaskId(null);
      setShowFilters(false);
      if (!query.trim()) {
        setFilters({ type: 'all', source: null, status: null, excludeDone: true });
      }
    }
  }, [query]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(-1);

    if (!value.trim()) {
      setDebouncedQuery('');
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 80);

    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    const openSearch = () => setOpen(true);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!open && shouldBlockGlobalShortcut(event)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };

    window.addEventListener('mission-control:open-search', openSearch as EventListener);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mission-control:open-search', openSearch as EventListener);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // Apply client-side filters (source, status) on top of API results
  const filteredResults = useMemo(() => {
    let filtered = results;
    if (filters.source) {
      filtered = filtered.filter((r) => {
        const source = r.metadata.sourceListName || r.metadata.connectorType;
        return source && String(source) === filters.source;
      });
    }
    if (filters.status) {
      filtered = filtered.filter((r) => {
        const status = r.metadata.status || r.metadata.category;
        return status && String(status) === filters.status;
      });
    }
    if (filters.excludeDone) {
      filtered = filtered.filter((r) => {
        const status = r.metadata.status || r.metadata.category;
        return !status || String(status).toLowerCase() !== 'done';
      });
    }
    return filtered;
  }, [results, filters.source, filters.status, filters.excludeDone]);

  const refiners = useMemo(() => extractRefiners(results), [results]);

  const groupedResults = useMemo(() => ({
    tasks: filteredResults.filter((result) => result.type === 'task'),
    notifications: filteredResults.filter((result) => result.type === 'notification'),
  }), [filteredResults]);

  // Flat list for keyboard navigation
  const flatResults = useMemo(() => [
    ...groupedResults.tasks,
    ...groupedResults.notifications,
  ], [groupedResults]);

  const hasActiveFilters = filters.source !== null || filters.status !== null || filters.type !== 'all' || !filters.excludeDone;

  const clearFilters = () => {
    setFilters({ type: 'all', source: null, status: null, excludeDone: true });
  };

  useEffect(() => {
    setActiveIndex(-1);
  }, [filters.excludeDone, filters.source, filters.status, filters.type]);

  const openResult = useCallback((result: SearchResult) => {
    saveRecentSearch(query);
    if (result.type === 'task') {
      setPreviewTaskId(result.id);
    } else {
      handleOpenChange(false);
      router.push(result.href);
    }
  }, [router, query]);

  const createTask = useCallback(async () => {
    const taskToCreate = parseTaskInputForSubmission(query, { ...quickAddPreferences, projects });
    if (!taskToCreate.title || creatingTask) return;
    if (taskToCreate.project && !taskToCreate.projectId) {
      if (projectsLoadState === 'loading') {
        toast.info('Projects are still loading. Try again in a moment.');
      } else if (projectsLoadState === 'error') {
        toast.error('Projects could not be loaded. Remove the +Project token or reload and try again.');
      } else {
        toast.error(`Project “${taskToCreate.project}” was not found. Select a matching +Project.`);
      }
      return;
    }
    setCreatingTask(true);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: taskToCreate.title,
          dueDate: taskToCreate.dueDate,
          priority: taskToCreate.priority || 'none',
          connectorType: 'local',
          estimatedDuration: taskToCreate.estimatedDuration || undefined,
          recurrence: taskToCreate.recurrence || undefined,
          effort: taskToCreate.effort || undefined,
          tagSlugs: taskToCreate.tags.length > 0 ? taskToCreate.tags : undefined,
          projectIds: taskToCreate.projectId ? [taskToCreate.projectId] : undefined,
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text() || `Failed to create task (${response.status})`);
      }
      window.dispatchEvent(new CustomEvent('mission-control:task-added'));
      toast.success(`Created “${taskToCreate.title}”`);
      setQuery('');
      setDebouncedQuery('');
      handleOpenChange(false);
    } catch (error) {
      taskLogger.error('Failed to create task from command palette', { error });
      toast.error(error instanceof Error ? error.message : 'Failed to create task');
    } finally {
      setCreatingTask(false);
    }
  }, [creatingTask, query, quickAddPreferences, projects, handleOpenChange, projectsLoadState]);

  const acceptDateSuggestion = useCallback(() => {
    const suggestion = parsedCreateTask.dateSuggestion;
    if (!suggestion) return;
    const matchIndex = query.toLowerCase().lastIndexOf(suggestion.matchedText.toLowerCase());
    if (matchIndex < 0) return;
    const nextQuery = `${query.slice(0, matchIndex)}/due:${query.slice(matchIndex)}`;
    handleQueryChange(nextQuery);
  }, [parsedCreateTask.dateSuggestion, query, handleQueryChange]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && previewTaskId) {
      event.preventDefault();
      setPreviewTaskId(null);
      return;
    }

    if (flatResults.length === 0) {
      if (event.key === 'Enter' && query.trim() && parsedCreateTask.title) {
        event.preventDefault();
        void createTask();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % flatResults.length);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        setActiveIndex((prev) => (prev <= 0 ? flatResults.length - 1 : prev - 1));
        break;
      }
      case 'Enter': {
        if (activeIndex >= 0 && activeIndex < flatResults.length) {
          event.preventDefault();
          openResult(flatResults[activeIndex]);
        } else if (query.trim() && parsedCreateTask.title) {
          event.preventDefault();
          void createTask();
        }
        break;
      }
    }
  }, [flatResults, activeIndex, openResult, previewTaskId, query, parsedCreateTask.title, createTask]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !resultsRef.current) return;
    const items = resultsRef.current.querySelectorAll('[data-search-item]');
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="flex w-full min-h-10 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] px-2.5 py-2 text-sm text-[var(--text-secondary)] shadow-[0_1px_0_rgba(255,255,255,0.04),0_14px_32px_rgba(0,0,0,0.18)] transition-[background-color,border-color,color,transform,box-shadow] duration-200 hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)] active:scale-[0.96] sm:px-3"
        >
          <Search size={15} className="text-[var(--text-tertiary)]" />
          <span className="hidden text-[var(--text-primary)] sm:inline">Search</span>
          <span className="hidden text-xs text-[var(--text-tertiary)] md:inline">Ctrl K</span>
        </button>
      </Dialog.Trigger>

      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm"
                initial="hidden"
                animate="show"
                exit="exit"
                variants={modalOverlay}
              />
            </Dialog.Overlay>

            <Dialog.Content
              asChild
              onOpenAutoFocus={(event) => event.preventDefault()}
              onEscapeKeyDown={(event) => {
                if (previewTaskId) {
                  event.preventDefault();
                  setPreviewTaskId(null);
                }
              }}
            >
              <motion.div
                className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[min(780px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-0)] shadow-2xl"
                initial="hidden"
                animate="show"
                exit="exit"
                variants={modalContent}
              >
                <div className={cn(
                  "flex min-w-0 flex-1 flex-col transition-all duration-200",
                  previewTaskId && "max-w-[50%]"
                )}>
                  <Dialog.Title className="sr-only">Search Mission Control</Dialog.Title>
                  <Dialog.Description className="sr-only">
                    Search across tasks and notifications using keyword or semantic matching.
                  </Dialog.Description>

                  {/* Search input header */}
                  <div className="shrink-0 border-b border-[var(--border)] p-3 sm:p-4">
                    <div className="input-glow flex items-center gap-3 rounded-[var(--radius-md)]">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--surface-1)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                        {loading ? (
                          <Loader2 size={15} className="animate-spin text-[var(--accent-400)]" />
                        ) : (
                          <Search size={15} className="text-[var(--text-secondary)]" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <input
                          ref={inputRef}
                          value={query}
                          onChange={(event) => handleQueryChange(event.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder="Search tasks and notifications..."
                          className="w-full bg-transparent text-base text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                        />
                      </div>
                      <kbd className="hidden shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] sm:inline-block">
                        ESC
                      </kbd>
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          aria-label="Close search"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                        >
                          <X size={16} />
                        </button>
                      </Dialog.Close>
                    </div>

                    {/* Mode and filter row */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-[var(--surface-1)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                        Keyword
                      </span>
                      {semanticEnabled && semanticAvailable ? (
                        <span className="rounded-full bg-[var(--accent-900)]/30 px-2.5 py-1 text-[11px] font-medium text-[var(--accent-300)] shadow-[inset_0_0_0_1px_rgba(96,165,250,0.2)]">
                          {semanticLoading ? 'Finding related…' : 'Related results on'}
                        </span>
                      ) : null}

                      <div className="mx-1 h-4 w-px bg-[var(--border)]" />

                      {/* Filter toggle */}
                      <button
                        type="button"
                        onClick={() => setShowFilters((v) => !v)}
                        className={cn(
                          'flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-150 active:scale-[0.96]',
                          showFilters || hasActiveFilters
                            ? 'bg-[var(--accent-900)]/30 text-[var(--accent-300)] shadow-[inset_0_0_0_1px_rgba(96,165,250,0.2)]'
                            : 'bg-[var(--surface-1)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                        )}
                      >
                        <Filter size={10} />
                        Filters
                        {hasActiveFilters && (
                          <span className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent-400)] text-[9px] font-bold text-[var(--surface-0)]">
                            {(filters.source ? 1 : 0) + (filters.status ? 1 : 0) + (filters.type !== 'all' ? 1 : 0)}
                          </span>
                        )}
                      </button>

                      {/* Result count and timing */}
                      {!loading && debouncedQuery && filteredResults.length > 0 && durationMs !== null && (
                        <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
                          {filteredResults.length} result{filteredResults.length !== 1 ? 's' : ''} · {durationMs}ms
                        </span>
                      )}
                    </div>

                    {/* Refiner pills */}
                    <AnimatePresence>
                      {showFilters && results.length > 0 && (
                        <motion.div
                          className="mt-2.5 space-y-2"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          {/* Type filter */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Type</span>
                            {(['all', 'tasks', 'notifications'] as TypeFilter[]).map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setFilters((f) => ({ ...f, type: t }))}
                                className={cn(
                                  'rounded-md px-2 py-0.5 text-[11px] transition-colors duration-100',
                                  filters.type === t
                                    ? 'bg-[var(--accent-900)]/40 text-[var(--accent-300)]'
                                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]'
                                )}
                              >
                                {t === 'all' ? 'All' : t === 'tasks' ? 'Tasks' : 'Notifications'}
                              </button>
                            ))}
                          </div>

                          {/* Source filter */}
                          {refiners.sources.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Source</span>
                              {refiners.sources.slice(0, 6).map((source) => (
                                <button
                                  key={source}
                                  type="button"
                                  onClick={() => setFilters((f) => ({ ...f, source: f.source === source ? null : source }))}
                                  className={cn(
                                    'rounded-md px-2 py-0.5 text-[11px] transition-colors duration-100',
                                    filters.source === source
                                      ? 'bg-[var(--accent-900)]/40 text-[var(--accent-300)]'
                                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]'
                                  )}
                                >
                                  {source}
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Status filter */}
                          {refiners.statuses.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Status</span>
                              {refiners.statuses.slice(0, 6).map((status) => (
                                <button
                                  key={status}
                                  type="button"
                                  onClick={() => setFilters((f) => ({ ...f, status: f.status === status ? null : status }))}
                                  className={cn(
                                    'rounded-md px-2 py-0.5 text-[11px] transition-colors duration-100',
                                    filters.status === status
                                      ? 'bg-[var(--accent-900)]/40 text-[var(--accent-300)]'
                                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]'
                                  )}
                                >
                                  {status}
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Include done toggle */}
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setFilters((f) => ({ ...f, excludeDone: !f.excludeDone }))}
                              className={cn(
                                'rounded-md px-2 py-0.5 text-[11px] transition-colors duration-100',
                                !filters.excludeDone
                                  ? 'bg-[var(--accent-900)]/40 text-[var(--accent-300)]'
                                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]'
                              )}
                            >
                              Include done
                            </button>
                          </div>

                          {hasActiveFilters && (
                            <button
                              type="button"
                              onClick={clearFilters}
                              className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                            >
                              <X size={10} />
                              Clear filters
                            </button>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {semanticEnabled && !semanticAvailable ? (
                      <div className="mt-2.5 flex items-center gap-2 rounded-[var(--radius-md)] border border-yellow-500/20 bg-yellow-500/5 px-3 py-1.5 text-[11px] text-yellow-200/80">
                        <AlertTriangle size={11} className="shrink-0 text-yellow-400/70" />
                        <span>Related results are unavailable. Keyword search remains active.</span>
                      </div>
                    ) : null}
                  </div>

                  {/* Results area */}
                  <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
                    {query.trim() && parsedCreateTask.title ? (
                      <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--accent-700)]/30 bg-[var(--accent-900)]/10 p-2">
                        <button
                          type="button"
                          onClick={() => void createTask()}
                          disabled={creatingTask}
                          className="flex w-full items-start gap-2.5 rounded-[var(--radius-md)] px-2 py-2 text-left transition-colors hover:bg-[var(--accent-900)]/20 disabled:opacity-60"
                        >
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent-900)]/40 text-[var(--accent-300)]">
                            {creatingTask ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--accent-300)]">
                              Create task · Enter
                            </span>
                            <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                              {parsedCreateTask.title}
                            </span>
                            <span className="mt-1 flex flex-wrap gap-1 text-[10px] text-[var(--text-tertiary)]">
                              {parsedCreateTask.priority && <span>!{parsedCreateTask.priority}</span>}
                              {parsedCreateTask.tags.map(tag => <span key={tag}>#{tag}</span>)}
                              {parsedCreateTask.project && <span>+{parsedCreateTask.project}</span>}
                              {parsedCreateTask.dueDateLabel && <span>{parsedCreateTask.dueDateLabel}</span>}
                            </span>
                          </span>
                        </button>
                        {parsedCreateTask.dateSuggestion && (
                          <button
                            type="button"
                            onClick={acceptDateSuggestion}
                            className="ml-11 mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-green-300 transition-colors hover:bg-green-900/30"
                          >
                            <Calendar size={11} /> Use {parsedCreateTask.dateSuggestion.label} as due date
                          </button>
                        )}
                      </div>
                    ) : null}
                    {!debouncedQuery && !loading ? (
                      <div className="space-y-4">
                        {(() => {
                          const recent = getRecentSearches();
                          if (recent.length > 0) {
                            return (
                              <div>
                                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-tertiary)]">Recent</p>
                                <div className="space-y-0.5">
                                  {recent.map((q) => (
                                    <button
                                      key={q}
                                      type="button"
                                      onClick={() => { handleQueryChange(q); setQuery(q); }}
                                      className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors duration-100 hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]"
                                    >
                                      <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                                      {q}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })()}
                        <div>
                          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-tertiary)]">Suggestions</p>
                          <div className="space-y-0.5">
                            {SUGGESTED_SEARCHES.map((suggestion) => (
                              <button
                                key={suggestion.query}
                                type="button"
                                onClick={() => { handleQueryChange(suggestion.query); setQuery(suggestion.query); }}
                                className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors duration-100 hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]"
                              >
                                <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                                {suggestion.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {loading && debouncedQuery && filteredResults.length === 0 ? (
                      <div className="flex items-center gap-2 px-1 py-6 text-sm text-[var(--text-tertiary)]">
                        <Loader2 size={14} className="animate-spin" />
                        Searching...
                      </div>
                    ) : null}

                    {/* Inline typing indicator before debounce fires */}
                    {!loading && query.trim() && query.trim() !== debouncedQuery ? (
                      <div className="flex items-center gap-2 px-1 py-6 text-sm text-[var(--text-tertiary)]">
                        <Loader2 size={14} className="animate-spin" />
                        <span className="animate-pulse">Typing...</span>
                      </div>
                    ) : null}

                    {!loading && debouncedQuery && filteredResults.length === 0 ? (
                      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)]/60 px-4 py-8 text-center">
                        <p className="text-sm text-[var(--text-primary)]">No matching results.</p>
                        <p className="mt-2 text-xs text-[var(--text-tertiary)]">
                          {hasActiveFilters ? (
                            <button
                              type="button"
                              onClick={clearFilters}
                              className="text-[var(--accent-400)] hover:underline"
                            >
                              Clear filters to see all {results.length} result{results.length !== 1 ? 's' : ''}
                            </button>
                          ) : 'Try different keywords or a broader phrase.'}
                        </p>
                      </div>
                    ) : null}

                    {filteredResults.length > 0 ? (
                      <motion.div
                        className="space-y-4"
                        initial="hidden"
                        animate="show"
                        exit="hidden"
                        variants={staggerContainer}
                      >
                        {groupedResults.tasks.length > 0 && (
                          <section>
                            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-tertiary)]">
                              <ListTodo size={11} />
                              Tasks ({groupedResults.tasks.length})
                            </div>
                            <div className="space-y-1">
                              {groupedResults.tasks.map((result, idx) => (
                                <motion.button
                                  key={`task-${result.id}`}
                                  type="button"
                                  data-search-item
                                  onClick={() => openResult(result)}
                                  onMouseEnter={() => setActiveIndex(idx)}
                                  className={cn(
                                    'w-full rounded-[var(--radius-md)] border border-transparent px-3 py-2.5 text-left transition-[background-color,border-color] duration-100 hover:bg-[var(--surface-1)]',
                                    activeIndex === idx && 'bg-[var(--surface-1)] border-[var(--accent-700)]/30',
                                    previewTaskId === result.id && 'bg-[var(--accent-900)]/20 border-[var(--accent-700)]/40',
                                  )}
                                  variants={fadeSlideUp}
                                >
                                  <div className="flex items-start gap-2.5">
                                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-1)] text-[var(--accent-300)]">
                                      <ListTodo size={13} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-medium text-[var(--text-primary)]">
                                        {renderHighlightedText(result.highlights?.title || result.title)}
                                      </div>
                                      {(result.highlights?.snippet || result.snippet) && (
                                        <div className="mt-0.5 line-clamp-1 text-xs text-[var(--text-secondary)]">
                                          {renderHighlightedText(result.highlights?.snippet || result.snippet)}
                                        </div>
                                      )}
                                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                        {result.source === 'semantic' ? (
                                          <span className="rounded-md bg-[var(--accent-900)]/30 px-1.5 py-0.5 text-xs text-[var(--accent-300)]">
                                            Related
                                          </span>
                                        ) : null}
                                        {result.metadata.status ? (
                                          <span
                                            className="cursor-pointer rounded-md bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                            onClick={(e) => { e.stopPropagation(); setFilters((f) => ({ ...f, status: String(result.metadata.status) })); setShowFilters(true); }}
                                          >
                                            {String(result.metadata.status)}
                                          </span>
                                        ) : null}
                                        {result.metadata.sourceListName ? (
                                          <span
                                            className="cursor-pointer rounded-md bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                            onClick={(e) => { e.stopPropagation(); setFilters((f) => ({ ...f, source: String(result.metadata.sourceListName) })); setShowFilters(true); }}
                                          >
                                            {String(result.metadata.sourceListName)}
                                          </span>
                                        ) : null}
                                        {result.metadata.connectorType && !result.metadata.sourceListName ? (
                                          <span
                                            className="cursor-pointer rounded-md bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                            onClick={(e) => { e.stopPropagation(); setFilters((f) => ({ ...f, source: String(result.metadata.connectorType) })); setShowFilters(true); }}
                                          >
                                            {String(result.metadata.connectorType)}
                                          </span>
                                        ) : null}
                                      </div>
                                    </div>
                                  </div>
                                </motion.button>
                              ))}
                            </div>
                          </section>
                        )}

                        {groupedResults.notifications.length > 0 && (
                          <section>
                            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-tertiary)]">
                              <Bell size={11} />
                              Notifications ({groupedResults.notifications.length})
                            </div>
                            <div className="space-y-1">
                              {groupedResults.notifications.map((result, idx) => {
                                const flatIdx = groupedResults.tasks.length + idx;
                                return (
                                  <motion.button
                                    key={`notification-${result.id}`}
                                    type="button"
                                    data-search-item
                                    onClick={() => openResult(result)}
                                    onMouseEnter={() => setActiveIndex(flatIdx)}
                                    className={cn(
                                      'w-full rounded-[var(--radius-md)] border border-transparent px-3 py-2.5 text-left transition-[background-color,border-color] duration-100 hover:bg-[var(--surface-1)]',
                                      activeIndex === flatIdx && 'bg-[var(--surface-1)] border-[var(--accent-700)]/30',
                                    )}
                                    variants={fadeSlideUp}
                                  >
                                    <div className="flex items-start gap-2.5">
                                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-1)] text-[var(--accent-300)]">
                                        <Bell size={13} />
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium text-[var(--text-primary)]">
                                          {renderHighlightedText(result.highlights?.title || result.title)}
                                        </div>
                                        {(result.highlights?.snippet || result.snippet) && (
                                          <div className="mt-0.5 line-clamp-1 text-xs text-[var(--text-secondary)]">
                                            {renderHighlightedText(result.highlights?.snippet || result.snippet)}
                                          </div>
                                        )}
                                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                          {result.source === 'semantic' ? (
                                            <span className="rounded-md bg-[var(--accent-900)]/30 px-1.5 py-0.5 text-xs text-[var(--accent-300)]">
                                              Related
                                            </span>
                                          ) : null}
                                          {result.metadata.category ? (
                                            <span
                                              className="cursor-pointer rounded-md bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                              onClick={(e) => { e.stopPropagation(); setFilters((f) => ({ ...f, status: String(result.metadata.category) })); setShowFilters(true); }}
                                            >
                                              {String(result.metadata.category)}
                                            </span>
                                          ) : null}
                                          {result.metadata.connectorType ? (
                                            <span
                                              className="cursor-pointer rounded-md bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                              onClick={(e) => { e.stopPropagation(); setFilters((f) => ({ ...f, source: String(result.metadata.connectorType) })); setShowFilters(true); }}
                                            >
                                              {String(result.metadata.connectorType)}
                                            </span>
                                          ) : null}
                                          {result.metadata.severity ? (
                                            <span className="rounded-md bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                                              {String(result.metadata.severity)}
                                            </span>
                                          ) : null}
                                        </div>
                                      </div>
                                    </div>
                                  </motion.button>
                                );
                              })}
                            </div>
                          </section>
                        )}
                      </motion.div>
                    ) : null}
                  </div>
                </div>

                {/* Inline task preview panel — inside the modal, not a separate floating pane */}
                <AnimatePresence>
                  {previewTaskId && (
                    <motion.div
                      className="w-[50%] shrink-0 border-l border-[var(--border)] overflow-y-auto"
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: '50%', opacity: 1 }}
                      exit={{ width: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                    >
                      <TaskDetailPanel
                        taskId={previewTaskId}
                        onClose={() => setPreviewTaskId(null)}
                        mode="panel"
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
