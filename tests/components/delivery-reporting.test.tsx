import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryTrendChart } from '@/components/insights/DeliveryTrendChart';
import { LeadTimeChart } from '@/components/insights/LeadTimeChart';
import type { DeliveryMetrics } from '@/lib/stats/insights';

vi.mock('recharts', () => {
  const Component = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Bar: Component,
    BarChart: Component,
    CartesianGrid: Component,
    ComposedChart: Component,
    Line: Component,
    LineChart: Component,
    ResponsiveContainer: Component,
    Tooltip: Component,
    XAxis: Component,
    YAxis: Component,
  };
});

const point = {
  start: '2026-07-06',
  end: '2026-07-12',
  label: 'Jul 6',
  count: 3,
  normalizedCount: 3,
  rollingAverage: 2.5,
  changePercent: 50,
  isPartial: false,
};

describe('delivery reporting charts', () => {
  it('announces zero throughput as data rather than missing data', () => {
    render(<DeliveryTrendChart throughput={{
      interval: 'week',
      total: 0,
      averagePerInterval: 0,
      points: [{ ...point, count: 0 }],
    }} />);

    expect(screen.getByText('Zero completed tasks in this period.')).toBeInTheDocument();
  });

  it('provides an accessible throughput data table', () => {
    render(<DeliveryTrendChart throughput={{
      interval: 'week',
      total: 3,
      averagePerInterval: 3,
      points: [point],
    }} />);

    expect(screen.getByRole('img', { name: 'Throughput and velocity chart' })).toBeInTheDocument();
    expect(screen.getByText('Throughput and normalized rolling velocity values')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2.5' })).toBeInTheDocument();
  });

  it('renders lead-time empty state and direct outlier drill-through', () => {
    const emptyLeadTime: DeliveryMetrics['leadTime'] = {
      summary: { count: 0, averageDays: null, medianDays: null, p85Days: null, p95Days: null },
      distribution: [],
      trend: [],
      outliers: [],
    };
    const { rerender } = render(<LeadTimeChart leadTime={emptyLeadTime} />);
    expect(screen.getByText(/No completed tasks with valid/)).toBeInTheDocument();

    rerender(<LeadTimeChart leadTime={{
      summary: { count: 1, averageDays: 12, medianDays: 12, p85Days: 12, p95Days: 12 },
      distribution: [{ label: '8-14 days', minDays: 8, maxDays: 15, count: 1 }],
      trend: [{ start: point.start, end: point.end, label: point.label, medianDays: 12, p85Days: 12, count: 1 }],
      outliers: [{ taskId: 'task/1', title: 'Slow task', leadTimeDays: 12, completedAt: '2026-07-10T00:00:00.000Z' }],
    }} />);

    expect(screen.getByRole('link', { name: /Slow task/ })).toHaveAttribute('href', '/?taskId=task%2F1');
    expect(screen.getByRole('img', { name: 'Lead-time distribution chart' })).toBeInTheDocument();
  });
});
