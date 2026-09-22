import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTaskRowInteractionHandlers } from '@/lib/tasks/task-row-interactions';

function TestRow({
  bulkMode = false,
  onBeforeClick = vi.fn(),
  onSelect = vi.fn(),
  onDoubleClick = vi.fn(),
  onModifierClick = vi.fn(),
  onBulkClick = vi.fn(),
  onParentDoubleClick = vi.fn(),
}: {
  bulkMode?: boolean;
  onBeforeClick?: () => void;
  onSelect?: (taskId: string) => void;
  onDoubleClick?: (taskId: string) => void;
  onModifierClick?: (taskId: string) => void;
  onBulkClick?: () => void;
  onParentDoubleClick?: () => void;
}) {
  return (
    <div onDoubleClick={onParentDoubleClick}>
      <div
        data-testid="task-row"
        {...createTaskRowInteractionHandlers({
          taskId: 'task-1',
          bulkMode,
          onBeforeClick,
          onSelect,
          onDoubleClick,
          onModifierClick,
          onBulkClick,
        })}
      />
    </div>
  );
}

describe('createTaskRowInteractionHandlers', () => {
  it('selects on a plain click after clearing pending interaction state', () => {
    const onBeforeClick = vi.fn();
    const onSelect = vi.fn();
    render(<TestRow onBeforeClick={onBeforeClick} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('task-row'));

    expect(onBeforeClick).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('task-1');
  });

  it('routes modifier clicks without selecting the task', () => {
    const onSelect = vi.fn();
    const onModifierClick = vi.fn();
    render(<TestRow onSelect={onSelect} onModifierClick={onModifierClick} />);

    fireEvent.click(screen.getByTestId('task-row'), { shiftKey: true });

    expect(onModifierClick).toHaveBeenCalledWith('task-1', expect.objectContaining({ shiftKey: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('toggles bulk selection and suppresses double-click opening in bulk mode', () => {
    const onSelect = vi.fn();
    const onDoubleClick = vi.fn();
    const onBulkClick = vi.fn();
    render(
      <TestRow
        bulkMode
        onSelect={onSelect}
        onDoubleClick={onDoubleClick}
        onBulkClick={onBulkClick}
      />,
    );

    fireEvent.click(screen.getByTestId('task-row'));
    fireEvent.doubleClick(screen.getByTestId('task-row'));

    expect(onBulkClick).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('opens on double-click without bubbling to a parent row surface', () => {
    const onDoubleClick = vi.fn();
    const onParentDoubleClick = vi.fn();
    render(
      <TestRow
        onDoubleClick={onDoubleClick}
        onParentDoubleClick={onParentDoubleClick}
      />,
    );

    fireEvent.doubleClick(screen.getByTestId('task-row'));

    expect(onDoubleClick).toHaveBeenCalledWith('task-1');
    expect(onParentDoubleClick).not.toHaveBeenCalled();
  });
});
