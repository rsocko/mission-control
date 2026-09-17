import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskBreakdownChart } from '@/components/insights/TaskBreakdownChart';

describe('TaskBreakdownChart', () => {
  it('renders accessible priority and status counts', () => {
    render(
      <TaskBreakdownChart
        data={{
          byPriority: [
            { value: 'critical', count: 1, percentage: 25 },
            { value: 'high', count: 2, percentage: 50 },
            { value: 'medium', count: 0, percentage: 0 },
            { value: 'low', count: 1, percentage: 25 },
            { value: 'none', count: 0, percentage: 0 },
          ],
          byStatus: [
            { value: 'todo', count: 3, percentage: 75 },
            { value: 'in_progress', count: 1, percentage: 25 },
            { value: 'done', count: 0, percentage: 0 },
            { value: 'cancelled', count: 0, percentage: 0 },
          ],
        }}
      />,
    );

    const priority = screen.getByRole('region', { name: 'Open tasks by priority' });
    const status = screen.getByRole('region', { name: 'Tasks by status' });

    expect(within(priority).getByRole('img')).toHaveAccessibleName(
      'Open tasks by priority. Critical: 1, High: 2, Low: 1',
    );
    expect(within(priority).getByText('4')).toBeInTheDocument();
    expect(within(status).getByRole('img')).toHaveAccessibleName(
      'Tasks by status. To do: 3, In progress: 1',
    );
    expect(within(status).getByText('75%')).toBeInTheDocument();
  });

  it('explains empty task scopes without rendering a graph', () => {
    render(
      <TaskBreakdownChart
        data={{
          byPriority: [
            { value: 'critical', count: 0, percentage: 0 },
            { value: 'high', count: 0, percentage: 0 },
          ],
          byStatus: [
            { value: 'todo', count: 0, percentage: 0 },
            { value: 'done', count: 0, percentage: 0 },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('No tasks in this scope')).toHaveLength(2);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
