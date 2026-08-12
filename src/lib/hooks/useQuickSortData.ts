'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import type { LocalDisposition, TaskEditPolicy, TaskSourceModel } from '@/types';

export type QuickSortQueueMode = 'no_priority' | 'no_effort' | 'no_tags' | 'no_due_date';
export type QuickSortOrder = 'smart' | 'priority' | 'oldest' | 'newest' | 'random';

export interface QuickSortQueueTask {
  id: string;
  title: string;
  hasNotes: boolean;
  priority: string;
  effort: number | null;
  status: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  dueDate: string | null;
  createdAt: string;
  localDisposition: LocalDisposition;
  taskSourceModel: TaskSourceModel;
  projects: Array<{ id: string; name: string; color: string }>;
  phases: Array<{ id: string; name: string; projectId: string | null }>;
  tags: Array<{ id: string; name: string; slug: string; color: string | null }>;
  editPolicy: TaskEditPolicy;
}

export interface QuickSortModeCounts {
  no_priority: number;
  no_effort: number;
  no_tags: number;
  no_due_date: number;
}

export interface QuickSortSuggestion {
  priority: { value: string; confidence: number; reason: string } | null;
  effort: { value: number; confidence: number; reason: string } | null;
  tags: Array<{ id: string; name: string; confidence: number }>;
}

/** Which fields are still missing on a task. */
export function getMissingFields(task: QuickSortQueueTask): QuickSortQueueMode[] {
  const missing: QuickSortQueueMode[] = [];
  if (task.priority === 'none') missing.push('no_priority');
  if (task.effort === null) missing.push('no_effort');
  if (task.tags.filter(t => !isSyntheticTag(t.name)).length === 0) missing.push('no_tags');
  if (task.dueDate === null && ['critical', 'high'].includes(task.priority)) missing.push('no_due_date');
  return missing;
}

export interface QuickSortScopeFilter {
  source?: string;
  sourceList?: string;
  connectorId?: string;
}

export function useQuickSortData(mode: QuickSortQueueMode | null, scopeFilter?: QuickSortScopeFilter, order: QuickSortOrder = 'smart') {
  const [tasks, setTasks] = useState<QuickSortQueueTask[]>([]);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<QuickSortModeCounts | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [suggestions, setSuggestions] = useState<Record<string, QuickSortSuggestion>>({});
  const [recentTagIds, setRecentTagIds] = useState<string[]>([]);
  const queueRequestId = useRef(0);
  const doneIdsRef = useRef<Set<string>>(new Set());

  /** Build query string from scope filter. */
  const scopeParams = useCallback((filter?: QuickSortScopeFilter) => {
    const params = new URLSearchParams();
    if (filter?.source) params.set('source', filter.source);
    if (filter?.sourceList) params.set('sourceList', filter.sourceList);
    if (filter?.connectorId) params.set('connectorId', filter.connectorId);
    const str = params.toString();
    return str ? `&${str}` : '';
  }, []);

  const fetchQueue = useCallback(async (
    m: QuickSortQueueMode,
    options: { preserveDismissals?: boolean; background?: boolean } = {},
  ) => {
    const requestId = ++queueRequestId.current;
    const dismissedAtStart = new Set(doneIdsRef.current);
    if (!options.background) setLoading(true);
    try {
      const res = await fetch(`/api/tasks/quick-sort?mode=${m}&order=${order}${scopeParams(scopeFilter)}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      if (queueRequestId.current !== requestId) return;
      const fetched: QuickSortQueueTask[] = data.tasks ?? [];
      setTasks(fetched);
      if (!options.preserveDismissals) {
        setDoneIds((current) => {
          const next = new Set([...current].filter((id) => !dismissedAtStart.has(id)));
          doneIdsRef.current = next;
          return next;
        });
      }
      setHasMore(fetched.length >= 50);

      // Fetch suggestions for the first batch in the background
      if (fetched.length > 0 && m !== 'no_due_date') {
        const ids = fetched.slice(0, 20).map((t) => t.id).join(',');
        fetch(`/api/tasks/quick-sort/suggestions?taskIds=${ids}`)
          .then((r) => r.json())
          .then((d) => setSuggestions((prev) => ({ ...prev, ...(d.suggestions ?? {}) })))
          .catch(() => {});
      }
    } catch (error) {
      if (queueRequestId.current !== requestId) return;
      if (options.background) throw error;
      setTasks([]);
      setHasMore(false);
    } finally {
      if (!options.background && queueRequestId.current === requestId) setLoading(false);
    }
  }, [scopeParams, scopeFilter, order]);

  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/quick-sort?counts=true${scopeParams(scopeFilter)}`);
      if (!res.ok) return;
      const data = await res.json();
      setCounts(data.counts ?? null);
    } catch {
      // Silent
    }
  }, [scopeParams, scopeFilter]);

  useEffect(() => {
    void fetchCounts();
  }, [fetchCounts]);

  useEffect(() => {
    if (mode) {
      void fetchQueue(mode);
    }
  }, [mode, fetchQueue]);

  /** Mark a task as done/skipped so it disappears immediately from the visible queue. */
  const dismiss = useCallback((taskId: string) => {
    setDoneIds((prev) => {
      const next = new Set([...prev, taskId]);
      doneIdsRef.current = next;
      return next;
    });
  }, []);

  /** Update a task in state (optimistic). */
  const updateTask = useCallback((taskId: string, patch: Partial<QuickSortQueueTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
  }, []);

  /** Track recently applied tags for surfacing in the tag picker. */
  const recordRecentTag = useCallback((tagId: string) => {
    setRecentTagIds((prev) => {
      const filtered = prev.filter((id) => id !== tagId);
      return [tagId, ...filtered].slice(0, 10);
    });
  }, []);

  /** Refresh counts after an action. */
  const refreshCounts = useCallback(() => {
    void fetchCounts();
  }, [fetchCounts]);

  /** Revalidate queue membership and card context without restoring dismissed tasks. */
  const refreshQueue = useCallback(() => {
    return mode
      ? fetchQueue(mode, { preserveDismissals: true, background: true })
      : Promise.resolve();
  }, [fetchQueue, mode]);

  /** Reload the queue and clear client dismissals after server-side state expires. */
  const reloadQueue = useCallback(() => {
    return mode
      ? fetchQueue(mode, { background: true })
      : Promise.resolve();
  }, [fetchQueue, mode]);

  const visibleTasks = tasks.filter((t) => !doneIds.has(t.id));

  // Auto-fetch next batch when all visible tasks are dismissed
  useEffect(() => {
    if (mode && visibleTasks.length === 0 && doneIds.size > 0 && hasMore && !loading) {
      void fetchQueue(mode);
    }
  }, [mode, visibleTasks.length, doneIds.size, hasMore, loading, fetchQueue]);

  return {
    tasks: visibleTasks,
    loading,
    counts,
    suggestions,
    recentTagIds,
    dismiss,
    updateTask,
    refreshQueue,
    reloadQueue,
    refreshCounts,
    recordRecentTag,
  };
}
