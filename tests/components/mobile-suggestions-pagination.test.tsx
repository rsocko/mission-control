import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileSuggestions } from '@/components/today/MobileSuggestions';
import type { SuggestionGroups, SuggestionTask } from '@/components/today/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

vi.mock('motion/react', async () => {
  const React = await import('react');

  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function MotionDiv({ children, ...props }, ref) {
      return <div {...props} ref={ref}>{children}</div>;
    },
  );
  const MotionSpan = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
    function MotionSpan({ children, ...props }, ref) {
      return <span {...props} ref={ref}>{children}</span>;
    },
  );

  return {
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
    motion: { div: MotionDiv, span: MotionSpan },
    useReducedMotion: () => true,
  };
});

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  TooltipProvider: ({ children }: React.PropsWithChildren) => children,
}));

function suggestion(index: number): SuggestionTask {
  return {
    id: `task-${index}`,
    title: `Overdue task ${index}`,
    status: 'todo',
    priority: 'medium',
    dueDate: `2026-08-${String(index).padStart(2, '0')}`,
    connectorType: 'local',
    connectorInstanceId: 'local',
    sourceListName: 'Inbox',
    localDisposition: 'active',
    taskSourceModel: 'mc-owned',
    editPolicy: editableTaskPolicy,
  };
}

function suggestionGroups(overdue: SuggestionTask[]): SuggestionGroups {
  return {
    planningSignals: [],
    planningNext: [],
    yesterday: [],
    recentlyDue: [],
    overdue,
    dueToday: [],
    dueThisWeek: [],
    highPriority: [],
    aiRecommended: [],
    recentlyAdded: [],
    carriedForward: [],
    repeatedlyRescheduled: [],
  };
}

function replanningGroups(): SuggestionGroups {
  return {
    ...suggestionGroups([]),
    planningSignals: [suggestion(1)],
  };
}

describe('MobileSuggestions pagination', () => {
  it('labels the rolling due-date group as Next 7 Days', () => {
    render(
      <MobileSuggestions
        suggestions={{
          ...suggestionGroups([]),
          dueThisWeek: [suggestion(1)],
        }}
        onAddToDay={vi.fn()}
        onSelectTask={vi.fn()}
        initialExpanded
      />,
    );

    expect(screen.getByRole('button', { name: 'Next 7 Days (1)' })).toBeTruthy();
  });

  it('keeps top suggestions visible without opening the accordion', () => {
    render(
      <MobileSuggestions
        suggestions={{
          ...suggestionGroups([]),
          aiRecommended: [suggestion(1)],
        }}
        onAddToDay={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Suggested for Today' })).toBeTruthy();
    expect(screen.getByText('Overdue task 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Suggestions \(/ })).toBeNull();
  });

  it('refills the three-item shortlist after a suggestion is added', () => {
    const candidates = [suggestion(1), suggestion(2), suggestion(3), suggestion(4)];
    const view = render(
      <MobileSuggestions
        suggestions={{
          ...suggestionGroups([]),
          aiRecommended: candidates,
        }}
        onAddToDay={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    expect(screen.getByText('Overdue task 1')).toBeTruthy();
    expect(screen.getByText('Overdue task 3')).toBeTruthy();
    expect(screen.queryByText('Overdue task 4')).toBeNull();

    view.rerender(
      <MobileSuggestions
        suggestions={{
          ...suggestionGroups([]),
          aiRecommended: candidates.slice(1),
        }}
        onAddToDay={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );

    expect(screen.queryByText('Overdue task 1')).toBeNull();
    expect(screen.getByText('Overdue task 4')).toBeTruthy();
  });

  it('offers Not today for shortlist items', () => {
    const onNotToday = vi.fn();
    render(
      <MobileSuggestions
        suggestions={{
          ...suggestionGroups([]),
          aiRecommended: [suggestion(1)],
        }}
        onAddToDay={vi.fn()}
        onNotToday={onNotToday}
        onSelectTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', {
      name: 'Hide "Overdue task 1" from today\'s suggestions',
    }));
    expect(onNotToday).toHaveBeenCalledWith('task-1');
  });

  it('shows recently due tasks as a focused recovery group', () => {
    render(
      <MobileSuggestions
        suggestions={{
          ...suggestionGroups([]),
          recentlyDue: [suggestion(2)],
        }}
        onAddToDay={vi.fn()}
        onSelectTask={vi.fn()}
        initialExpanded
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Recently Due \(1\)/ }));
    expect(screen.getByText(/due in the last 3 days/i)).toBeTruthy();
  });

  it('keeps the current page when adding a suggestion changes the task list', () => {
    const onAddToDay = vi.fn();
    const overdue = Array.from({ length: 11 }, (_, index) => suggestion(index + 1));
    const view = render(
      <MobileSuggestions
        suggestions={suggestionGroups(overdue)}
        onAddToDay={onAddToDay}
        onSelectTask={vi.fn()}
        initialExpanded
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Overdue (11)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('2 / 3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add "Overdue task 6" to My Day' }));
    expect(onAddToDay).toHaveBeenCalledWith('task-6');

    view.rerender(
      <MobileSuggestions
        suggestions={suggestionGroups(overdue.filter((task) => task.id !== 'task-6'))}
        onAddToDay={onAddToDay}
        onSelectTask={vi.fn()}
        initialExpanded
      />,
    );

    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('Overdue task 5')).toBeTruthy();
    expect(screen.queryByText('Overdue task 11')).toBeNull();
  });

  it('shows the most recently overdue tasks first and keeps the sort toggle', () => {
    render(
      <MobileSuggestions
        suggestions={suggestionGroups([suggestion(1), suggestion(3), suggestion(2)])}
        onAddToDay={vi.fn()}
        onSelectTask={vi.fn()}
        initialExpanded
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Overdue (3)' }));
    expect(screen.getByText('Due date: newest first')).toBeTruthy();

    const taskTitles = screen.getAllByText(/Overdue task \d/).map((node) => node.textContent);
    expect(taskTitles).toEqual(['Overdue task 3', 'Overdue task 2', 'Overdue task 1']);

    fireEvent.click(screen.getByRole('button', { name: 'Due date: newest first' }));
    expect(screen.getByText('Due date: oldest first')).toBeTruthy();
  });

  it('explains replanning suggestions and links to Insights', () => {
    render(
      <MobileSuggestions
        suggestions={replanningGroups()}
        onAddToDay={vi.fn()}
        onSelectTask={vi.fn()}
        initialExpanded
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'May Need Replanning (1)' }));

    expect(screen.getByText(/Tasks with recent missed commitments/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View planning friction insights' })).toHaveAttribute('href', '/insights#planning-friction');
  });
});
