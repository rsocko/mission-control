import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PhaseAssignView } from '@/app/projects/[id]/PhaseAssignView';
import type { ProjectPhase } from '@/app/projects/[id]/types';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: {},
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

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
      onCompleteTask={vi.fn()}
      onRenamePhase={onRenamePhase}
      savingPhaseIds={new Set()}
      phaseMutationPending={false}
      createPhaseDisabled={false}
      onCreatePhase={vi.fn()}
      onCreateNewTask={vi.fn()}
      onLinkExistingTask={vi.fn()}
      activeDragId={null}
      getTaskContextActions={vi.fn()}
      phaseMenuItems={[{ id: phase.id, name: phase.name }]}
    />,
  );
  return onRenamePhase;
}

describe('PhaseAssignView phase names', () => {
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
        onCompleteTask={vi.fn()}
        onRenamePhase={vi.fn()}
        savingPhaseIds={new Set(['phase-2'])}
        phaseMutationPending
        createPhaseDisabled
        onCreatePhase={vi.fn()}
        onCreateNewTask={vi.fn()}
        onLinkExistingTask={vi.fn()}
        activeDragId={null}
        getTaskContextActions={vi.fn()}
        phaseMenuItems={[{ id: phase.id, name: phase.name }]}
      />,
    );

    expect(screen.getByRole('button', { name: phase.name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New Phase' })).toBeDisabled();
  });
});
