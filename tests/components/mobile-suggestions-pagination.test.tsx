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
    yesterday: [],
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

describe('MobileSuggestions pagination', () => {
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
    expect(screen.getByText('Overdue task 7')).toBeTruthy();
    expect(screen.queryByText('Overdue task 1')).toBeNull();
  });
});
