import { fireEvent, render, screen } from '@testing-library/react';
import { History } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { SuggestionGroup } from '@/components/today/SuggestionGroup';
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

function renderGroup({
  onSelect = vi.fn<(taskId: string) => void>(),
  onComplete = vi.fn<() => void>(),
  onAdd = vi.fn<(taskId: string) => void>(),
}: {
  onSelect?: (taskId: string) => void;
  onComplete?: () => void;
  onAdd?: (taskId: string) => void;
} = {}) {
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
      <SuggestionGroup
        title="Overdue"
        icon={<History size={12} />}
        tasks={[task]}
        color="red"
        onAdd={onAdd}
        onSelect={onSelect}
        getContextMenuActions={() => actions}
        sourceLists={[]}
        listGroups={[]}
        projects={[]}
      />
    </TooltipProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: /Overdue/ }));
  return { onSelect, onComplete, onAdd };
}

describe('SuggestionGroup task interactions', () => {
  it('opens task detail selection from a suggested row', () => {
    const { onSelect } = renderGroup();

    fireEvent.click(screen.getByText('Suggested task'));

    expect(onSelect).toHaveBeenCalledWith('task-1');
  });

  it('exposes the standard task context menu', async () => {
    const { onComplete } = renderGroup();
    const row = screen.getByRole('button', { name: /Suggested task due Aug 4/ });

    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!);
    fireEvent.click(await screen.findByText('Mark as completed'));

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('keeps keyboard Add separate from opening task detail', () => {
    const { onAdd, onSelect } = renderGroup();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Add "Suggested task" to My Day' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Add "Suggested task" to My Day' }));

    expect(onAdd).toHaveBeenCalledWith('task-1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
