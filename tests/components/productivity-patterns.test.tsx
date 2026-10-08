import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductivityPatterns } from '@/components/insights/ProductivityPatterns';
import type { ProductivityInsights } from '@/lib/stats/insights';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

const data: ProductivityInsights = {
  periodStart: '2026-09-11',
  periodEnd: '2026-09-17',
  timeZone: 'America/New_York',
  hourly: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    taskCompletions: hour === 10 ? 5 : 0,
  })),
  weekdays: [
    { day: 1, label: 'Mon', taskCompletions: 2, routineCompletions: 1, total: 3 },
    { day: 2, label: 'Tue', taskCompletions: 5, routineCompletions: 2, total: 7 },
    { day: 3, label: 'Wed', taskCompletions: 1, routineCompletions: 0, total: 1 },
    { day: 4, label: 'Thu', taskCompletions: 0, routineCompletions: 1, total: 1 },
    { day: 5, label: 'Fri', taskCompletions: 0, routineCompletions: 0, total: 0 },
    { day: 6, label: 'Sat', taskCompletions: 0, routineCompletions: 0, total: 0 },
    { day: 0, label: 'Sun', taskCompletions: 0, routineCompletions: 0, total: 0 },
  ],
  timeliness: {
    onTime: 6,
    late: 2,
    withoutDueDate: 3,
    onTimeRate: 75,
  },
  comparisons: [
    {
      period: 'week',
      current: { tasks: 8, routines: 4, total: 12 },
      previous: { tasks: 5, routines: 3, total: 8 },
      changePercent: 50,
    },
    {
      period: 'month',
      current: { tasks: 20, routines: 10, total: 30 },
      previous: { tasks: 24, routines: 11, total: 35 },
      changePercent: -14,
    },
  ],
};

describe('ProductivityPatterns', () => {
  it('presents time, timeliness, weekday, and comparison insights together', () => {
    render(<ProductivityPatterns data={data} />);

    expect(screen.getByRole('region', { name: 'Productivity patterns' })).toBeInTheDocument();
    expect(screen.getByRole('img', {
      name: 'Hourly task completion curve. Peak hour 10a with 5 completions.',
    })).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('6 on time · 2 late · 3 without due dates')).toBeInTheDocument();
    expect(screen.getByText('This week')).toBeInTheDocument();
    expect(screen.getByText('50% vs prior')).toBeInTheDocument();
    expect(screen.getByText('Strongest day')).toHaveTextContent('Tue');
  });

  it('shows an honest empty state when no tasks have completion times or due dates', () => {
    render(
      <ProductivityPatterns
        data={{
          ...data,
          hourly: data.hourly.map(entry => ({ ...entry, taskCompletions: 0 })),
          timeliness: { onTime: 0, late: 0, withoutDueDate: 0, onTimeRate: null },
        }}
      />,
    );

    expect(screen.getByText('Complete tasks to reveal your focus curve')).toBeInTheDocument();
    expect(screen.getByText('No due-dated completions in this period')).toBeInTheDocument();
  });
});
