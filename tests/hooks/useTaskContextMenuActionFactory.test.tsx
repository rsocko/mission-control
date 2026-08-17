import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTaskContextMenuActionFactory } from '@/lib/hooks/useTaskContextMenuActionFactory';

describe('useTaskContextMenuActionFactory', () => {
  it('returns a stable per-task action object while using current handlers', () => {
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const handlers = {
      complete: firstComplete,
      setPriority: vi.fn(),
      setStatus: vi.fn(),
      removeFromMyDay: vi.fn(),
      setDueDate: vi.fn(),
      setLocalDisposition: vi.fn(),
      moveToList: vi.fn(),
      addToProject: vi.fn(),
      deleteTask: vi.fn(),
      saveAsTemplate: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ complete }) => useTaskContextMenuActionFactory({ ...handlers, complete }),
      { initialProps: { complete: firstComplete } },
    );
    const task = { id: 'task-1', title: 'Task', dueDate: null, metadata: null };
    const firstActions = result.current(task);

    rerender({ complete: secondComplete });
    const secondActions = result.current(task);
    secondActions.onComplete?.();

    expect(secondActions).toBe(firstActions);
    expect(firstComplete).not.toHaveBeenCalled();
    expect(secondComplete).toHaveBeenCalledWith('task-1');
  });

  it('exposes the correct My Day action for the task scope', () => {
    const addToMyDay = vi.fn();
    const removeFromMyDay = vi.fn();
    const { result } = renderHook(() => useTaskContextMenuActionFactory({
      complete: vi.fn(),
      addToMyDay,
      setPriority: vi.fn(),
      setStatus: vi.fn(),
      removeFromMyDay,
      setDueDate: vi.fn(),
      setLocalDisposition: vi.fn(),
      moveToList: vi.fn(),
      addToProject: vi.fn(),
      deleteTask: vi.fn(),
      saveAsTemplate: vi.fn(),
    }));

    const inMyDay = result.current({ id: 'task-1', title: 'Task', isInMyDay: true });
    const outsideMyDay = result.current({ id: 'task-2', title: 'Task', isInMyDay: false });
    inMyDay.onRemoveFromMyDay?.();
    outsideMyDay.onAddToMyDay?.();

    expect(removeFromMyDay).toHaveBeenCalledWith('task-1');
    expect(addToMyDay).toHaveBeenCalledWith('task-2');
  });
});
