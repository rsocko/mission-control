'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
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
  /** Per-connector progress for every sync currently in flight. */
  activeProgresses: SyncProgress[];
  /** Connector sync requests accepted by the client but not started yet. */
  queuedConnectorIds: string[];
  /** Trigger an incremental sync, optionally scoped to one connector. */
  triggerSync: (connectorId?: string) => void;
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
  activeProgresses: [],
  queuedConnectorIds: [],
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
  const [activeProgresses, setActiveProgresses] = useState<SyncProgress[]>([]);
  const [queuedConnectorIds, setQueuedConnectorIds] = useState<string[]>([]);
  const activeProgressesRef = useRef<Record<string, SyncProgress>>({});
  const pendingManualSyncsRef = useRef(new Set<string>());
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

  // Connector names are retained for terminal events that can arrive out of order.
  const connectorNamesRef = useRef<Record<string, string>>({});

  // Throttle state: accumulate intermediate updates in a ref, flush periodically
  const pendingProgressRef = useRef<Record<string, Partial<SyncProgress>>>({});
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef<number>(0);

  const flushPendingProgress = useCallback(() => {
    const pending = pendingProgressRef.current;
    if (Object.keys(pending).length === 0) return;
    pendingProgressRef.current = {};
    throttleTimerRef.current = null;
    lastFlushRef.current = Date.now();
    const next = { ...activeProgressesRef.current };
    for (const [connectorId, update] of Object.entries(pending)) {
      if (next[connectorId]) {
        next[connectorId] = { ...next[connectorId], ...update };
      }
    }
    activeProgressesRef.current = next;
    setActiveProgresses(Object.values(next));
    setProgress((prev) => {
      const update = prev.connectorId ? pending[prev.connectorId] : undefined;
      return update ? { ...prev, ...update } : prev;
    });
  }, []);

  /**
   * Schedule a throttled progress update.  If enough time has elapsed since
   * the last flush, apply immediately; otherwise queue for later.
   */
  const throttledSetProgress = useCallback((
    connectorId: string,
    update: Partial<SyncProgress>,
  ) => {
    pendingProgressRef.current = {
      ...pendingProgressRef.current,
      [connectorId]: {
        ...pendingProgressRef.current[connectorId],
        ...update,
      },
    };

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
      if (!isSyncing) {
        activeProgressesRef.current = {};
        setActiveProgresses([]);
      }
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
      flushPendingProgress();
      connectorNamesRef.current[data.connectorId] = data.connectorName;
      knownSyncingRef.current = true;
      const connectorProgress: SyncProgress = {
        ...(data.phase === 'tasks'
          ? activeProgressesRef.current[data.connectorId] ?? initialProgress
          : initialProgress),
        isSyncing: true,
        connectorId: data.connectorId,
        connectorName: data.connectorName,
        phase: data.phase,
      };
      activeProgressesRef.current = {
        ...activeProgressesRef.current,
        [data.connectorId]: connectorProgress,
      };
      setQueuedConnectorIds((previous) => (
        previous.filter((connectorId) => connectorId !== data.connectorId)
      ));
      setActiveProgresses(Object.values(activeProgressesRef.current));
      setProgress((prev) => ({
        ...connectorProgress,
        refetchKey: prev.refetchKey,
      }));
    };

    // Intermediate events — throttled
    const handleListsDiscovered = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncListsDiscoveredEvent;
      throttledSetProgress(data.connectorId, {
        listsFound: data.listCount,
        totalLists: data.listCount,
      });
      if (Date.now() < toastSuppressedUntilRef.current) return;
      const connectorName = connectorNamesRef.current[data.connectorId];
      const connectorIcon = connectorToastIcon(data.connectorId);
      const label = connectorName
        ? createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            `Found ${data.listCount} lists from `, connectorIcon, connectorName,
          )
        : `Found ${data.listCount} lists`;
      toast(label, { duration: 3000 });
    };

    const handleListProgress = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncListProgressEvent;
      throttledSetProgress(data.connectorId, {
        currentList: data.listName,
        listIndex: data.listIndex,
        totalLists: data.totalLists,
      });
    };

    const handleTasksBatch = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as SyncTasksBatchEvent;
      throttledSetProgress(data.connectorId, {
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
      flushPendingProgress();
      const nextActive = { ...activeProgressesRef.current };
      delete nextActive[data.connectorId];
      activeProgressesRef.current = data.queueRemaining > 0 ? nextActive : {};
      setActiveProgresses(Object.values(activeProgressesRef.current));

      // If more syncs are still queued/running, keep isSyncing=true and defer
      // the refetchKey increment to avoid cascading refetch storms.
      if (data.queueRemaining > 0) {
        knownSyncingRef.current = true;
        const replacement = Object.values(nextActive).at(-1);
        setProgress((prev) => ({
          ...(replacement ?? initialProgress),
          isSyncing: true,
          refetchKey: prev.refetchKey,
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

      const connectorName = connectorNamesRef.current[data.connectorId];
      const connectorIcon = connectorToastIcon(data.connectorId);
      const sourceLabel = connectorName
        ? createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            connectorIcon,
            connectorName,
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
      flushPendingProgress();
      const nextActive = { ...activeProgressesRef.current };
      delete nextActive[data.connectorId];
      activeProgressesRef.current = data.queueRemaining > 0 ? nextActive : {};
      setActiveProgresses(Object.values(activeProgressesRef.current));

      // If more syncs are still queued/running, stay in syncing state
      if (data.queueRemaining > 0) {
        knownSyncingRef.current = true;
        const replacement = Object.values(nextActive).at(-1);
        setProgress((prev) => ({
          ...(replacement ?? initialProgress),
          isSyncing: true,
          refetchKey: prev.refetchKey,
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
      const connectorName = connectorNamesRef.current[data.connectorId];
      const connectorIcon = connectorToastIcon(data.connectorId);
      const release = data.runtimeRelease ?? 'unreported';
      const errorMsg = connectorName
        ? createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' as const } },
            'Sync failed (', connectorIcon, `${connectorName}): ${data.error} [runtime ${release}]`,
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
  }, [
    flushPendingProgress,
    refreshActiveQueries,
    startFallbackPolling,
    stopFallbackPolling,
    throttledSetProgress,
  ]);

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

  const triggerSync = useCallback(async (connectorId?: string) => {
    const requestKey = connectorId ?? '__all__';
    const joiningExistingSync = knownSyncingRef.current;
    if (
      pendingManualSyncsRef.current.has(requestKey)
      || (connectorId && activeProgressesRef.current[connectorId])
      || (!connectorId && joiningExistingSync)
    ) {
      return;
    }

    pendingManualSyncsRef.current.add(requestKey);
    if (connectorId && joiningExistingSync) {
      setQueuedConnectorIds((previous) => (
        previous.includes(connectorId) ? previous : [...previous, connectorId]
      ));
    } else {
      // Immediately show syncing state so banner + bottom-left react instantly.
      setProgress((prev) => ({
        ...prev,
        isSyncing: true,
        phase: null,
        connectorId: connectorId ?? null,
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
    }

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connectorId ? { connectorId } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast.error(`Sync failed: ${data.error || res.statusText}`);
        if (!joiningExistingSync) {
          knownSyncingRef.current = false;
          setProgress((prev) => ({ ...initialProgress, refetchKey: prev.refetchKey }));
        }
        return;
      }
      const data = await res.json().catch(() => ({ results: [] }));
      const results = data.results ?? [];
      if (results.length === 0) {
        toast('No sources configured — add a connector in Settings to sync tasks', {
          duration: 4000,
        });
        if (!joiningExistingSync) {
          knownSyncingRef.current = false;
          setProgress((prev) => ({ ...initialProgress, refetchKey: prev.refetchKey }));
        }
        return;
      }
      // SSE stream handles per-connector progress and the final toast via
      // sync:complete, so we just dispatch the refresh event here.
      window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));
    } catch {
      toast.error('Sync request failed — check your connection');
      if (!joiningExistingSync) {
        knownSyncingRef.current = false;
        setProgress((prev) => ({ ...initialProgress, refetchKey: prev.refetchKey }));
      }
    } finally {
      pendingManualSyncsRef.current.delete(requestKey);
      if (connectorId) {
        setQueuedConnectorIds((previous) => (
          previous.filter((queuedConnectorId) => queuedConnectorId !== connectorId)
        ));
      }
    }
    // Note: isSyncing is reset by the SSE sync:complete / sync:error handler,
    // not here — the POST resolving doesn't mean the SSE stream is done.
  }, []);

  const contextValue = useMemo<SyncStreamContextValue>(
    () => ({ progress, activeProgresses, queuedConnectorIds, triggerSync }),
    [activeProgresses, progress, queuedConnectorIds, triggerSync],
  );

  return contextValue;
}
