import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanAlignmentChart } from '@/components/insights/PlanAlignmentChart';
import type { PlanAlignmentInsights } from '@/lib/stats/insights';

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Bar: () => null,
    CartesianGrid: () => null,
    ComposedChart: Container,
    Line: () => null,
    ResponsiveContainer: Container,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

const data: PlanAlignmentInsights = {
  points: [{
    date: '2026-08-10',
    committed: 5,
    plannedCompleted: 3,
    unplannedCompleted: 2,
    carryover: 2,
  }],
  totals: {
    committed: 5,
    plannedCompleted: 3,
    unplannedCompleted: 2,
    carryover: 2,
  },
  planCoverage: 60,
  commitmentRate: 60,
};

describe('PlanAlignmentChart', () => {
  it('shows plan quality metrics and an accessible daily table', () => {
    render(<PlanAlignmentChart data={data} />);

    expect(screen.getByText('Plan Alignment')).toBeInTheDocument();
    expect(screen.getAllByText('60%')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Daily plan alignment chart' })).toBeInTheDocument();
    expect(screen.getByRole('table', {
      name: 'Daily My Day commitments, completions, and carryover',
    })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2026-08-10' })).toBeInTheDocument();
  });

  it('explains when neither planning nor completion activity exists', () => {
    render(<PlanAlignmentChart data={{
      points: [{ date: '2026-08-10', committed: 0, plannedCompleted: 0, unplannedCompleted: 0, carryover: 0 }],
      totals: { committed: 0, plannedCompleted: 0, unplannedCompleted: 0, carryover: 0 },
      planCoverage: 0,
      commitmentRate: 0,
    }} />);

    expect(screen.getByText('No My Day commitments or task completions in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Daily plan alignment chart' })).not.toBeInTheDocument();
  });
});
