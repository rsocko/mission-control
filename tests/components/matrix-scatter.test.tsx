import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/matrix',
}));

import { MatrixScatter } from '@/components/dashboard/matrix/MatrixScatter';
import { TaskViewSwitcher } from '@/components/dashboard/TaskViewSwitcher';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { normalizeTaskFilterContext } from '@/lib/task-filter-context';
import type { DashboardTaskViewModel as Task } from '@/types/dashboard';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

function matrixTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Ship matrix',
    status: 'todo',
    microStatus: null,
    priority: 'high',
    dueDate: '2026-07-31',
    connectorType: 'local',
    connectorInstanceId: 'local',
    sourceListName: 'Product',
    assignee: null,
    tags: [],
    metadata: '{}',
    sourceId: 'local:task-1',
    effort: 3,
    smartScore: 64,
    hasDescription: false,
    editPolicy: editableTaskPolicy,
    ...overrides,
    localDisposition: overrides.localDisposition ?? 'active',
    taskSourceModel: overrides.taskSourceModel ?? 'mc-owned',
    hasDescription: overrides.hasDescription ?? false,
  };
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

describe('TaskViewSwitcher', () => {
  it('links list and matrix views and marks the current view', () => {
    render(
      <TaskViewSwitcher
        context={normalizeTaskFilterContext({ tagSlugs: ['planning'] })}
        originHref="/matrix"
        originLabel="Priority Matrix"
      />,
    );

    expect(screen.getByRole('link', { name: 'List task view' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Matrix task view' })).toHaveAttribute('href', '/matrix');
    expect(screen.getByRole('link', { name: 'Matrix task view' })).toHaveAttribute('aria-current', 'page');
    const graphLink = screen.getByRole('link', { name: 'View Priority Matrix in Graph' });
    expect(graphLink).toHaveAttribute('href', expect.stringContaining('/graph/universe?'));
    expect(graphLink).toHaveAttribute('href', expect.stringContaining('from=%2Fmatrix'));
  });
});

describe('MatrixScatter', () => {
  beforeEach(() => {
    useDashboardViewStore.setState({
      matrixAxisMode: 'priority-urgency',
      matrixSizeMode: 'smart-score',
      matrixColorMode: 'project',
      matrixColorCustomized: false,
      matrixMobileView: 'table',
    });
  });

  it('renders the urgency preset, interactive task marks, and needs-data tasks', () => {
    const onSelectTask = vi.fn();
    render(
      <MatrixScatter
        tasks={[
          matrixTask({ id: 'q1', title: 'Do now' }),
          matrixTask({ id: 'q2', title: 'Plan it', dueDate: '2026-08-10' }),
          matrixTask({ id: 'unknown', title: 'Needs priority', priority: 'none' }),
        ]}
        projects={[]}
        onSelectTask={onSelectTask}
      />,
    );

    expect(screen.getByText('Do first')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText('Delegate')).toBeInTheDocument();
    expect(screen.getByText('Eliminate')).toBeInTheDocument();
    expect(screen.getByText('Needs data (1)')).toBeInTheDocument();
    expect(screen.getByText('Needs priority')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Do now/ }));
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
  });

  it('shows complete data-gap counts and expands marks for a small result set', () => {
    render(
      <MatrixScatter
        tasks={[
          matrixTask({ id: 'complete' }),
          matrixTask({ id: 'gaps', priority: 'none', effort: null, dueDate: null }),
        ]}
        projects={[]}
        onSelectTask={vi.fn()}
      />,
    );

    expect(screen.getByText('1 plotted')).toBeInTheDocument();
    expect(screen.getByText('1 missing priority')).toBeInTheDocument();
    expect(screen.getByText('1 missing effort')).toBeInTheDocument();
    expect(screen.getByText('1 missing due date')).toBeInTheDocument();
    expect(screen.getByText('Expanded marks for this filter')).toBeInTheDocument();
    expect(screen.getByText('Needs data (1)')).toBeInTheDocument();
    expect(screen.getByText('1 task plotted. 1 task has one or more data gaps.')).toBeInTheDocument();
  });

  it('omits empty data-gap counters', () => {
    render(
      <MatrixScatter
        tasks={[matrixTask({ id: 'complete' })]}
        projects={[]}
        onSelectTask={vi.fn()}
      />,
    );

    expect(screen.getByText('1 plotted')).toBeInTheDocument();
    expect(screen.queryByText('0 missing priority')).not.toBeInTheDocument();
    expect(screen.queryByText('0 missing effort')).not.toBeInTheDocument();
    expect(screen.queryByText('0 missing due date')).not.toBeInTheDocument();
  });

  it('switches to the effort preset and persists its recommended color default', () => {
    render(
      <MatrixScatter
        tasks={[matrixTask({ title: 'Explain me' })]}
        projects={[]}
        onSelectTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Axes'));
    fireEvent.click(screen.getByRole('option', { name: 'Priority x Effort' }));
    expect(screen.getByText('Quick wins')).toBeInTheDocument();
    expect(screen.getByText('Strategic')).toBeInTheDocument();
    expect(useDashboardViewStore.getState()).toMatchObject({
      matrixAxisMode: 'priority-effort',
      matrixColorMode: 'urgency',
    });
  });

  it('preserves an explicitly selected color when switching axes', () => {
    useDashboardViewStore.getState().setMatrixColorMode('status');
    useDashboardViewStore.getState().setMatrixAxisMode('priority-effort');
    expect(useDashboardViewStore.getState().matrixColorMode).toBe('status');
  });

  it('provides paginated access to every task in a dense cluster', () => {
    render(
      <MatrixScatter
        tasks={Array.from({ length: 180 }, (_, index) => matrixTask({
          id: `dense-${index}`,
          title: `Dense task ${index}`,
        }))}
        projects={[]}
        onSelectTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '180 tasks. Inspect cluster.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect all 180 tasks' }));
    expect(screen.getByRole('dialog', { name: 'Cluster tasks' })).toBeInTheDocument();
    expect(screen.getByText('1-100 of 180')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('101-180 of 180')).toBeInTheDocument();
  });
});
