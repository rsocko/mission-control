import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FlowInsightsSection } from '@/components/insights/FlowInsightsSection';
import type { FlowInsightsResult } from '@/lib/stats/flow-query';

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Area: Container,
    AreaChart: Container,
    Bar: Container,
    BarChart: Container,
    CartesianGrid: Container,
    Legend: Container,
    ResponsiveContainer: Container,
    Tooltip: Container,
    XAxis: Container,
    YAxis: Container,
  };
});

const data: FlowInsightsResult = {
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-31T00:00:00.000Z',
  generatedAt: '2026-08-01T00:00:00.000Z',
  historicalBoundaryAt: '2026-07-10T00:00:00.000Z',
  partialHistory: true,
  cycleTime: {
    count: 1,
    excludedWithoutStart: 2,
    medianDays: 4,
    averageDays: 4,
    percentile85Days: 4,
    reworkedCount: 1,
    distribution: [{ label: '4-7 days', count: 1, minDays: 3, maxDays: 7 }],
    items: [{
      taskId: 'cycle-1',
      title: 'Reworked cycle',
      startedAt: '2026-07-11T00:00:00.000Z',
      completedAt: '2026-07-15T00:00:00.000Z',
      days: 4,
      reworkCount: 1,
    }],
  },
  cumulativeFlow: {
    dimension: 'normalized_status',
    points: [{
      date: '2026-07-15',
      todo: 2,
      inProgress: 1,
      done: 3,
      cancelled: 0,
      knownTasks: 6,
      coverage: 'complete',
    }],
  },
  agingWip: {
    count: 2,
    excludedWithoutEntry: 1,
    medianAgeDays: 8,
    staleCount: 1,
    staleThresholdDays: 14,
    buckets: [{ label: '8-14 days', count: 2, minDays: 8, maxDays: 15 }],
    items: [
      {
        taskId: 'oldest',
        title: 'Oldest active task',
        status: 'in_progress',
        enteredAt: '2026-07-01T00:00:00.000Z',
        ageDays: 31,
        stale: true,
        priority: 'high',
        source: 'github',
      },
      {
        taskId: 'newer',
        title: 'Newer active task',
        status: 'in_progress',
        enteredAt: '2026-07-25T00:00:00.000Z',
        ageDays: 7,
        stale: false,
        priority: 'low',
        source: 'local',
      },
    ],
  },
  filterOptions: {
    projects: [{ id: 'project-1', name: 'Mission Control', color: '#00aaff' }],
    sources: ['', 'github', 'local'],
    priorities: ['high', 'low'],
    statuses: ['in_progress'],
  },
};

const filters = {
  projectId: '',
  source: '',
  priority: '',
  status: '',
  staleDays: '14',
};

describe('FlowInsightsSection', () => {
  it('defines each report, surfaces partial history, and orders aging drill-through oldest first', () => {
    render(<FlowInsightsSection data={data} filters={filters} onFilterChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Work movement and bottlenecks' })).toBeInTheDocument();
    expect(screen.getByText(/First recorded entry into In progress/)).toBeInTheDocument();
    expect(screen.getByText(/Current In progress tasks aged from their latest recorded entry/)).toBeInTheDocument();
    expect(screen.getByText(/End-of-day task counts reconstructed/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Partial history');

    const agingLinks = screen.getAllByRole('link').filter(link => (
      link.textContent === 'Oldest active task' || link.textContent === 'Newer active task'
    ));
    expect(agingLinks.map(link => link.textContent)).toEqual([
      'Oldest active task',
      'Newer active task',
    ]);
    expect(agingLinks[0]).toHaveAttribute('href', '/?taskId=oldest');
  });

  it('emits filter changes from accessible controls', () => {
    const onFilterChange = vi.fn();
    render(<FlowInsightsSection data={data} filters={filters} onFilterChange={onFilterChange} />);

    fireEvent.click(screen.getByLabelText('Project'));
    fireEvent.click(screen.getByRole('option', { name: 'Mission Control' }));
    const staleInput = screen.getByLabelText('Stale threshold in days');
    fireEvent.change(staleInput, { target: { value: '21' } });
    fireEvent.blur(staleInput);

    expect(onFilterChange).toHaveBeenCalledWith('projectId', 'project-1');
    expect(onFilterChange).toHaveBeenCalledWith('staleDays', '21');
  });

  it('renders explicit empty states', () => {
    const emptyData: FlowInsightsResult = {
      ...data,
      partialHistory: false,
      cycleTime: { ...data.cycleTime, count: 0, items: [] },
      cumulativeFlow: { ...data.cumulativeFlow, points: [] },
      agingWip: { ...data.agingWip, count: 0, items: [] },
    };
    render(<FlowInsightsSection data={emptyData} filters={filters} onFilterChange={vi.fn()} />);

    expect(screen.getByText(/No completed tasks have both a recorded start/)).toBeInTheDocument();
    expect(screen.getByText(/No active tasks have a recorded entry/)).toBeInTheDocument();
    expect(screen.getByText(/No recorded task state is available/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Source'));
    expect(screen.getByRole('option', { name: 'github' })).toBeInTheDocument();
  });

  it('clamps stale thresholds and represents unavailable CFD values consistently', () => {
    const onFilterChange = vi.fn();
    const unavailableData: FlowInsightsResult = {
      ...data,
      cumulativeFlow: {
        ...data.cumulativeFlow,
        points: [{
          ...data.cumulativeFlow.points[0],
          knownTasks: 0,
          coverage: 'unavailable',
        }],
      },
    };
    render(<FlowInsightsSection data={unavailableData} filters={filters} onFilterChange={onFilterChange} />);

    const staleInput = screen.getByLabelText('Stale threshold in days');
    fireEvent.change(staleInput, { target: { value: '400' } });
    fireEvent.blur(staleInput);
    expect(onFilterChange).toHaveBeenCalledWith('staleDays', '365');

    expect(screen.getByText(/No recorded task state is available/)).toBeInTheDocument();
    const table = screen.getByRole('table', {
      name: 'Cumulative flow end-of-day counts by normalized task status',
    });
    expect(within(table).getAllByText('-')).toHaveLength(4);
    expect(within(table).getByText('unavailable')).toBeInTheDocument();
  });

  it('shows exclusion warnings for unknown recorded entries', () => {
    render(<FlowInsightsSection data={data} filters={filters} onFilterChange={vi.fn()} />);

    expect(screen.getByText('2 completed tasks excluded because no start transition was recorded.'))
      .toBeInTheDocument();
    expect(screen.getByText('1 active task excluded because current-state entry predates recorded history.'))
      .toBeInTheDocument();
  });
});
