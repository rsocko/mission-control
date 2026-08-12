/**
 * React hook that bridges the background AI task manager to component state.
 *
 * - Subscribes to task events and re-renders when tasks change
 * - Shows Sonner toasts on task completion/failure
 * - Exposes `isAiActive` for tab/sidebar indicators
 */

'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import {
  onBackgroundAiTaskEvent,
  hasActiveBackgroundAiTasks,
  getActiveBackgroundAiTaskCount,
  getBackgroundAiTasks,
  type BackgroundAiTaskCategory,
  type BackgroundAiTaskEvent,
  type BackgroundAiTask,
} from './backgroundAiTaskManager';

// ── External store for useSyncExternalStore ──────────────────────────────────

let snapshotVersion = 0;
const storeListeners = new Set<() => void>();

function subscribeToStore(onStoreChange: () => void): () => void {
  storeListeners.add(onStoreChange);
  return () => storeListeners.delete(onStoreChange);
}

// Keep the listener installed once (module-level, not per-component)
let managerListenerInstalled = false;

function ensureManagerListener(): void {
  if (managerListenerInstalled) return;
  managerListenerInstalled = true;

  onBackgroundAiTaskEvent(() => {
    snapshotVersion++;
    for (const listener of storeListeners) {
      listener();
    }
  });
}

// ── Toast Notifications ─────────────────────────────────────────────────────

const TOAST_CATEGORY_LABELS: Record<BackgroundAiTaskCategory, string> = {
  chat: 'AI Chat',
  insight: 'AI Insight',
  'agent-dispatch': 'AI Agent',
  general: 'AI task',
};

let toastListenerInstalled = false;

function ensureToastListener(): void {
  if (toastListenerInstalled) return;
  toastListenerInstalled = true;

  onBackgroundAiTaskEvent((event: BackgroundAiTaskEvent) => {
    if (event.type === 'task-completed') {
      const categoryLabel = TOAST_CATEGORY_LABELS[event.task.category] ?? 'AI task';
      toast.success(`${categoryLabel} ready`, {
        description: event.task.label,
        duration: 4000,
      });
    } else if (event.type === 'task-failed') {
      const categoryLabel = TOAST_CATEGORY_LABELS[event.task.category] ?? 'AI task';
      toast.error(`${categoryLabel} failed`, {
        description: event.task.error ?? event.task.label,
        duration: 5000,
      });
    }
  });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

interface UseBackgroundAiTasksResult {
  /** True when any background AI tasks are running or pending. */
  isAiActive: boolean;
  /** Count of active (running + pending) tasks. */
  activeCount: number;
  /** True when any tasks in the given category are active. */
  isCategoryActive: (category: BackgroundAiTaskCategory) => boolean;
  /** Get all tasks matching a filter. */
  getTasks: (filter?: {
    category?: BackgroundAiTaskCategory;
    status?: BackgroundAiTask['status'] | BackgroundAiTask['status'][];
  }) => BackgroundAiTask[];
}

/**
 * Hook for components that need to react to background AI task state.
 *
 * Automatically installs a toast notification listener on first mount
 * so that completed/failed tasks always show a toast, even if the user
 * navigated away from the originating view.
 */
export function useBackgroundAiTasks(): UseBackgroundAiTasksResult {
  ensureManagerListener();
  ensureToastListener();

  const version = useSyncExternalStore(
    subscribeToStore,
    () => snapshotVersion,
    () => snapshotVersion,
  );

  // Force re-render when version changes (version is the snapshot itself)
  void version;

  const isAiActive = hasActiveBackgroundAiTasks();
  const activeCount = getActiveBackgroundAiTaskCount();

  const isCategoryActive = useCallback(
    (category: BackgroundAiTaskCategory) => hasActiveBackgroundAiTasks(category),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const getTasks = useCallback(
    (filter?: Parameters<typeof getBackgroundAiTasks>[0]) => getBackgroundAiTasks(filter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  return { isAiActive, activeCount, isCategoryActive, getTasks };
}

/**
 * Lightweight hook that only exposes `isAiActive` for a specific category.
 * Use on tab badges / sidebar indicators to avoid unnecessary renders.
 */
export function useBackgroundAiCategoryActive(category: BackgroundAiTaskCategory): boolean {
  ensureManagerListener();
  ensureToastListener();

  return useSyncExternalStore(
    subscribeToStore,
    () => hasActiveBackgroundAiTasks(category),
    () => false,
  );
}

/**
 * Install the toast listener eagerly at app startup.
 * Call this once in layout.tsx so toasts fire even before the user opens
 * the AI page.
 */
export function installBackgroundAiToastListener(): void {
  ensureManagerListener();
  ensureToastListener();
}
