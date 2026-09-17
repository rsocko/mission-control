import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompletionTrendChart } from '@/components/insights/CompletionTrendChart';
import type { TrendDataPoint } from '@/lib/stats/insights';

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Bar: () => null,
    BarChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
      <div data-testid="bar-chart" data-point-count={data?.length}>{children}</div>
    ),
    CartesianGrid: () => null,
    ResponsiveContainer: Container,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

function dailyTrend(days: number): TrendDataPoint[] {
  return Array.from({ length: days }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    completed: index % 3,
    created: (index + 1) % 4,
  }));
}

describe('CompletionTrendChart', () => {
  it('preserves every daily data point for longer periods', () => {
    const data = dailyTrend(30);

    render(<CompletionTrendChart data={data} />);

    expect(screen.getByTestId('bar-chart')).toHaveAttribute('data-point-count', '30');
    const table = screen.getByRole('table', { name: 'Daily completed and created task counts' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(31);
    expect(within(rows[1]).getAllByRole('cell').map(cell => cell.textContent)).toEqual([
      '2026-08-01',
      '0',
      '1',
    ]);
    expect(within(rows[30]).getAllByRole('cell').map(cell => cell.textContent)).toEqual([
      '2026-08-30',
      '2',
      '2',
    ]);
  });

  it('shows a specific empty state when the period has no activity', () => {
    render(<CompletionTrendChart data={[
      { date: '2026-08-01', completed: 0, created: 0 },
      { date: '2026-08-02', completed: 0, created: 0 },
    ]} />);

    expect(screen.getByText('No tasks created or completed in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Daily completed and created task chart' })).not.toBeInTheDocument();
  });

  it('labels the visual chart for assistive technology', () => {
    render(<CompletionTrendChart data={[
      { date: '2026-08-01', completed: 2, created: 1 },
    ]} />);

    expect(screen.getByRole('img', { name: 'Daily completed and created task chart' })).toBeInTheDocument();
    expect(screen.getByText(/Green bars show completed tasks/)).toHaveClass('sr-only');
  });
});
