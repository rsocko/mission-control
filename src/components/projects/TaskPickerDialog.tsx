'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Image from 'next/image';
import { Search, Check, X, Loader2, Filter, List } from 'lucide-react';
import { modalOverlay, modalContent } from '@/lib/motion';
import { CONNECTOR_COLORS, CONNECTOR_ICON_PATHS } from '@/lib/constants/colors';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { cn } from '@/lib/utils';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { projectLogger } from '@/lib/client-logger';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import type { TaskPriority, TaskStatus } from '@/types';

interface PickerTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  connectorType: string;
  sourceListName?: string | null;
  sourceListId?: string | null;
  dueDate?: string | null;
  sourceId?: string | null;
  metadata?: string | null;
}

interface ConnectorInfo {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
}

interface SourceListInfo {
  id: string;
  sourceId: string;
  name: string;
  connectorInstanceId: string;
  taskCount: number;
}

interface TaskPickerDialogProps {
  /** Tasks already in the project — will be excluded from search results */
  excludeTaskIds: string[];
  onClose: () => void;
  /** Called with the selected task IDs when the user confirms */
  onConfirm: (taskIds: string[]) => void;
  title?: string;
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
  none: '—',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_OPTIONS: Array<{ value: TaskStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

const BUTTON_TRANSITION = 'transition-[background-color,border-color,color,transform,box-shadow] duration-150';

function ConnectorIcon({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICON_PATHS[type];
  if (src) {
    return <Image src={src} alt={type} width={size} height={size} className="flex-shrink-0" />;
  }
  return <List size={size} className="flex-shrink-0 text-[var(--text-muted)]" />;
}

export function TaskPickerDialog({
  excludeTaskIds,
  onClose,
  onConfirm,
  title = 'Add existing tasks',
}: TaskPickerDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerTask[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const excludeSet = useRef(new Set(excludeTaskIds));

  // ── Filter state ─────────────────────────────────────────────────────────
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [sourceLists, setSourceLists] = useState<SourceListInfo[]>([]);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>('all');
  const [selectedListId, setSelectedListId] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<TaskStatus | 'all'>('all');
  const [noProjectOnly, setNoProjectOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // Update excludeSet when excludeTaskIds changes
  useEffect(() => {
    excludeSet.current = new Set(excludeTaskIds);
  }, [excludeTaskIds]);

  // Load connectors and source lists
  useEffect(() => {
    fetch('/api/connectors')
      .then((r) => r.json())
      .then((data) => {
        const conns: ConnectorInfo[] = (data.connectors || [])
          .filter((c: ConnectorInfo) => c.enabled)
          .map((c: ConnectorInfo) => ({ id: c.id, type: c.type, name: c.name, enabled: c.enabled }));
        setConnectors(conns);

        const lists: SourceListInfo[] = (data.sourceLists || []).map(
          (sl: SourceListInfo & Record<string, unknown>) => ({
            id: sl.id,
            sourceId: sl.sourceId,
            name: sl.name,
            connectorInstanceId: sl.connectorInstanceId,
            taskCount: sl.taskCount || 0,
          }),
        );
        setSourceLists(lists);
      })
      .catch((err) => { projectLogger.error('Failed to fetch source lists for task picker', { err }); });
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Filter source lists by selected connector
  const filteredSourceLists = useMemo(() => {
    if (selectedConnectorId === 'all') return sourceLists;
    return sourceLists.filter((sl) => sl.connectorInstanceId === selectedConnectorId);
  }, [sourceLists, selectedConnectorId]);

  // Search tasks with all filters
  const searchTasks = useCallback(
    async (searchQuery: string, connectorId: string, listId: string, status: TaskStatus | 'all') => {
      setLoading(true);
      setHasSearched(true);
      try {
        const params = new URLSearchParams({
          sortBy: 'updated',
          sortDirection: 'desc',
          limit: '100',
          openOnly: status === 'all' ? 'false' : 'false',
          parentOnly: 'true',
        });

        // Pass search query to the API for server-side filtering
        if (searchQuery.trim()) {
          params.set('search', searchQuery.trim());
        }

        // Apply connector filter
        if (connectorId !== 'all') {
          const conn = connectors.find((c) => c.id === connectorId);
          if (conn) params.set('source', conn.type);
        }

        // Apply list filter
        if (listId !== 'all') {
          const list = sourceLists.find((sl) => sl.id === listId);
          if (list) params.set('listId', list.sourceId);
        }

        // Apply status filter
        if (status !== 'all') {
          params.set('status', status);
        }

        // Apply "not in any project" filter
        if (noProjectOnly) {
          params.set('noProject', 'true');
        }

        const res = await fetch(`/api/tasks?${params}`);
        if (res.ok) {
          const data = await res.json();
          let allTasks: PickerTask[] = data.tasks || [];

          // Secondary client-side filter: also match display IDs not caught by server search
          if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            allTasks = allTasks.filter((t) => {
              if (t.title.toLowerCase().includes(q)) return true;
              const displayId = getTaskDisplayId(t.connectorType, t.metadata, t.sourceId);
              return displayId !== null && displayId.toLowerCase().includes(q);
            });
          }

          // Exclude tasks already in the project
          setResults(allTasks.filter((t) => !excludeSet.current.has(t.id)));
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [connectors, sourceLists, noProjectOnly],
  );

  // Debounced search: re-run whenever filters or query change
  useEffect(() => {
    const timer = setTimeout(() => {
      void searchTasks(query, selectedConnectorId, selectedListId, selectedStatus);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, selectedConnectorId, selectedListId, selectedStatus, noProjectOnly, searchTasks]);

  // Reset list filter when connector changes
  useEffect(() => {
    setSelectedListId('all');
  }, [selectedConnectorId]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const toggleTask = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(results.map((t) => t.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleConfirm = () => {
    if (selectedIds.size > 0) {
      onConfirm(Array.from(selectedIds));
    }
  };

  const hasActiveFilters = selectedConnectorId !== 'all' || selectedListId !== 'all' || selectedStatus !== 'all' || noProjectOnly;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
        variants={modalOverlay}
        initial="hidden"
        animate="show"
        exit="exit"
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

        {/* Dialog */}
        <motion.div
          className="relative z-10 flex max-h-[75vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
          variants={modalContent}
          initial="hidden"
          animate="show"
          exit="exit"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className={cn(
                'inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] active:scale-[0.96]',
                BUTTON_TRANSITION,
              )}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Search + Filter bar */}
          <div className="border-b border-[var(--border)] px-5 py-3 space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2">
                <Search size={14} className="text-[var(--text-tertiary)]" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or number..."
                  className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
                />
                {loading && <Loader2 size={14} className="animate-spin text-[var(--text-tertiary)]" />}
              </div>
              <button
                type="button"
                onClick={() => setShowFilters(!showFilters)}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-xl border px-3 text-sm active:scale-[0.96]',
                  hasActiveFilters
                    ? 'border-[var(--accent)]/40 bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)]'
                    : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                  BUTTON_TRANSITION,
                )}
              >
                <Filter size={13} />
                Filters
                {hasActiveFilters && (
                  <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[12px] font-bold text-white tabular-nums">
                    {(selectedConnectorId !== 'all' ? 1 : 0) + (selectedListId !== 'all' ? 1 : 0) + (selectedStatus !== 'all' ? 1 : 0) + (noProjectOnly ? 1 : 0)}
                  </span>
                )}
              </button>
            </div>

            {/* Filter dropdowns */}
            <AnimatePresence>
              {showFilters && (
                <motion.div
                  className="flex flex-wrap items-center gap-2"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {/* Source connector */}
                  <div className="flex min-h-9 items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <span className="font-medium">Source</span>
                    <Select value={selectedConnectorId} onValueChange={(v) => setSelectedConnectorId(v)}>
                      <SelectTrigger className="h-8 min-h-0 gap-1 rounded-lg border-[var(--border)] bg-[var(--surface-0)] px-2.5 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All sources</SelectItem>
                        {connectors.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Source list */}
                  <div className="flex min-h-9 items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <span className="font-medium">List</span>
                    <Select value={selectedListId} onValueChange={(v) => setSelectedListId(v)}>
                      <SelectTrigger className="h-8 min-h-0 max-w-[200px] gap-1 rounded-lg border-[var(--border)] bg-[var(--surface-0)] px-2.5 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All lists</SelectItem>
                        {filteredSourceLists.map((sl) => (
                          <SelectItem key={sl.id} value={sl.id}>
                            {sl.name} ({sl.taskCount})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Status */}
                  <div className="flex min-h-9 items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <span className="font-medium">Status</span>
                    <Select value={selectedStatus} onValueChange={(v) => setSelectedStatus(v as TaskStatus | 'all')}>
                      <SelectTrigger className="h-8 min-h-0 gap-1 rounded-lg border-[var(--border)] bg-[var(--surface-0)] px-2.5 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Not in any project */}
                  <label className="flex min-h-9 cursor-pointer items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={noProjectOnly}
                      onChange={(e) => setNoProjectOnly(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--accent)]"
                    />
                    <span className="font-medium">Not in any project</span>
                  </label>

                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedConnectorId('all');
                        setSelectedListId('all');
                        setSelectedStatus('all');
                        setNoProjectOnly(false);
                      }}
                      className="text-xs text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors"
                    >
                      Clear all
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Results header */}
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-2">
            <span className="text-xs text-[var(--text-tertiary)] tabular-nums">
              {loading ? 'Searching...' : `${results.length} task${results.length !== 1 ? 's' : ''} found`}
            </span>
            {results.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectedIds.size === results.length ? deselectAll : selectAll}
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  {selectedIds.size === results.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
            )}
          </div>

          {/* Results list */}
          <div className="flex-1 min-h-[200px] overflow-y-auto px-2 py-2">
            {results.length === 0 && hasSearched && !loading ? (
              <div className="py-12 text-center">
                <p className="text-sm text-[var(--text-tertiary)]">
                  {query.trim() || hasActiveFilters ? 'No tasks match your filters.' : 'No available tasks to add.'}
                </p>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setSelectedConnectorId('all');
                      setSelectedListId('all');
                      setSelectedStatus('all');
                    }}
                    className="mt-2 text-xs text-[var(--accent)] hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                {results.map((task) => {
                  const isSelected = selectedIds.has(task.id);
                  const connectorColor = CONNECTOR_COLORS[task.connectorType] || 'var(--text-muted)';
                  const displayId = getTaskDisplayId(task.connectorType, task.metadata, task.sourceId);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => toggleTask(task.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-100',
                        isSelected
                          ? 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]'
                          : 'hover:bg-[var(--surface-2)]',
                        isInactiveTaskStatus(task.status) && 'opacity-50',
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-[background-color,border-color] duration-100',
                          isSelected
                            ? 'border-[var(--accent)] bg-[var(--accent)]'
                            : 'border-[var(--border-strong)] bg-transparent',
                        )}
                      >
                        {isSelected && <Check size={12} className="text-white" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate text-sm font-medium text-[var(--text-primary)]', task.status === 'done' && 'line-through')}>
                          {displayId && <span className="mr-1.5 text-xs font-normal text-[var(--text-tertiary)]">{displayId}</span>}
                          {task.title}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
                          <span className="inline-flex items-center gap-1">
                            <ConnectorIcon type={task.connectorType} size={11} />
                            {task.sourceListName || task.connectorType}
                          </span>
                          <span>•</span>
                          <span>{STATUS_LABELS[task.status] ?? task.status}</span>
                          <span>•</span>
                          <span>{PRIORITY_LABELS[task.priority] ?? '—'}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-3">
            <span className="text-xs text-[var(--text-tertiary)]">
              {selectedIds.size > 0
                ? `${selectedIds.size} task${selectedIds.size > 1 ? 's' : ''} selected`
                : 'Select tasks to add'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className={cn(
                  'inline-flex min-h-9 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-4 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] active:scale-[0.96]',
                  BUTTON_TRANSITION,
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={selectedIds.size === 0}
                className={cn(
                  'inline-flex min-h-9 items-center rounded-lg bg-[var(--accent)] px-4 text-sm font-semibold text-white hover:bg-[var(--accent-hover)] active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none',
                  BUTTON_TRANSITION,
                )}
              >
                Add {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
