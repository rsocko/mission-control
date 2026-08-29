/**
 * TaskRow component tests — project badge and responsive attribute rendering
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { DashboardTaskViewModel as Task } from '@/types/dashboard';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const dashboardStoreSpies = vi.hoisted(() => ({
  setPriorityFilter: vi.fn(),
  setStatusFilter: vi.fn(),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => {
  const Stub = ({
    children,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    React.createElement('span', props, children)
  );
  return {
    AlertCircle: Stub,
    Bell: Stub,
    ChartNetwork: Stub,
    Check: Stub,
    Clock: Stub,
    Globe: Stub,
    Pause: Stub,
    Repeat: Stub,
    Timer: Stub,
    X: Stub,
  };
});

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => React.createElement('img', props),
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children, content }: { children: React.ReactNode; content: string }) => (
    <span data-tooltip={content}>{children}</span>
  ),
}));

vi.mock('@/components/ui/CompletionBurst', () => ({
  CompletionBurst: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/SubtaskPill', () => ({
  SubtaskPill: ({ onClick }: { onClick?: () => void }) => (
    onClick ? <button type="button" onClick={onClick}>Subtasks</button> : null
  ),
}));

vi.mock('@/components/ui/icon-picker', () => ({
  IconRenderer: ({ value }: { value: string }) => React.createElement('span', { 'data-testid': 'icon-renderer', 'data-value': value }),
}));

vi.mock('@/components/smart-score/SmartScoreBadge', () => ({
  SmartScoreBadge: () => null,
}));

vi.mock('@/components/task-row/TaskRowActions', () => ({
  TaskRowActions: (props: {
    smartScore?: number | null;
    planningHorizon?: string | null;
    effort?: number | null;
    priority: string;
    status: string;
    onFilterPriority?: (priority: string) => void;
    onFilterStatus?: (status: string) => void;
  }) => (
    <span
      data-testid="task-row-actions"
      data-score={props.smartScore}
      data-horizon={props.planningHorizon}
      data-effort={props.effort}
      data-priority={props.priority}
      data-status={props.status}
    >
      <button type="button" onClick={() => props.onFilterPriority?.(props.priority)}>Filter row priority</button>
      <button type="button" onClick={() => props.onFilterStatus?.(props.status)}>Filter row status</button>
    </span>
  ),
}));

vi.mock('@/components/task-list/MicroStatusIcon', () => ({
  MicroStatusIcon: ({ status }: { status: string }) => (
    <span data-micro-status-icon={status} />
  ),
}));

vi.mock('@/types', () => ({
  MICRO_STATUS_CONFIG: {
    waiting_on_someone: {
      label: 'Waiting on someone',
      color: '#f59e0b',
      description: 'Waiting for another person',
    },
  },
}));

vi.mock('@/lib/utils/client-date', () => ({
  getLocalToday: () => '2026-07-28',
}));

vi.mock('@/lib/utils/task-display-id', () => ({
  getTaskDisplayId: () => null,
}));

vi.mock('@/lib/utils/dashboard-helpers', () => ({
  formatDate: (d: string) => d,
}));

vi.mock('@/lib/utils/synthetic-tags', () => ({
  isSyntheticTag: () => false,
}));

vi.mock('@/types/dashboard', () => ({
  CONNECTOR_ICONS: {},
  PRIORITY_COLORS: { high: 'text-red-400 border-red-800/30 bg-red-900/20', none: '' },
  PRIORITY_LABELS: { high: 'P1', none: '' },
  STATUS_COLORS: { 'in-progress': 'text-blue-400' },
  STATUS_LABELS: { 'in-progress': 'In Progress', todo: 'To Do' },
}));

vi.mock('@/lib/constants/task-formatting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/constants/task-formatting')>();
  return {
    ...actual,
    EFFORT_BADGE_COLORS: { 3: 'text-yellow-400' },
    EFFORT_MEASURE_LABELS: { points: { 1: 'XS', 2: 'S', 3: 'M', 4: 'L', 5: 'XL' } },
    DEFAULT_EFFORT_MEASURE: 'points',
  };
});

vi.mock('@/lib/stores/dashboardViewStore', () => ({
  useDashboardViewStore: () => ({
    tagFilter: [],
    setTagFilter: vi.fn(),
    priorityFilter: [],
    setPriorityFilter: dashboardStoreSpies.setPriorityFilter,
    statusFilter: [],
    setStatusFilter: dashboardStoreSpies.setStatusFilter,
    projectFilter: null,
    setProjectFilter: vi.fn(),
    groupBy: 'priority',
  }),
}));

import { TaskRow } from '@/components/task-list/TaskRow';

const baseTask: Task = {
  id: 'task-1',
  title: 'Test task',
  status: 'todo',
  localDisposition: 'active',
  taskSourceModel: 'remote-managed',
  microStatus: null,
  priority: 'none',
  planningHorizon: null,
  dueDate: null,
  connectorType: 'microsoft-todo',
  connectorInstanceId: 'inst-1',
  sourceListName: null,
  assignee: null,
  tags: [],
  metadata: null,
  sourceId: null,
  hasDescription: false,
  editPolicy: editableTaskPolicy,
};

const noop = () => {};
const actionProps = {
  onSnoozeUntil: noop,
  onSetDueDate: noop,
  onSetPriority: noop,
  onSetStatus: noop,
  onSetLocalDisposition: noop,
  onOpenNotes: noop,
};

describe('TaskRow', () => {
  describe('ProjectBadge', () => {
    it('renders project badge when task has hubProjectIds', () => {
      const projects = [
        { id: 'proj-1', name: 'Website Redesign', color: '#3b82f6', icon: null },
      ];
      render(
        <TaskRow
          task={{ ...baseTask, hubProjectIds: ['proj-1'] }}
          projects={projects}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );
      expect(screen.getByText('Website Redesign')).toBeInTheDocument();
      expect(screen.getByLabelText(/Filter by project: Website Redesign/)).toBeInTheDocument();
    });

    it('renders individual badges when task is in multiple projects', () => {
      const projects = [
        { id: 'proj-1', name: 'Project A', color: '#3b82f6', icon: null },
        { id: 'proj-2', name: 'Project B', color: '#10b981', icon: null },
      ];
      render(
        <TaskRow
          task={{ ...baseTask, hubProjectIds: ['proj-1', 'proj-2'] }}
          projects={projects}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );
      expect(screen.getByLabelText(/Filter by project: Project A/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Filter by project: Project B/)).toBeInTheDocument();
    });

    it('does not render project badge when hubProjectIds is empty', () => {
      render(
        <TaskRow
          task={{ ...baseTask, hubProjectIds: [] }}
          projects={[{ id: 'proj-1', name: 'X', color: '#000', icon: null }]}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );
      expect(screen.queryByLabelText(/Filter by project/)).not.toBeInTheDocument();
    });

    it('does not render project badge when projects prop is not passed', () => {
      render(
        <TaskRow
          task={{ ...baseTask, hubProjectIds: ['proj-1'] }}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );
      expect(screen.queryByLabelText(/Filter by project/)).not.toBeInTheDocument();
    });
  });

  describe('subtask navigation', () => {
    it('opens subtasks directly from the subtask badge', () => {
      const onOpenSubtasks = vi.fn();
      render(
        <TaskRow
          task={{ ...baseTask, subtaskDone: 1, subtaskTotal: 2 }}
          onComplete={noop}
          {...actionProps}
          onOpenSubtasks={onOpenSubtasks}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Subtasks' }));

      expect(onOpenSubtasks).toHaveBeenCalledOnce();
    });
  });

  it('preserves wrapper interactions when row callbacks are not supplied', () => {
    const onDoubleClick = vi.fn();

    render(
      <div onDoubleClick={onDoubleClick}>
        <TaskRow
          task={baseTask}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      </div>,
    );

    fireEvent.doubleClick(screen.getByText('Test task'));

    expect(onDoubleClick).toHaveBeenCalledOnce();
  });

  it('renders contextual metadata and routes row filters through a supplied controller', () => {
    const onToggleTag = vi.fn();
    const onFilterPriority = vi.fn();
    const onFilterStatus = vi.fn();

    render(
      <TaskRow
        task={{
          ...baseTask,
          priority: 'high',
          tags: [{ id: 'tag-1', name: 'Design', slug: 'design', type: 'hub', color: null }],
        }}
        onComplete={noop}
        {...actionProps}
        onAddToMyDay={noop}
        onRemoveFromMyDay={noop}
        secondaryMetadata={<span>Phase: Build</span>}
        filterController={{
          tagSlugs: [],
          projectId: null,
          onToggleTag,
          onFilterPriority,
          onFilterStatus,
        }}
      />,
    );

    expect(screen.getByText('Phase: Build')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Design' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter row priority' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter row status' }));

    expect(onToggleTag).toHaveBeenCalledWith('design');
    expect(onFilterPriority).toHaveBeenCalledWith('high');
    expect(onFilterStatus).toHaveBeenCalledWith('todo');
    expect(dashboardStoreSpies.setPriorityFilter).not.toHaveBeenCalled();
    expect(dashboardStoreSpies.setStatusFilter).not.toHaveBeenCalled();
  });

  describe('responsive attribute classes', () => {
    it('applies @container to the root row element', () => {
      const { container } = render(
        <TaskRow
          task={baseTask}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );
      const row = container.firstElementChild;
      expect(row?.className).toContain('@container');
    });

    it('routes aligned properties and explicit filter commands through the shared grid', () => {
      render(
        <TaskRow
          task={{
            ...baseTask,
            priority: 'high',
            status: 'in_progress',
            effort: 3,
            planningHorizon: 'soon',
            smartScore: 72,
          }}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );
      const properties = screen.getByTestId('task-row-actions');
      expect(properties).toHaveAttribute('data-score', '72');
      expect(properties).toHaveAttribute('data-horizon', 'soon');
      expect(properties).toHaveAttribute('data-effort', '3');
      expect(properties).toHaveAttribute('data-priority', 'high');
      expect(properties).toHaveAttribute('data-status', 'in_progress');

      fireEvent.click(screen.getByRole('button', { name: 'Filter row priority' }));
      fireEvent.click(screen.getByRole('button', { name: 'Filter row status' }));
      expect(dashboardStoreSpies.setPriorityFilter).toHaveBeenCalledWith(['high']);
      expect(dashboardStoreSpies.setStatusFilter).toHaveBeenCalledWith(['in_progress']);
    });
  });

  describe('terminal status styling', () => {
    it('dims cancelled tasks without presenting them as completed', () => {
      const { container } = render(
        <TaskRow
          task={{ ...baseTask, status: 'cancelled' }}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );

      expect(container.firstElementChild?.className).toContain('opacity-50');
      expect(screen.getByText('Test task')).not.toHaveClass('line-through');
    });

    it('dims and strikes through completed tasks', () => {
      const { container } = render(
        <TaskRow
          task={{ ...baseTask, status: 'done' }}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );

      expect(container.firstElementChild?.className).toContain('opacity-50');
      expect(screen.getByText('Test task')).toHaveClass('line-through');
    });

    describe('status indicator', () => {
      it('uses the blue status ring for in-progress work', () => {
        const { container } = render(
          <TaskRow
            task={{ ...baseTask, status: 'in_progress' }}
            onComplete={noop}
            {...actionProps}
            onAddToMyDay={noop}
            onRemoveFromMyDay={noop}
          />
        );

        expect(container.querySelector('[data-task-status="in_progress"] > span'))
          .toHaveClass('border-blue-500');
      });

      it('shows the amber blocked treatment and refined waiting label', () => {
        const { container } = render(
          <TaskRow
            task={{ ...baseTask, status: 'in_progress', microStatus: 'waiting_on_someone' }}
            onComplete={noop}
            {...actionProps}
            onAddToMyDay={noop}
            onRemoveFromMyDay={noop}
          />
        );

        expect(container.querySelector('[data-task-blocked="true"]')).toBeInTheDocument();
        expect(screen.getByText('Waiting on someone')).toBeInTheDocument();
      });
    });
  });
});
