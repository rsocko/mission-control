import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanTaskRow } from '@/app/projects/[id]/PlanTaskRow';
import type { TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type { ProjectTaskViewModel } from '@/app/projects/[id]/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

vi.mock('next/image', () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    <span role="img" aria-label={alt} data-src={src} />
  ),
}));

vi.mock('@/components/task-list/TaskContextMenu', () => ({
  TaskContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/ui/CompletionBurst', () => ({
  CompletionBurst: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/task-row/TaskRowActions', () => ({
  TaskRowActions: (props: {
    effort?: number | null;
    hasDescription?: boolean;
    priority: string;
    status: string;
    onOpenNotes: (mode: 'read' | 'edit') => void;
  }) => (
    <>
      <div
        data-testid="task-row-actions"
        data-effort={props.effort}
        data-priority={props.priority}
        data-status={props.status}
      />
      <button
        type="button"
        onClick={() => props.onOpenNotes(props.hasDescription ? 'read' : 'edit')}
      >
        {props.hasDescription ? 'Open notes' : 'Add notes'}
      </button>
    </>
  ),
}));

const task: ProjectTaskViewModel = {
  id: 'task-1',
  title: 'Shared Plan task',
  connectorType: 'github-issues',
  connectorInstanceId: 'github',
  localDisposition: 'active',
  microStatus: null,
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
  status: 'in_progress',
  priority: 'high',
  dueDate: '2026-08-28',
  updatedAt: '2026-08-26T12:00:00.000Z',
  sourceListName: 'Mission Control',
  sourceId: '123',
  metadata: JSON.stringify({ issueNumber: 123 }),
  effort: 3,
  subtaskDone: 1,
  subtaskTotal: 2,
  tags: [],
  planningHorizon: null,
  assignee: null,
  hasDescription: false,
};

const contextMenuActions: TaskContextMenuActions = {
  onComplete: vi.fn(),
  onSetPriority: vi.fn(),
  onDueToday: vi.fn(),
  onDueTomorrow: vi.fn(),
  onPickDate: vi.fn(),
  onDelete: vi.fn(),
};

function renderRow(overrides: Partial<React.ComponentProps<typeof PlanTaskRow>> = {}) {
  const props: React.ComponentProps<typeof PlanTaskRow> = {
    task,
    dragHandleProps: {},
    dragLabel: 'Drag task to another phase',
    isSelected: false,
    isCompleting: false,
    onSelect: vi.fn(),
    onDoubleClick: vi.fn(),
    onOpenNotes: vi.fn(),
    onComplete: vi.fn(),
    isInMyDay: false,
    contextMenuActions,
    phaseMenuItems: [],
    projects: [],
    ...overrides,
  };

  return {
    ...render(<PlanTaskRow {...props} />),
    props,
  };
}

describe('PlanTaskRow', () => {
  it('renders the common task row inside the Plan surface', () => {
    const { container } = renderRow();
    const row = container.querySelector('[data-task-row-surface="plan"]');

    expect(row).toHaveAttribute('data-task-row-variant', 'card');
    expect(screen.getByText('Shared Plan task')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'github-issues' })).toBeInTheDocument();
    expect(screen.getByText('Mission Control')).toBeInTheDocument();
    expect(screen.getByTitle('1 of 2 subtasks complete')).toBeInTheDocument();
    expect(screen.getByTestId('task-row-actions')).toHaveAttribute('data-effort', '3');
    expect(screen.getByTestId('task-row-actions')).toHaveAttribute('data-priority', 'high');
    expect(screen.getByTestId('task-row-actions')).toHaveAttribute('data-status', 'in_progress');
  });

  it('shares click and double-click behavior while preserving Plan callbacks', () => {
    const onSelect = vi.fn();
    const onDoubleClick = vi.fn();
    const { container } = renderRow({ onSelect, onDoubleClick });
    const row = container.querySelector<HTMLElement>('[data-task-row-surface="plan"]');

    fireEvent.click(row!);
    fireEvent.doubleClick(row!);

    expect(onSelect).toHaveBeenCalledWith('task-1');
    expect(onDoubleClick).toHaveBeenCalledWith('task-1');
  });

  it('opens the expanded notes surface instead of the task dialog', () => {
    const onOpenNotes = vi.fn();
    renderRow({ onOpenNotes });

    fireEvent.click(screen.getByRole('button', { name: 'Add notes' }));

    expect(onOpenNotes).toHaveBeenCalledWith('task-1', 'edit');
  });

  it('opens existing notes in read mode', () => {
    const onOpenNotes = vi.fn();
    renderRow({
      task: { ...task, hasDescription: true },
      onOpenNotes,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open notes' }));

    expect(onOpenNotes).toHaveBeenCalledWith('task-1', 'read');
  });

  it('uses bulk selection instead of opening the task when bulk mode is active', () => {
    const onBulkToggle = vi.fn();
    const onDoubleClick = vi.fn();
    const { container } = renderRow({
      bulkMode: true,
      bulkSelected: true,
      onBulkToggle,
      onDoubleClick,
    });
    const row = container.querySelector<HTMLElement>('[data-task-row-surface="plan"]');

    fireEvent.click(row!);
    fireEvent.doubleClick(row!);

    expect(onBulkToggle).toHaveBeenCalledOnce();
    expect(onDoubleClick).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Select Shared Plan task' })).toBeChecked();
  });

  it('keeps assignment rows compact without dropping the shared identity', () => {
    const { container } = renderRow({ variant: 'compact' });
    const row = container.querySelector('[data-task-row-surface="plan"]');

    expect(row).toHaveAttribute('data-task-row-variant', 'compact');
    expect(screen.getByText('Shared Plan task')).toHaveClass('text-sm');
    expect(screen.queryByText('Mission Control')).not.toBeInTheDocument();
  });
});
