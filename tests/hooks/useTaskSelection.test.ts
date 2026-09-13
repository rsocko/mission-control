import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTaskSelection } from '@/lib/hooks/useTaskSelection';

describe('useTaskSelection', () => {
  it('selects a different task immediately', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({ selectedTaskId: 'task-1', onSelectionChange })
    );

    act(() => result.current.handleTaskClick('task-2'));

    expect(onSelectionChange).toHaveBeenCalledWith('task-2');
  });

  it('keeps the selected task open when it is clicked again', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({
        selectedTaskId: 'task-1',
        onSelectionChange,
      })
    );

    act(() => result.current.handleTaskClick('task-1'));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('keeps the selected task open when it is double-clicked', () => {
    const onSelectionChange = vi.fn();
    const onDoubleClick = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({
        selectedTaskId: 'task-1',
        onSelectionChange,
        onDoubleClick,
      })
    );

    act(() => result.current.handleTaskDoubleClick('task-1'));

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
      })
    );

    act(() => {
      result.current.handleTaskClick('task-1');
      result.current.handleTaskClick('task-1');
      result.current.handleTaskDoubleClick('task-1');
    });

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith('task-1');
    expect(onDoubleClick).toHaveBeenCalledWith('task-1');
  });

  it('keeps the selected task open in views without a double-click action', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({ selectedTaskId: 'task-1', onSelectionChange })
    );

    act(() => result.current.selectTask('task-1'));

    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('selects a task from views without a double-click action', () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() =>
      useTaskSelection({ selectedTaskId: null, onSelectionChange })
    );

    act(() => result.current.selectTask('task-1'));

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith('task-1');
  });
});
