import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  TaskBlockedBadge,
  TaskStatusIndicator,
  getTaskBlockerLabel,
  isTaskBlocked,
} from '@/components/task-list/TaskStatusIndicator';

describe('TaskStatusIndicator', () => {
  it('uses a neutral outline for todo and a blue outline for in-progress tasks', () => {
    const { rerender } = render(<TaskStatusIndicator status="todo" />);
    expect(document.querySelector('[data-task-status="todo"] > span')).toHaveClass('border-[var(--border-strong)]');

    rerender(<TaskStatusIndicator status="in_progress" />);
    expect(document.querySelector('[data-task-status="in_progress"] > span')).toHaveClass('border-blue-500');
  });

  it('uses the checked treatment for completed tasks', () => {
    render(<TaskStatusIndicator status="done" />);

    const circle = document.querySelector('[data-task-status="done"] > span');
    expect(circle).toHaveClass('border-green-400', 'bg-green-400', 'text-white');
    expect(circle?.querySelector('svg')).toBeInTheDocument();
  });

  it('keeps the in-progress ring and adds an amber marker for blocked work', () => {
    render(<TaskStatusIndicator status="in_progress" microStatus="waiting_on_someone" />);

    const indicator = document.querySelector('[data-task-status="in_progress"]');
    expect(indicator).toHaveAttribute('data-task-blocked', 'true');
    expect(indicator?.firstElementChild).toHaveClass('border-blue-500');
    expect(screen.getByTestId('task-blocked-marker')).toHaveClass('bg-amber-400');
  });

  it('provides a compact blocker label for refined statuses', () => {
    render(<TaskBlockedBadge status="in_progress" microStatus="waiting_on_someone" />);

    expect(screen.getByText('Waiting on someone')).toBeInTheDocument();
    expect(isTaskBlocked('todo', 'started_but_stuck')).toBe(true);
    expect(getTaskBlockerLabel('blocked')).toBe('Blocked');
  });
});
