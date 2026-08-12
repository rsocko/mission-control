import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Activity } from 'react-activity-calendar';
import { ActivityHeatmap, toCalendarActivities } from '@/components/insights/ActivityHeatmap';
import type { ActivityHeatmapEntry } from '@/lib/stats/insights';

let renderedActivities: Activity[] = [];

vi.mock('react-activity-calendar', async () => {
  const React = await import('react');
  const MockActivityCalendar = React.forwardRef<HTMLElement, { data: Activity[] }>(({ data }, ref) => {
    renderedActivities = data;
    return (
      <article ref={ref}>
        <div
          ref={element => {
            if (!element) return;
            Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 600 });
          }}
          className="react-activity-calendar__scroll-container"
          data-testid="calendar-scroll"
        />
      </article>
    );
  });
  MockActivityCalendar.displayName = 'MockActivityCalendar';

  return { ActivityCalendar: MockActivityCalendar };
});

vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select
      aria-label="Heatmap color metric"
      value={value}
      onChange={event => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

const data: ActivityHeatmapEntry[] = [
  { date: '2026-07-29', taskCompletions: 0, routineCompletions: 1 },
  { date: '2026-07-30', taskCompletions: 2, routineCompletions: 2 },
  { date: '2026-07-31', taskCompletions: 4, routineCompletions: 0 },
];

describe('ActivityHeatmap', () => {
  it('builds intensity levels for each selectable metric', () => {
    expect(toCalendarActivities(data, 'tasks')).toEqual([
      { date: '2026-07-29', count: 0, level: 0 },
      { date: '2026-07-30', count: 2, level: 2 },
      { date: '2026-07-31', count: 4, level: 4 },
    ]);
    expect(toCalendarActivities(data, 'combined').map(activity => activity.count)).toEqual([1, 4, 4]);
  });

  it('switches the calendar color metric without changing its date range', () => {
    render(<ActivityHeatmap data={data} />);

    expect(screen.getByText('Rolling 12 months, independent of the period filter')).toBeInTheDocument();
    expect(renderedActivities.map(activity => activity.count)).toEqual([0, 2, 4]);

    fireEvent.change(screen.getByLabelText('Heatmap color metric'), { target: { value: 'routines' } });

    expect(renderedActivities.map(activity => activity.count)).toEqual([1, 2, 0]);
    expect(renderedActivities.map(activity => activity.date)).toEqual(data.map(entry => entry.date));
  });

  it('starts the compact calendar at the newest months', async () => {
    render(<ActivityHeatmap data={data} compact />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('calendar-scroll').scrollLeft).toBe(600);
    });
  });
});
