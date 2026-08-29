'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  SyncListsDiscoveredEvent,
  SyncListProgressEvent,
  SyncTasksBatchEvent,
  SyncCompleteEvent,
  SyncErrorEvent,
  SyncStartEvent,
} from '@/lib/sync/events';
import { CONNECTOR_ICONS } from '@/types/dashboard';

/** Build a toast icon element for the given connector type */
function connectorToastIcon(connectorId: string | null) {
  const src = connectorId ? CONNECTOR_ICONS[connectorId] : undefined;
  if (!src) return undefined;
  return createElement('img', { src, alt: '', width: 16, height: 16, style: { borderRadius: 3 } });
}

export interface SyncProgress {
  isSyncing: boolean;
  connectorId: string | null;
  connectorName: string | null;
  phase: 'push' | 'lists' | 'tasks' | null;
  currentList: string | null;
  listIndex: number;
  totalLists: number;
  totalTasks: number;
  /** Number of parent tasks (non-checklist items) synced so far */
  parentTasks: number;
  /** Number of checklist/sub-task items synced so far */
  subtasks: number;
  listsFound: number;
  byStatus: { todo: number; done: number };
  /** Increments on each tasks-batch or complete event — pages can use as a refetch trigger */
  refetchKey: number;
}

export interface SyncStreamContextValue {
  progress: SyncProgress;
  /** Trigger a full sync — sets isSyncing immediately so all consumers react */
  triggerSync: () => void;
}

const initialProgress: SyncProgress = {
  isSyncing: false,
  connectorId: null,
  connectorName: null,
  phase: null,
  currentList: null,
  listIndex: 0,
  totalLists: 0,
  totalTasks: 0,
  parentTasks: 0,
  subtasks: 0,
  listsFound: 0,
  byStatus: { todo: 0, done: 0 },
  refetchKey: 0,
};

const SyncStreamContext = createContext<SyncStreamContextValue>({
  progress: initialProgress,
  triggerSync: () => {},
});

export function useSyncStream() {
  return useContext(SyncStreamContext);
}

export { SyncStreamContext, initialProgress };

/** Minimum interval (ms) between intermediate progress re-renders */
const PROGRESS_THROTTLE_MS = 300;
const SYNC_FALLBACK_POLL_MS = 30_000;
const SYNC_RECONNECT_BASE_MS = 3_000;
const SYNC_RECONNECT_MAX_MS = 30_000;

/**
 * Hook that manages the actual EventSource connection.
 * Used once at the provider level.
 *
 * Intermediate progress updates (list-progress, tasks-batch, lists-discovered)
 * are throttled so the SyncStreamContext value only changes at most every
 * PROGRESS_THROTTLE_MS.  This prevents render storms that freeze the UI when
 * many SSE events arrive in rapid succession during sync.
 *
 * Critical state transitions (start, complete, error) are always applied
 * immediately so the banner appears/disappears without delay and refetchKey
 * increments promptly.
 */
export function useSyncStreamConnection() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<SyncProgress>(initialProgress);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const stoppedRef = useRef(false);
  const fallbackSawSyncRef = useRef(false);
  const fallbackGenerationRef = useRef(0);
  const fallbackRefreshedRef = useRef(false);
  const streamFailedRef = useRef(false);
  const streamConnectedRef = useRef(false);
  const knownSyncingRef = useRef(false);

  // Track current connector for toast messages (set by sync:start, used by subsequent events)
  const currentConnectorRef = useRef<{ id: string; name: string } | null>(null);

  // Throttle state: accumulate intermediate updates in a ref, flush periodically
  const pendingProgressRef = useRef<Partial<SyncProgress> | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef<number>(0);

  const flushPendingProgress = useCallback(() => {
    const pending = pendingProgressRef.current;
    if (!pending) return;
    pendingProgressRef.current = null;
    throttleTimerRef.current = null;
    lastFlushRef.current = Date.now();
    setProgress((prev) => ({ ...prev, ...pending }));
  }, []);

  /**
   * Schedule a throttled progress update.  If enough time has elapsed since
   * the last flush, apply immediately; otherwise queue for later.
   */
  const throttledSetProgress = useCallback((update: Partial<SyncProgress>) => {
    // Merge into pending
    pendingProgressRef.current = pendingProgressRef.current
      ? { ...pendingProgressRef.current, ...update }
      : update;

    // If we can flush now, do it
    const elapsed = Date.now() - lastFlushRef.current;
    if (elapsed >= PROGRESS_THROTTLE_MS) {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      flushPendingProgress();
    } else if (!throttleTimerRef.current) {
      // Schedule a flush for when the throttle window expires
      throttleTimerRef.current = setTimeout(flushPendingProgress, PROGRESS_THROTTLE_MS - elapsed);
    }
  }, [flushPendingProgress]);

  // Grace period: suppress toasts for first 2s after connection to avoid
  // flooding the user with stale events on hard reload (Ctrl+Shift+R).
  const toastSuppressedUntilRef = useRef<number>(0);
  const hiddenSyncResultsRef = useRef({ completed: 0, failed: 0 });

  useEffect(() => {
    const showHiddenSyncSummary = () => {
      if (document.visibilityState !== 'visible') return;
      const { completed, failed } = hiddenSyncResultsRef.current;
      if (completed === 0 && failed === 0) return;

      hiddenSyncResultsRef.current = { completed: 0, failed: 0 };
      const parts = [
        completed > 0 ? `${completed} sync${completed === 1 ? '' : 's'} completed` : null,
        failed > 0 ? `${failed} failed` : null,
      ].filter((part): part is string => part !== null);
      toast(`While you were away: ${parts.join(', ')}. See Sync History for details.`, {
        duration: 5000,
      });
    };

    document.addEventListener('visibilitychange', showHiddenSyncSummary);
    return () => document.removeEventListener('visibilitychange', showHiddenSyncSummary);
  }, []);

  const refreshActiveQueries = useCallback(async () => {
    // An initial query fetch cannot be invalidated into a second request while
    // it is still in flight. Cancel first so pre-sync responses cannot win.
    await queryClient.cancelQueries({ type: 'active' }, { silent: true });
    await queryClient.invalidateQueries({ refetchType: 'active' });
  }, [queryClient]);

  const pollSyncStatus = useCallback(async (generation: number) => {
    try {
      const response = await fetch('/api/sync');
      if (!response.ok) return;
      const data = await response.json() as { isSyncing?: boolean };
      if (stoppedRef.current || generation !== fallbackGenerationRef.current) return;
      const isSyncing = data.isSyncing === true;
      const completedWhileDisconnected = fallbackSawSyncRef.current && !isSyncing;
      fallbackSawSyncRef.current = isSyncing;
      setProgress((previous) => ({
        ...previous,
        isSyncing,
        ...(completedWhileDisconnected ? { refetchKey: previous.refetchKey + 1 } : {}),
      }));
      if (completedWhileDisconnected) {
        fallbackRefreshedRef.current = true;
        void refreshActiveQueries();
        window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
      }
      if (streamConnectedRef.current && fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
        fallbackSawSyncRef.current = false;
        fallbackRefreshedRef.current = false;
      }
    } catch {
      // The next low-frequency fallback tick or SSE reconnect will retry.
    }
  }, [refreshActiveQueries]);

  const stopFallbackPolling = useCallback(() => {
    fallbackGenerationRef.current += 1;
    if (fallbackPollRef.current) {
      clearInterval(fallbackPollRef.current);
      fallbackPollRef.current = null;
    }
    fallbackSawSyncRef.current = false;
  }, []);

  const startFallbackPolling = useCallback(() => {
    if (fallbackPollRef.current || stoppedRef.current) return;
    const generation = ++fallbackGenerationRef.current;
    void pollSyncStatus(generation);
    fallbackPollRef.current = setInterval(() => {
      void pollSyncStatus(generation);
    }, SYNC_FALLBACK_POLL_MS);
  }, [pollSyncStatus]);

  const connect = useCallback(() => {
    if (stoppedRef.current) return;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource('/api/sync/stream');
    eventSourceRef.current = es;
    toastSuppressedUntilRef.current = Date.now() + 2000;
    es.onopen = () => {
      if (eventSourceRef.current !== es) return;
      streamConnectedRef.current = true;
      reconnectAttemptRef.current = 0;
      const recovering = streamFailedRef.current;
      stopFallbackPolling();
      if (streamFailedRef.current && !fallbackRefreshedRef.current) {
        fallbackRefreshedRef.current = true;
        setProgress((previous) => ({
          ...previous,
          refetchKey: previous.refetchKey + 1,
        }));
        void refreshActiveQueries();
        window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
      }
      streamFailedRef.current = false;
      if (recovering) startFallbackPolling();
    };

    // Critical events — always applied immediately
    const handleStart = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncStartEvent;
      // Flush any pending throttled update before applying start
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      pendingProgressRef.current = null;
      currentConnectorRef.current = { id: data.connectorId, name: data.connectorName };
      knownSyncingRef.current = true;
      setProgress((prev) => ({
        ...prev,
        isSyncing: true,
        connectorId: data.connectorId,
        connectorName: data.connectorName,
        phase: data.phase,
        ...(data.phase === 'push'
          ? { currentList: null, listIndex: 0, totalLists: 0, totalTasks: 0, parentTasks: 0, subtasks: 0, listsFound: 0, byStatus: { todo: 0, done: 0 } }
          : data.phase === 'lists'
          ? { currentList: null, listIndex: 0, totalLists: 0, totalTasks: 0, parentTasks: 0, subtasks: 0, listsFound: 0, byStatus: { todo: 0, done: 0 } }
          : {}),
      }));
    };

    // Intermediate events — throttled
    const handleListsDiscovered = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncListsDiscoveredEvent;
      throttledSetProgress({
        listsFound: data.listCount,
        totalLists: data.listCount,
      });
      if (Date.now() < toastSuppressedUntilRef.current) return;
      const c = currentConnectorRef.current;
      const connectorIcon = connectorToastIcon(c?.id ?? data.connectorId);
      const label = c
        ? createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            `Found ${data.listCount} lists from `, connectorIcon, c.name,
          )
        : `Found ${data.listCount} lists`;
      toast(label, { duration: 3000 });
    };

    const handleListProgress = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncListProgressEvent;
      throttledSetProgress({
        currentList: data.listName,
        listIndex: data.listIndex,
        totalLists: data.totalLists,
      });
    };

    const handleTasksBatch = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncTasksBatchEvent;
      throttledSetProgress({
        totalTasks: data.totalSoFar,
        parentTasks: data.parentTasks,
        subtasks: data.subtasks,
        byStatus: data.byStatus,
      });
    };

    // Critical events — always applied immediately
    const handleComplete = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncCompleteEvent;
      const r = data.result;
      // Flush any pending throttled update before resetting
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      pendingProgressRef.current = null;

      // If more syncs are still queued/running, keep isSyncing=true and defer
      // the refetchKey increment to avoid cascading refetch storms.
      if (data.queueRemaining > 0) {
        knownSyncingRef.current = true;
        setProgress((prev) => ({
          ...prev,
          // Reset phase-level details but stay in syncing state
          phase: null,
          currentList: null,
          listIndex: 0,
          totalLists: 0,
          totalTasks: 0,
          parentTasks: 0,
          subtasks: 0,
          listsFound: 0,
          byStatus: { todo: 0, done: 0 },
        }));
      } else {
        knownSyncingRef.current = false;
        // All syncs done — reset and trigger refetch
        setProgress((prev) => ({
          ...initialProgress,
          refetchKey: prev.refetchKey + 1,
        }));
        // Query-backed screens retain their cached data while active queries
        // refetch in the background. Legacy screens still use refetchKey.
        void refreshActiveQueries();
        window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
      }

      if (document.visibilityState !== 'visible') {
        hiddenSyncResultsRef.current.completed += 1;
        return;
      }

      // Suppress toasts during the post-reload grace period
      if (Date.now() < toastSuppressedUntilRef.current) return;

      // Build a meaningful summary distinguishing parent tasks from sub-items
      const parts: string[] = [];
      if (r.tasksAdded > 0) {
        if (r.parentTasksAdded && r.subtasksAdded) {
          parts.push(`${r.parentTasksAdded} added + ${r.subtasksAdded} sub-items`);
        } else if (r.parentTasksAdded) {
          parts.push(`${r.parentTasksAdded} added`);
        } else {
          parts.push(`${r.tasksAdded} added`);
        }
      }
      if (r.tasksUpdated > 0) parts.push(`${r.tasksUpdated} updated`);
      if (r.tasksRemoved > 0) parts.push(`${r.tasksRemoved} removed`);
      if (r.tasksPushed > 0) parts.push(`${r.tasksPushed} pushed`);
      if (r.localOnlyProtected > 0) parts.push(`${r.localOnlyProtected} local-only preserved`);
      if (r.notificationsAdded > 0) parts.push(`${r.notificationsAdded} notifications added`);

      const summary = parts.length > 0
        ? parts.join(', ')
        : 'everything up to date';

      const c = currentConnectorRef.current;
      const connectorIcon = connectorToastIcon(c?.id ?? data.connectorId);
      const sourceLabel = c
        ? createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            connectorIcon,
            c.name,
          )
        : null;
      toast.success(
        createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' as const } },
          '✅ Sync complete',
          sourceLabel && createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, '(', sourceLabel, ')'),
          ` — ${summary} (${r.totalLists} lists)`,
        ),
        { duration: 5000 },
      );
    };

    const handleError = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncErrorEvent;
      // Flush any pending throttled update before resetting
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      pendingProgressRef.current = null;

      // If more syncs are still queued/running, stay in syncing state
      if (data.queueRemaining > 0) {
        knownSyncingRef.current = true;
        setProgress((prev) => ({
          ...prev,
          phase: null,
          currentList: null,
          listIndex: 0,
          totalLists: 0,
          totalTasks: 0,
          parentTasks: 0,
          subtasks: 0,
          listsFound: 0,
          byStatus: { todo: 0, done: 0 },
        }));
      } else {
        knownSyncingRef.current = false;
        setProgress((prev) => ({ ...initialProgress, refetchKey: prev.refetchKey }));
        window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
      }

      if (document.visibilityState !== 'visible') {
        hiddenSyncResultsRef.current.failed += 1;
        return;
      }

      // Suppress toasts during the post-reload grace period
      if (Date.now() < toastSuppressedUntilRef.current) return;
      const c = currentConnectorRef.current;
      const connectorIcon = connectorToastIcon(c?.id ?? data.connectorId);
      const release = data.runtimeRelease ?? 'unreported';
      const errorMsg = c
        ? createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' as const } },
            'Sync failed (', connectorIcon, `${c.name}): ${data.error} [runtime ${release}]`,
          )
        : `Sync failed: ${data.error} [runtime ${release}]`;
      toast.error(errorMsg, { duration: 5000 });
    };

    es.addEventListener('sync:start', handleStart);
    es.addEventListener('sync:lists-discovered', handleListsDiscovered);
    es.addEventListener('sync:list-progress', handleListProgress);
    es.addEventListener('sync:tasks-batch', handleTasksBatch);
    es.addEventListener('sync:complete', handleComplete);
    es.addEventListener('sync:error', handleError);

    es.onerror = () => {
      if (eventSourceRef.current !== es) return;
      es.close();
      eventSourceRef.current = null;
      streamConnectedRef.current = false;
      streamFailedRef.current = true;
      fallbackSawSyncRef.current = knownSyncingRef.current;
      startFallbackPolling();
      if (reconnectTimeoutRef.current || stoppedRef.current) return;
      const delay = Math.min(
        SYNC_RECONNECT_BASE_MS * (2 ** reconnectAttemptRef.current),
        SYNC_RECONNECT_MAX_MS,
      );
      reconnectAttemptRef.current += 1;
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    };
  }, [refreshActiveQueries, startFallbackPolling, stopFallbackPolling, throttledSetProgress]);

  useEffect(() => {
    stoppedRef.current = false;
    connect();
    return () => {
      stoppedRef.current = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
      stopFallbackPolling();
    };
  }, [connect, stopFallbackPolling]);

  const triggerSync = useCallback(async () => {
    if (progress.isSyncing) return;
    // Immediately show syncing state so banner + bottom-left react instantly
    setProgress((prev) => ({
      ...prev,
      isSyncing: true,
      phase: null,
      connectorId: null,
      connectorName: null,
      currentList: null,
      listIndex: 0,
      totalLists: 0,
      totalTasks: 0,
      parentTasks: 0,
      subtasks: 0,
      listsFound: 0,
      byStatus: { todo: 0, done: 0 },
    }));
    knownSyncingRef.current = true;
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast.error(`Sync failed: ${data.error || res.statusText}`);
        knownSyncingRef.current = false;
        setProgress((prev) => ({ ...initialProgress, refetchKey: prev.refetchKey }));
        return;
      }
      const data = await res.json().catch(() => ({ results: [] }));
      const results = data.results ?? [];
      if (results.length === 0) {
        toast('No sources configured — add a connector in Settings to sync tasks', {
          duration: 4000,
        });
        knownSyncingRef.current = false;
        setProgress((prev) => ({ ...initialProgress, refetchKey: prev.refetchKey }));
        return;
      }
      // SSE stream handles per-connector progress and the final toast via
      // sync:complete, so we just dispatch the refresh event here.
      window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
    } catch {
      toast.error('Sync request failed — check your connection');
      knownSyncingRef.current = false;
      setProgress((prev) => ({ ...initialProgress, refetchKey: prev.refetchKey }));
    }
    // Note: isSyncing is reset by the SSE sync:complete / sync:error handler,
    // not here — the POST resolving doesn't mean the SSE stream is done.
  }, [progress.isSyncing]);

  const contextValue = useMemo<SyncStreamContextValue>(
    () => ({ progress, triggerSync }),
    [progress, triggerSync],
  );

  return contextValue;
}
