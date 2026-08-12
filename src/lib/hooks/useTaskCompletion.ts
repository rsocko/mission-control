'use client';

import { useCallback, useSyncExternalStore } from 'react';

export const TASK_COMPLETION_FEEDBACK_MS = 600;

interface TaskCompletionOptions {
  optimisticUpdate: () => void;
  request: () => Promise<void>;
  rollback: () => void;
}

export type TaskCompletionOutcome = 'completed' | 'failed' | 'duplicate';

const inFlightIds = new Set<string>();
const listeners = new Set<() => void>();
const emptySnapshot = new Set<string>();
let completionSnapshot = emptySnapshot;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publishCompletionState() {
  completionSnapshot = new Set(inFlightIds);
  listeners.forEach((listener) => listener());
}

/**
 * Coordinates the shared completion sequence: show feedback, commit the
 * optimistic UI update, then persist it and roll back if persistence fails.
 * State is shared so separate task surfaces cannot submit the same completion.
 */
export function useTaskCompletion() {
  const completingIds = useSyncExternalStore(
    subscribe,
    () => completionSnapshot,
    () => emptySnapshot,
  );

  const runTaskCompletion = useCallback(async (
    taskId: string,
    { optimisticUpdate, request, rollback }: TaskCompletionOptions,
  ): Promise<TaskCompletionOutcome> => {
    if (inFlightIds.has(taskId)) return 'duplicate';

    inFlightIds.add(taskId);
    publishCompletionState();

    let optimisticUpdateApplied = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, TASK_COMPLETION_FEEDBACK_MS));
      optimisticUpdate();
      optimisticUpdateApplied = true;
      await request();
      return 'completed';
    } catch {
      if (optimisticUpdateApplied) rollback();
      return 'failed';
    } finally {
      inFlightIds.delete(taskId);
      publishCompletionState();
    }
  }, []);

  return { completingIds, runTaskCompletion };
}
