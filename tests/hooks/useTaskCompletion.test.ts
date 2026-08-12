import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_COMPLETION_FEEDBACK_MS,
  useTaskCompletion,
  type TaskCompletionOutcome,
} from '@/lib/hooks/useTaskCompletion';

describe('useTaskCompletion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows feedback before applying and persisting the optimistic update', async () => {
    const optimisticUpdate = vi.fn();
    const request = vi.fn(async () => {});
    const rollback = vi.fn();
    const { result } = renderHook(() => useTaskCompletion());

    let completion!: Promise<TaskCompletionOutcome>;
    act(() => {
      completion = result.current.runTaskCompletion('task-1', {
        optimisticUpdate,
        request,
        rollback,
      });
    });

    expect(result.current.completingIds.has('task-1')).toBe(true);
    expect(optimisticUpdate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_COMPLETION_FEEDBACK_MS);
    });

    await expect(completion).resolves.toBe('completed');
    expect(optimisticUpdate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(result.current.completingIds.has('task-1')).toBe(false);
  });

  it('rolls back a failed persistence request', async () => {
    const rollback = vi.fn();
    const { result } = renderHook(() => useTaskCompletion());

    let completion!: Promise<TaskCompletionOutcome>;
    act(() => {
      completion = result.current.runTaskCompletion('task-1', {
        optimisticUpdate: vi.fn(),
        request: async () => {
          throw new Error('request failed');
        },
        rollback,
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_COMPLETION_FEEDBACK_MS);
    });

    await expect(completion).resolves.toBe('failed');
    expect(rollback).toHaveBeenCalledOnce();
    expect(result.current.completingIds.has('task-1')).toBe(false);
  });

  it('deduplicates requests across hook instances while sharing visual state', async () => {
    const request = vi.fn(async () => {});
    const options = {
      optimisticUpdate: vi.fn(),
      request,
      rollback: vi.fn(),
    };
    const firstHook = renderHook(() => useTaskCompletion());
    const secondHook = renderHook(() => useTaskCompletion());

    let first!: Promise<TaskCompletionOutcome>;
    let duplicate!: Promise<TaskCompletionOutcome>;
    act(() => {
      first = firstHook.result.current.runTaskCompletion('task-1', options);
      duplicate = secondHook.result.current.runTaskCompletion('task-1', options);
    });

    expect(firstHook.result.current.completingIds.has('task-1')).toBe(true);
    expect(secondHook.result.current.completingIds.has('task-1')).toBe(true);
    await expect(duplicate).resolves.toBe('duplicate');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_COMPLETION_FEEDBACK_MS);
    });
    await expect(first).resolves.toBe('completed');
    expect(request).toHaveBeenCalledOnce();
  });
});
