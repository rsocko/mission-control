import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SuggestedForToday } from '@/components/today/SuggestedForToday';
import type { TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type { SuggestionTask } from '@/components/today/types';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const task: SuggestionTask = {
  id: 'task-1',
  title: 'Suggested task',
  status: 'todo',
  priority: 'high',
  dueDate: '2026-08-04',
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceId: 'source-task-1',
  sourceListName: 'Inbox',
  metadata: null,
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

describe('SuggestedForToday task interactions', () => {
  it('marks the task complete without opening details', () => {
    const onComplete = vi.fn();
    const onSelect = vi.fn();

    render(
      <TooltipProvider>
        <SuggestedForToday
          tasks={[task]}
          onAdd={vi.fn()}
          onNotToday={vi.fn()}
          onComplete={onComplete}
          onSelect={onSelect}
          completingIds={new Set()}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Suggested task" complete' }));

    expect(onComplete).toHaveBeenCalledWith(task);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('exposes the standard task context menu', async () => {
    const onComplete = vi.fn();
    const actions: TaskContextMenuActions = {
      onComplete,
      onSetPriority: vi.fn(),
      onSetStatus: vi.fn(),
      onAddToMyDay: vi.fn(),
      onDueToday: vi.fn(),
      onDueTomorrow: vi.fn(),
      onPickDate: vi.fn(),
      onDelete: vi.fn(),
    };

    render(
      <TooltipProvider>
        <SuggestedForToday
          tasks={[task]}
          onAdd={vi.fn()}
          onNotToday={vi.fn()}
          onComplete={vi.fn()}
          onSelect={vi.fn()}
          completingIds={new Set()}
          getContextMenuActions={() => actions}
        />
      </TooltipProvider>,
    );

    fireEvent.contextMenu(screen.getByText('Suggested task').closest('button')!);
    fireEvent.click(await screen.findByText('Mark as completed'));

    expect(onComplete).toHaveBeenCalledOnce();
  });
});
