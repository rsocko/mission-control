import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';

describe('useTaskSelection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects a different task immediately', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({ selectedTaskId: 'task-1', onSelectionChange })
    );

    act(() => result.current.handleTaskClick('task-2'));

    expect(onSelectionChange).toHaveBeenCalledWith('task-2');
  });

  it('delays deselection to preserve the double-click gesture', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({
        selectedTaskId: 'task-1',
        onSelectionChange,
        doubleClickDelay: 300,
      })
    );

    act(() => result.current.handleTaskClick('task-1'));
    expect(onSelectionChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it('cancels pending deselection when the task is double-clicked', () => {
    const onSelectionChange = vi.fn();
    const onDoubleClick = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({
        selectedTaskId: 'task-1',
        onSelectionChange,
        onDoubleClick,
        doubleClickDelay: 300,
      })
    );

    act(() => {
      result.current.handleTaskClick('task-1');
      result.current.handleTaskDoubleClick('task-1');
      vi.advanceTimersByTime(300);
    });

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onDoubleClick).toHaveBeenCalledWith('task-1');
  });

  it('keeps a newly selected task open when the initial gesture is a double-click', () => {
    const onSelectionChange = vi.fn();
    const onDoubleClick = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({
        selectedTaskId: null,
        onSelectionChange,
        onDoubleClick,
        doubleClickDelay: 300,
      })
    );

    act(() => {
      result.current.handleTaskClick('task-1');
      result.current.handleTaskClick('task-1');
      result.current.handleTaskDoubleClick('task-1');
      vi.advanceTimersByTime(300);
    });

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith('task-1');
    expect(onDoubleClick).toHaveBeenCalledWith('task-1');
  });

  it('toggles immediately in views without a double-click action', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({ selectedTaskId: 'task-1', onSelectionChange })
    );

    act(() => result.current.toggleTask('task-1'));

    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it('cancels a pending deselect when another selection surface toggles the task', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({ selectedTaskId: 'task-1', onSelectionChange })
    );

    act(() => {
      result.current.handleTaskClick('task-1');
      result.current.toggleTask('task-1');
      vi.advanceTimersByTime(300);
    });

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it('allows bulk and modifier gestures to cancel a pending deselect', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({ selectedTaskId: 'task-1', onSelectionChange })
    );

    act(() => {
      result.current.handleTaskClick('task-1');
      result.current.cancelPendingDeselect();
      vi.advanceTimersByTime(300);
    });

    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
