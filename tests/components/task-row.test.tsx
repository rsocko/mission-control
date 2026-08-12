/**
 * TaskRow component tests — project badge and responsive attribute rendering
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Task } from '@/types/dashboard';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

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
    Repeat: Stub,
    Timer: Stub,
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
  SubtaskPill: () => null,
}));

vi.mock('@/components/ui/icon-picker', () => ({
  IconRenderer: ({ value }: { value: string }) => React.createElement('span', { 'data-testid': 'icon-renderer', 'data-value': value }),
}));

vi.mock('@/components/smart-score/SmartScoreBadge', () => ({
  SmartScoreBadge: () => null,
}));

vi.mock('@/components/task-row/TaskRowActions', () => ({
  TaskRowActions: () => <span data-testid="task-row-actions" />,
}));

vi.mock('@/types', () => ({
  MICRO_STATUS_CONFIG: {},
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
    setPriorityFilter: vi.fn(),
    statusFilter: [],
    setStatusFilter: vi.fn(),
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

    it('keeps filterable value badges before the right-anchored action rail', () => {
      const { container } = render(
        <TaskRow
          task={{ ...baseTask, priority: 'high', status: 'in-progress' }}
          onComplete={noop}
          {...actionProps}
          onAddToMyDay={noop}
          onRemoveFromMyDay={noop}
        />
      );
      const children = Array.from(container.firstElementChild?.children ?? []);
      const actionIndex = children.indexOf(screen.getByTestId('task-row-actions'));
      const priorityIndex = children.indexOf(screen.getByTitle('Filter by high priority'));
      const statusIndex = children.indexOf(screen.getByTitle('Filter by In Progress'));

      expect(priorityIndex).toBeLessThan(actionIndex);
      expect(statusIndex).toBeLessThan(actionIndex);
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
  });
});
