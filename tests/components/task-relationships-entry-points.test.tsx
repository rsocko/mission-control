import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';
import TodayPage from '@/app/today/page';
import { TaskDetailPanel as KanbanTaskDetailPanel } from '@/app/kanban/components/TaskDetailPanel';

const mocks = vi.hoisted(() => ({
  fetchData: vi.fn(async () => {}),
  removeFromDay: vi.fn(async () => {}),
  completeTask: vi.fn(async () => true),
  deleteTask: vi.fn(async () => {}),
}));

vi.mock('@/components/task-detail/TaskDetailPanel', () => ({
  TaskDetailPanel: ({
    taskId,
    mode,
    isInMyDay,
    onToggleMyDay,
    onComplete,
    onDelete,
    onClose,
    onUpdate,
  }: {
    taskId: string;
    mode: string;
    isInMyDay?: boolean;
    onToggleMyDay?: () => void;
    onComplete?: () => void;
    onDelete?: () => void;
    onClose: () => void;
    onUpdate?: (fields?: Record<string, string>) => void;
  }) => (
    <section
      data-testid={`shared-task-detail-${mode}`}
      data-task-id={taskId}
      data-in-my-day={String(Boolean(isInMyDay))}
    >
      <button onClick={onClose}>Close shared detail</button>
      {onComplete && <button onClick={onComplete}>Complete through host</button>}
      {onDelete && <button onClick={onDelete}>Delete through host</button>}
      {onToggleMyDay && <button onClick={onToggleMyDay}>Toggle My Day</button>}
      {onUpdate && (
        <button onClick={() => {
          onUpdate({ title: 'Updated title' });
          onUpdate({ status: 'in_progress' });
        }}>
          Update fields through host
        </button>
      )}
    </section>
  ),
}));

vi.mock('@/components/today/MobileTodayList', () => ({
  MobileTodayList: ({ onSelectTask }: { onSelectTask: (taskId: string) => void }) => (
    <button onClick={() => onSelectTask('today-task')}>Open Today mobile task</button>
  ),
}));

vi.mock('@/components/ui/MobileSheet', () => ({
  MobileSheet: ({
    isOpen,
    children,
    onClose,
    ariaLabel,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    onClose: () => void;
    ariaLabel: string;
  }) => isOpen ? (
    <div role="dialog" aria-label={ariaLabel}>
      <button onClick={onClose}>Close sheet</button>
      {children}
    </div>
  ) : null,
}));

vi.mock('@/components/today/TodayMainPanel', () => ({
  TodayMainPanel: ({ onSelectTask }: { onSelectTask: (taskId: string) => void }) => (
    <button onClick={() => onSelectTask('today-task')}>Open Today desktop task</button>
  ),
}));
vi.mock('@/components/today/TodayScheduleModal', () => ({ TodayScheduleModal: () => null }));
vi.mock('@/components/today/TodaySidebar', () => ({ TodaySidebar: () => null }));
vi.mock('@/components/add-task', () => ({ SaveTemplateModal: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }));
vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({ progress: { refetchKey: 0 } }),
}));
vi.mock('@/lib/hooks/useQuickAddContext', () => ({
  useQuickAddContext: () => ({ setQuickAddFilter: vi.fn(), clearQuickAddFilter: vi.fn() }),
}));
vi.mock('@/lib/hooks/useTaskSelection', () => ({
  useTaskSelection: ({ onSelectionChange }: { onSelectionChange: (taskId: string) => void }) => ({
    handleTaskClick: (taskId: string) => onSelectionChange(taskId),
    handleTaskDoubleClick: vi.fn(),
    cancelPendingDeselect: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/useMyDayData', () => ({
  useMyDayData: () => ({
    items: [{
      id: 'today-item',
      taskId: 'today-task',
      order: 1,
      isAutoIncluded: false,
      addedAt: '2026-07-31T12:00:00.000Z',
      title: 'Today task',
      status: 'todo',
      priority: 'high',
      dueDate: null,
      connectorType: 'local',
      connectorInstanceId: 'local',
      sourceId: 'local:today-task',
      sourceListName: 'Inbox',
      createdAt: '2026-07-31T12:00:00.000Z',
      tags: [],
      editPolicy: editableTaskPolicy,
    }],
    scheduled: [],
    calendarEvents: [],
    suggestions: {},
    sourceLists: [],
    connectorCapsMap: { local: { write: true, delete: true } },
    energyLevel: null,
    loading: false,
    fetchData: mocks.fetchData,
    setItems: vi.fn(),
    setEnergyLevel: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/useTodayActions', () => ({
  useTodayActions: () => ({
    completingIds: new Set<string>(),
    removeFromDay: mocks.removeFromDay,
    completeTask: mocks.completeTask,
    deleteTask: mocks.deleteTask,
    setTaskDueDate: vi.fn(async () => {}),
    addToDay: vi.fn(),
    confirmDialog: {
      open: false,
      title: '',
      message: '',
      confirmLabel: '',
      variant: 'danger',
      onConfirm: vi.fn(),
    },
    setConfirmDialog: vi.fn(),
  }),
}));

function taskDetailRelationshipOwners(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return taskDetailRelationshipOwners(path);
    if (!entry.name.endsWith('.tsx')) return [];
    const source = readFileSync(path, 'utf8');
    return /import\s+\{\s*TaskRelationshipsSection\s*\}/.test(source) ? [path] : [];
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('task relationship detail entry points', () => {
  it('keeps the shared panel as the only relationship composition owner', () => {
    const owners = taskDetailRelationshipOwners(join(process.cwd(), 'src'));

    expect(owners).toEqual([
      join(process.cwd(), 'src', 'components', 'task-detail', 'TaskDetailPanel.tsx'),
    ]);
  });

  it('routes the Kanban overlay through the shared panel with connector permissions', () => {
    const onTaskUpdate = vi.fn();
    render(
      <KanbanTaskDetailPanel
        task={{
          id: 'kanban-task',
          title: 'Kanban task',
          description: null,
          status: 'todo',
          priority: 'medium',
          dueDate: null,
          connectorType: 'local',
          connectorInstanceId: 'local',
          sourceId: 'local:kanban-task',
          sourceListId: 'inbox',
          sourceListName: 'Inbox',
          kanbanColumn: 'Backlog',
          kanbanOrder: 1,
          tags: [],
          localDisposition: 'active',
          taskSourceModel: 'mc-owned',
          editPolicy: editableTaskPolicy,
        }}
        onClose={vi.fn()}
        onTaskUpdate={onTaskUpdate}
      />,
    );

    const sharedPanel = screen.getByTestId('shared-task-detail-panel');
    expect(sharedPanel).toHaveAttribute('data-task-id', 'kanban-task');
    expect(sharedPanel).not.toHaveAttribute('data-can-write');
    expect(sharedPanel).not.toHaveAttribute('data-can-delete');
    fireEvent.click(screen.getByRole('button', { name: 'Update fields through host' }));
    expect(onTaskUpdate).toHaveBeenNthCalledWith(1, 'kanban-task', { title: 'Updated title' });
    expect(onTaskUpdate).toHaveBeenNthCalledWith(2, 'kanban-task', { status: 'in_progress' });
  });

  it('routes Today desktop completion through the Today workflow', async () => {
    render(<TodayPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Today desktop task' }));

    const desktopPanel = screen.getByTestId('shared-task-detail-panel');
    fireEvent.click(within(desktopPanel).getByRole('button', { name: 'Complete through host' }));

    expect(mocks.completeTask).toHaveBeenCalledWith('today-task');
    await waitFor(() => expect(screen.queryByTestId('shared-task-detail-panel')).not.toBeInTheDocument());
  });

  it('keeps Today detail open when host completion fails', async () => {
    mocks.completeTask.mockResolvedValueOnce(false);
    render(<TodayPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Today mobile task' }));

    const sheet = screen.getByRole('dialog', { name: 'Task details' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Complete through host' }));

    await waitFor(() => expect(mocks.completeTask).toHaveBeenCalledWith('today-task'));
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeInTheDocument();
  });

  it('launches Today mobile tasks in MobileSheet through shared mobile mode', async () => {
    render(<TodayPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Today mobile task' }));

    const sheet = screen.getByRole('dialog', { name: 'Task details' });
    const mobilePanel = within(sheet).getByTestId('shared-task-detail-mobile');
    expect(screen.queryByTestId('shared-task-detail-panel')).not.toBeInTheDocument();
    expect(mobilePanel).toHaveAttribute('data-task-id', 'today-task');
    expect(mobilePanel).not.toHaveAttribute('data-can-write');
    expect(mobilePanel).not.toHaveAttribute('data-can-delete');
    expect(mobilePanel).toHaveAttribute('data-in-my-day', 'true');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Complete through host' }));
    expect(mocks.completeTask).toHaveBeenCalledWith('today-task');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task details' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Open Today mobile task' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Task details' })).getByRole('button', { name: 'Delete through host' }));
    expect(mocks.deleteTask).toHaveBeenCalledWith('today-task', undefined);
    expect(screen.queryByRole('dialog', { name: 'Task details' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Today mobile task' }));
    const reopenedSheet = screen.getByRole('dialog', { name: 'Task details' });
    fireEvent.click(within(reopenedSheet).getByRole('button', { name: 'Toggle My Day' }));
    expect(mocks.removeFromDay).toHaveBeenCalledWith('today-task');
    expect(screen.queryByRole('dialog', { name: 'Task details' })).not.toBeInTheDocument();
  });
});
