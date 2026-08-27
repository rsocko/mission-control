import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PhaseAssignView } from '@/app/projects/[id]/PhaseAssignView';
import type { TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type {
  ProjectPhaseViewModel as ProjectPhase,
  ProjectTaskViewModel as ProjectTask,
} from '@/app/projects/[id]/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => false,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

vi.mock('@/components/task-list/TaskContextMenu', () => ({
  TaskContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/task-row/TaskRowActions', () => ({
  TaskRowActions: () => null,
}));

const taskContextActions: TaskContextMenuActions = {
  onComplete: vi.fn(),
  onSetPriority: vi.fn(),
  onDueToday: vi.fn(),
  onDueTomorrow: vi.fn(),
  onPickDate: vi.fn(),
  onDelete: vi.fn(),
};

const phase: ProjectPhase = {
  id: 'phase-1',
  projectId: 'project-1',
  name: 'Phase 1',
  description: null,
  status: 'pending',
  color: '#ec4899',
  estimatedDays: null,
  targetStart: null,
  targetEnd: null,
  startAfterPhaseId: null,
  sortOrder: 0,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const task: ProjectTask = {
  id: 'task-1',
  title: 'Plan task',
  status: 'todo',
  priority: 'medium',
  dueDate: null,
  updatedAt: '2026-08-23T00:00:00.000Z',
  connectorType: 'local',
  connectorInstanceId: 'local',
  localDisposition: 'active',
  microStatus: null,
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
  tags: [],
  planningHorizon: null,
  sourceId: null,
  sourceListName: null,
  assignee: null,
  hasDescription: false,
  metadata: null,
};

function renderView(onRenamePhase = vi.fn()) {
  render(
    <PhaseAssignView
      phases={[phase]}
      unassignedTasks={[]}
      phaseEntries={{ [phase.id]: [] }}
      sensors={[]}
      collisionDetection={vi.fn()}
      tasks={[]}
      myDayTaskIds={new Set()}
      completingIds={new Set()}
      selectedTaskId={null}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      onSelectTask={vi.fn()}
      onDoubleClickTask={vi.fn()}
      onCompleteTask={vi.fn()}
      onRenamePhase={onRenamePhase}
      savingPhaseIds={new Set()}
      phaseMutationPending={false}
      createPhaseDisabled={false}
      onCreatePhase={vi.fn()}
      onCreateNewTask={vi.fn()}
      onLinkExistingTask={vi.fn()}
      activeDragId={null}
      getTaskContextActions={() => taskContextActions}
      phaseMenuItems={[{ id: phase.id, name: phase.name }]}
    />,
  );
  return onRenamePhase;
}

describe('PhaseAssignView phase names', () => {
  it('opens an unassigned task when its row is double-clicked', () => {
    const onDoubleClickTask = vi.fn();
    render(
      <PhaseAssignView
        phases={[phase]}
        unassignedTasks={[task]}
        phaseEntries={{ [phase.id]: [] }}
        sensors={[]}
        collisionDetection={vi.fn()}
        tasks={[task]}
        myDayTaskIds={new Set()}
        completingIds={new Set()}
        selectedTaskId={null}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onSelectTask={vi.fn()}
        onDoubleClickTask={onDoubleClickTask}
        onCompleteTask={vi.fn()}
        onRenamePhase={vi.fn()}
        savingPhaseIds={new Set()}
        phaseMutationPending={false}
        createPhaseDisabled={false}
        onCreatePhase={vi.fn()}
        onCreateNewTask={vi.fn()}
        onLinkExistingTask={vi.fn()}
        activeDragId={null}
        getTaskContextActions={() => taskContextActions}
        phaseMenuItems={[{ id: phase.id, name: phase.name }]}
      />,
    );

    fireEvent.doubleClick(screen.getByText(task.title));

    expect(onDoubleClickTask).toHaveBeenCalledWith(task.id);
  });

  it('renames a phase inline when Enter is pressed', () => {
    const onRenamePhase = renderView();

    fireEvent.click(screen.getByRole('button', { name: phase.name }));
    const input = screen.getByRole('textbox', { name: `Rename ${phase.name}` });
    fireEvent.change(input, { target: { value: 'Discovery' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenamePhase).toHaveBeenCalledWith(phase, 'Discovery');
  });

  it('saves an inline rename when focus leaves the input', () => {
    const onRenamePhase = renderView();

    fireEvent.click(screen.getByRole('button', { name: phase.name }));
    const input = screen.getByRole('textbox', { name: `Rename ${phase.name}` });
    fireEvent.change(input, { target: { value: 'Delivery' } });
    fireEvent.blur(input);

    expect(onRenamePhase).toHaveBeenCalledWith(phase, 'Delivery');
  });

  it('cancels an inline rename when Escape is pressed', () => {
    const onRenamePhase = renderView();

    fireEvent.click(screen.getByRole('button', { name: phase.name }));
    const input = screen.getByRole('textbox', { name: `Rename ${phase.name}` });
    fireEvent.change(input, { target: { value: 'Discarded name' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRenamePhase).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: phase.name })).toBeInTheDocument();
  });

  it('prevents another rename while any phase is saving', () => {
    render(
      <PhaseAssignView
        phases={[phase]}
        unassignedTasks={[]}
        phaseEntries={{ [phase.id]: [] }}
        sensors={[]}
        collisionDetection={vi.fn()}
        tasks={[]}
        myDayTaskIds={new Set()}
        completingIds={new Set()}
        selectedTaskId={null}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onSelectTask={vi.fn()}
        onDoubleClickTask={vi.fn()}
        onCompleteTask={vi.fn()}
        onRenamePhase={vi.fn()}
        savingPhaseIds={new Set(['phase-2'])}
        phaseMutationPending
        createPhaseDisabled
        onCreatePhase={vi.fn()}
        onCreateNewTask={vi.fn()}
        onLinkExistingTask={vi.fn()}
        activeDragId={null}
        getTaskContextActions={() => taskContextActions}
        phaseMenuItems={[{ id: phase.id, name: phase.name }]}
      />,
    );

    expect(screen.getByRole('button', { name: phase.name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New Phase' })).toBeDisabled();
  });
});
