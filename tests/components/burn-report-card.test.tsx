import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BurnReport } from '@/lib/reports/burn-types';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-chart">{children}</div>
  ),
  LineChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data: Array<{ date: string; label: string }>;
  }) => (
    <div
      data-testid="line-chart"
      data-first-date={data[0]?.date}
      data-first-label={data[0]?.label}
    >
      {children}
    </div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: ({ dataKey }: { dataKey: string }) => <div data-testid="status-area" data-key={dataKey} />,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: () => null,
  ReferenceLine: ({ x }: { x: string }) => <div data-testid="reference-line" data-x={x} />,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

import { BurnReportCard } from '@/components/projects/BurnReportCard';

const baseReport: BurnReport = {
  projectId: 'project-1',
  scope: 'project',
  scopeId: 'project-1',
  scopeName: 'Reporting',
  mode: 'count',
  unitLabel: 'tasks',
  range: { start: '2026-07-01', end: '2026-07-31' },
  points: [
    {
      date: '2026-07-31',
      total: 2,
      completed: 1,
      remaining: 1,
      todo: 0,
      inProgress: 1,
      cancelled: 0,
      idealCompleted: 1,
      idealRemaining: 1,
      effortCoverage: 0.5,
      estimateIncomplete: true,
      partial: false,
      completedTaskIds: ['task-1'],
      remainingTaskIds: ['task-2'],
      statusTaskIds: {
        todo: [],
        inProgress: ['task-2'],
        done: ['task-1'],
        cancelled: [],
      },
    },
  ],
  tasks: [
    { id: 'task-1', title: 'Shipped task' },
    { id: 'task-2', title: 'Open task' },
  ],
  partialHistory: false,
  historicalBoundaryAt: null,
  completeFromDate: null,
  effort: {
    available: false,
    coverage: 0.5,
    estimatedTasks: 1,
    totalTasks: 2,
    threshold: 0.8,
    message: 'Effort reporting needs estimates on at least 80% of scoped tasks. 1 of 2 are estimated.',
  },
  ideal: {
    available: true,
    start: '2026-07-01',
    end: '2026-07-31',
    message: null,
  },
};

function response(report: BurnReport) {
  return Promise.resolve(new Response(JSON.stringify({ report }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('BurnReportCard', () => {
  const onTaskSelect = vi.fn();

  beforeEach(() => {
    onTaskSelect.mockReset();
    vi.stubGlobal('fetch', vi.fn(() => response(baseReport)));
  });

  it('renders responsive mobile controls and drills into remaining tasks', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(await screen.findByTestId('responsive-chart')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Progress reports' })).toHaveClass('h-64', 'sm:h-72');
    fireEvent.click(screen.getByRole('button', { name: 'Burndown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remaining (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(onTaskSelect).toHaveBeenCalledWith('task-2');
  });

  it('shows status flow and supports a custom date range', async () => {
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );
    await screen.findByTestId('responsive-chart');

    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(screen.getAllByTestId('status-area').map((area) => area.getAttribute('data-key'))).toEqual([
      'cancelled',
      'completed',
      'inProgress',
      'todo',
    ]);
    const statusTable = screen.getByRole('table', { name: 'End-of-day task counts by status' });
    expect(statusTable).toBeInTheDocument();
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header).toHaveAttribute('scope', 'col');
    }
    fireEvent.click(screen.getByRole('button', { name: 'In progress (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(onTaskSelect).toHaveBeenCalledWith('task-2');

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-07-10' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-07-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const requestUrl = new URL(String(vi.mocked(fetch).mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(requestUrl.searchParams.get('start')).toBe('2026-07-10');
    expect(requestUrl.searchParams.get('end')).toBe('2026-07-20');
  });

  it('does not enter loading state for an unchanged custom range', async () => {
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );
    await screen.findByTestId('responsive-chart');

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.queryByText('Loading progress report')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByText('Loading progress report')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requests the full bounded history for the project range', async () => {
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );

    await screen.findByTestId('responsive-chart');
    const requestUrl = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]), 'http://localhost');
    const now = new Date();
    const expectedStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    expectedStart.setUTCDate(expectedStart.getUTCDate() - 1_829);
    expect(requestUrl.searchParams.get('start')).toBe(expectedStart.toISOString().slice(0, 10));
  });

  it('includes years in chart labels for multi-year project history', async () => {
    vi.mocked(fetch).mockImplementation(() => response({
      ...baseReport,
      range: { start: '2025-03-25', end: '2026-08-08' },
      points: [{
        ...baseReport.points[0],
        date: '2025-03-25',
      }],
    }));
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(await screen.findByTestId('line-chart')).toHaveAttribute(
      'data-first-label',
      'Mar 25, 2025',
    );
  });

  it('restores the selected burn unit after viewing count-only status flow', async () => {
    const effortReport: BurnReport = {
      ...baseReport,
      mode: 'effort',
      unitLabel: 'effort points',
      effort: {
        ...baseReport.effort,
        available: true,
        coverage: 1,
        estimatedTasks: 2,
        message: null,
      },
    };
    vi.mocked(fetch).mockImplementation(() => response(effortReport));
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );
    await screen.findByTestId('responsive-chart');

    fireEvent.click(screen.getByRole('button', { name: 'Effort' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: 'Effort' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Burnup' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(screen.getByRole('button', { name: 'Effort' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('summarizes cancelled-only status without treating it as active scope', async () => {
    const cancelledReport: BurnReport = {
      ...baseReport,
      points: [{
        ...baseReport.points[0],
        total: 0,
        completed: 0,
        remaining: 0,
        todo: 0,
        inProgress: 0,
        cancelled: 1,
        completedTaskIds: [],
        remainingTaskIds: [],
        statusTaskIds: {
          todo: [],
          inProgress: [],
          done: [],
          cancelled: ['task-2'],
        },
      }],
    };
    vi.mocked(fetch).mockImplementation(() => response(cancelledReport));
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );
    await screen.findByTestId('responsive-chart');

    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(screen.getByText(/1 tracked task/)).toBeInTheDocument();
    expect(screen.getByText(/1 cancelled/)).toBeInTheDocument();
    expect(screen.queryByText(/0 completed of 0/)).not.toBeInTheDocument();
  });

  it('marks partial history and explains unavailable effort mode', async () => {
    const partialReport: BurnReport = {
      ...baseReport,
      points: [
        {
          ...baseReport.points[0],
          date: '2026-07-16',
          total: 0,
          completed: 0,
          remaining: 0,
          todo: 0,
          inProgress: 0,
          completedTaskIds: [],
          remainingTaskIds: [],
          statusTaskIds: { todo: [], inProgress: [], done: [], cancelled: [] },
        },
        { ...baseReport.points[0], date: '2026-07-17' },
      ],
      partialHistory: true,
      historicalBoundaryAt: '2026-07-15T12:00:00.000Z',
      completeFromDate: '2026-07-16',
    };
    vi.mocked(fetch).mockImplementation(() => response(partialReport));
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(await screen.findByText(/task history is only complete from/i)).toBeInTheDocument();
    expect(screen.getByTestId('reference-line')).toHaveAttribute('data-x', 'Jul 16');
    expect(screen.getByText(/Effort reporting needs estimates/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }));
    expect(await screen.findByText('Effort report unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show task count' }));
    await screen.findByTestId('responsive-chart');
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    fireEvent.click(screen.getByRole('button', { name: 'Burnup' }));
    expect(screen.getByRole('button', { name: 'Task count' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the first visible ideal point when the schedule starts before the report window', async () => {
    const reportWithOlderSchedule: BurnReport = {
      ...baseReport,
      points: [
        {
          ...baseReport.points[0],
          date: '2026-07-01',
          total: 0,
          completed: 0,
          remaining: 0,
          todo: 0,
          inProgress: 0,
          idealCompleted: 0.5,
          idealRemaining: 1.5,
          completedTaskIds: [],
          remainingTaskIds: [],
          statusTaskIds: { todo: [], inProgress: [], done: [], cancelled: [] },
        },
        { ...baseReport.points[0], date: '2026-07-02' },
      ],
      ideal: {
        available: true,
        start: '2025-01-01',
        end: '2026-07-31',
        message: null,
      },
    };
    vi.mocked(fetch).mockImplementation(() => response(reportWithOlderSchedule));
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(await screen.findByTestId('line-chart')).toHaveAttribute('data-first-date', '2026-07-01');
  });

  it('renders an empty phase state without crowding the plan', async () => {
    const emptyReport: BurnReport = {
      ...baseReport,
      scope: 'phase',
      scopeId: 'phase-1',
      scopeName: 'Design',
      points: baseReport.points.map((point) => ({
        ...point,
        total: 0,
        completed: 0,
        remaining: 0,
        completedTaskIds: [],
        remainingTaskIds: [],
      })),
      tasks: [],
    };
    vi.mocked(fetch).mockImplementation(() => response(emptyReport));
    render(
      <BurnReportCard
        projectId="project-1"
        phaseId="phase-1"
        scopeName="Design"
        embedded
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(await screen.findByText('No scoped work to chart yet')).toBeInTheDocument();
    expect(screen.getByText(/Add tasks to this phase/i)).toBeInTheDocument();
  });

  it('surfaces request errors and retries explicitly', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('History unavailable'))
      .mockImplementationOnce(() => response(baseReport));
    render(
      <BurnReportCard
        projectId="project-1"
        scopeName="Reporting"
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('History unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('responsive-chart')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
