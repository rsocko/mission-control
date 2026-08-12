'use client';

/**
 * Optimistic UI mutation wrapper & React hook.
 *
 * Pattern:
 *  1. Apply an optimistic (local) update immediately (< 100ms)
 *  2. Execute the real server mutation in background
 *  3. On failure: rollback the optimistic update and show a toast
 *
 * Works for task completion, priority changes, triage decisions,
 * scheduling, task edits, and any other mutation surface.
 *
 * Refs: #1527, #1536
 */

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { queueAction } from '@/lib/offline-queue';

// ─── Core types ──────────────────────────────────────────────────────────────

export interface OptimisticMutationOptions<TInput, TResult> {
  /** Human-readable label shown in error toasts (e.g. "Update priority") */
  label?: string;

  /** Apply the optimistic (instant) UI update. Called synchronously. */
  optimisticUpdate: (input: TInput) => void;

  /** The actual server mutation. Receives the same input. */
  mutationFn: (input: TInput) => Promise<TResult>;

  /** Undo the optimistic update on failure. */
  rollback: (input: TInput) => void;

  /**
   * Called after a successful mutation with the server response.
   * Use to reconcile server state (e.g. replace optimistic ID with real ID).
   */
  onSuccess?: (result: TResult, input: TInput) => void;

  /** Called on failure after rollback. */
  onError?: (error: Error, input: TInput) => void;

  /**
   * Optional offline queue config. When provided and the device is offline,
   * the mutation is queued for later replay instead of failing immediately.
   */
  offlineQueue?: {
    /** Mutation type key used to route replays (e.g. "task.complete") */
    type: string;
    /** Serialize the input into a JSON-safe payload for IndexedDB storage */
    serialize: (input: TInput) => Record<string, unknown>;
  };
}

export interface OptimisticMutationState {
  /** Whether a mutation is currently in-flight */
  isPending: boolean;
  /** Whether the last mutation failed (resets on next call) */
  isError: boolean;
}

export interface UseOptimisticMutationReturn<TInput> extends OptimisticMutationState {
  /** Trigger the optimistic mutation */
  mutate: (input: TInput) => Promise<void>;
}

// ─── Standalone function (non-React) ─────────────────────────────────────────

/**
 * Execute an optimistic mutation outside of React.
 * Applies optimistic update → runs mutation → rollback on error.
 */
export async function optimisticMutate<TInput, TResult>(
  input: TInput,
  options: OptimisticMutationOptions<TInput, TResult>,
): Promise<TResult | undefined> {
  const { label, optimisticUpdate, mutationFn, rollback, onSuccess, onError, offlineQueue } = options;

  // Step 1: apply optimistic update immediately
  optimisticUpdate(input);

  // Step 2: if offline and queue config provided, queue for later
  if (typeof navigator !== 'undefined' && !navigator.onLine && offlineQueue) {
    try {
      await queueAction({
        type: offlineQueue.type,
        payload: offlineQueue.serialize(input),
      });
      return undefined;
    } catch {
      // Fall through to attempt the mutation (will likely fail but handles edge cases)
    }
  }

  // Step 3: execute real mutation
  try {
    const result = await mutationFn(input);
    onSuccess?.(result, input);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // Rollback optimistic update
    rollback(input);

    // Show error toast
    toast.error(label ? `${label} failed` : 'Action failed', {
      description: error.message,
    });

    onError?.(error, input);
    return undefined;
  }
}

// ─── React Hook ──────────────────────────────────────────────────────────────

/**
 * React hook for optimistic mutations with automatic rollback.
 *
 * @example
 * ```tsx
 * const { mutate, isPending } = useOptimisticMutation<string>({
 *   label: 'Complete task',
 *   optimisticUpdate: (id) => setTasks(prev => markDone(prev, id)),
 *   mutationFn: (id) => fetch(`/api/tasks/${id}`, { method: 'PATCH', body: ... }),
 *   rollback: (id) => setTasks(prev => markUndone(prev, id)),
 * });
 * ```
 */
export function useOptimisticMutation<TInput, TResult = unknown>(
  options: OptimisticMutationOptions<TInput, TResult>,
): UseOptimisticMutationReturn<TInput> {
  const [isPending, setIsPending] = useState(false);
  const [isError, setIsError] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mutate = useCallback(async (input: TInput) => {
    setIsPending(true);
    setIsError(false);

    const opts = optionsRef.current;

    // Apply optimistic update synchronously
    opts.optimisticUpdate(input);

    // If offline and queue config exists, queue it
    if (typeof navigator !== 'undefined' && !navigator.onLine && opts.offlineQueue) {
      try {
        await queueAction({
          type: opts.offlineQueue.type,
          payload: opts.offlineQueue.serialize(input),
        });
        setIsPending(false);
        return;
      } catch {
        // Fall through to attempt mutation
      }
    }

    try {
      const result = await opts.mutationFn(input);
      opts.onSuccess?.(result, input);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setIsError(true);
      opts.rollback(input);
      toast.error(opts.label ? `${opts.label} failed` : 'Action failed', {
        description: error.message,
      });
      opts.onError?.(error, input);
    } finally {
      setIsPending(false);
    }
  }, []);

  return { mutate, isPending, isError };
}
