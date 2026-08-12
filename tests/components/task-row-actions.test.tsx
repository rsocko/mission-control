import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRowActions, type TaskRowActionsProps } from '@/components/task-row/TaskRowActions';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const noop = vi.fn();

afterEach(() => {
  vi.useRealTimers();
});

function renderActions(overrides: Partial<TaskRowActionsProps> = {}) {
  const props: TaskRowActionsProps = {
    dueDate: null,
    hasDescription: false,
    isInMyDay: false,
    priority: 'none',
    status: 'todo',
    editPolicy: editableTaskPolicy,
    surface: 'dashboard',
    onSetDueDate: noop,
    onSetPriority: noop,
    onSetStatus: noop,
    onToggleMyDay: noop,
    onOpenNotes: noop,
    onSnoozeUntil: noop,
    ...overrides,
  };
  return render(<TaskRowActions {...props} />);
}

describe('TaskRowActions', () => {
  it('uses the overdue date value as the persistent trigger and clears it to null', async () => {
    const onSetDueDate = vi.fn();
    const { rerender } = renderActions();
    expect(screen.getByRole('button', { name: 'Add due date' })).toBeInTheDocument();

    rerender(
      <TaskRowActions
        dueDate="2020-08-01"
        hasDescription={false}
        isInMyDay={false}
        priority="none"
        status="todo"
        editPolicy={editableTaskPolicy}
        surface="dashboard"
        onSetDueDate={onSetDueDate}
        onSetPriority={noop}
        onSetStatus={noop}
        onToggleMyDay={noop}
        onOpenNotes={noop}
        onSnoozeUntil={noop}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Add due date' })).not.toBeInTheDocument();
    const dueDateButton = screen.getByRole('button', { name: /Change due date, currently/ });
    expect(dueDateButton).toHaveClass('text-red-400');
    fireEvent.click(dueDateButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear due date' }));
    await waitFor(() => expect(onSetDueDate).toHaveBeenCalledWith(null));
  });

  it('routes existing notes to read mode and missing notes to edit mode', () => {
    const onOpenNotes = vi.fn();
    const { rerender } = renderActions({ hasDescription: true, onOpenNotes });
    fireEvent.click(screen.getByRole('button', { name: 'Open notes' }));
    expect(onOpenNotes).toHaveBeenCalledWith('read');

    rerender(
      <TaskRowActions
        dueDate={null}
        hasDescription={false}
        isInMyDay={false}
        priority="none"
        status="todo"
        editPolicy={editableTaskPolicy}
        surface="dashboard"
        onSetDueDate={noop}
        onSetPriority={noop}
        onSetStatus={noop}
        onToggleMyDay={noop}
        onOpenNotes={onOpenNotes}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add notes' }));
    expect(onOpenNotes).toHaveBeenLastCalledWith('edit');
  });

  it('opens anchored mutation menus and applies a status selection', async () => {
    const onSetStatus = vi.fn();
    renderActions({ onSetStatus });
    fireEvent.click(screen.getByRole('button', { name: 'Set status' }));
    fireEvent.click(await screen.findByRole('button', { name: 'In Progress' }));
    await waitFor(() => expect(onSetStatus).toHaveBeenCalledWith('in_progress'));
  });

  it('uses semantic colors for actions and keeps their identity on hover', () => {
    renderActions({ priority: 'high', status: 'in_progress' });

    expect(screen.getByRole('button', { name: 'Add to My Day' })).toHaveClass(
      'text-amber-400',
      'hover:bg-amber-400/15',
      'hover:text-amber-300',
    );
    expect(screen.getByRole('button', { name: 'Add due date' })).toHaveClass(
      'text-sky-400',
      'hover:bg-sky-400/15',
      'hover:text-sky-300',
    );
    expect(screen.getByRole('button', { name: 'Add notes' })).toHaveClass(
      'text-violet-400',
      'hover:bg-violet-400/15',
      'hover:text-violet-300',
    );
    expect(screen.getByRole('button', { name: 'Snooze task' })).toHaveClass(
      'text-blue-400',
      'hover:bg-blue-400/15',
      'hover:text-blue-300',
    );
    expect(screen.getByRole('button', { name: 'Set status' })).toHaveClass(
      'text-purple-400',
      'hover:text-purple-300',
    );
    expect(screen.getByRole('button', { name: 'Set priority' })).toHaveClass(
      'text-orange-400',
      'hover:text-orange-300',
    );
  });

  it('keeps My Day amber when the task is already in My Day', () => {
    renderActions({ isInMyDay: true });

    expect(screen.getByRole('button', { name: 'Remove from My Day' })).toHaveClass(
      'text-amber-400',
      'hover:bg-amber-400/15',
      'hover:text-amber-300',
    );
  });

  it('progressively reveals inactive hover actions while keeping active actions visible', () => {
    const { rerender } = renderActions();

    expect(screen.getByRole('button', { name: 'Add to My Day' }).parentElement).toHaveClass('@min-[480px]:flex');
    expect(screen.getByRole('button', { name: 'Add due date' }).parentElement).toHaveClass('@min-[480px]:flex');
    expect(screen.getByRole('button', { name: 'Add notes' }).parentElement).toHaveClass('@min-[640px]:flex');
    expect(screen.getByRole('button', { name: 'Snooze task' }).parentElement).toHaveClass('@min-[768px]:flex');
    expect(screen.getByRole('button', { name: 'Set status' }).parentElement).toHaveClass('@min-[960px]:flex');
    expect(screen.getByRole('button', { name: 'Set priority' }).parentElement).toHaveClass('@min-[960px]:flex');

    rerender(
      <TaskRowActions
        dueDate="2026-08-08"
        hasDescription
        isInMyDay
        priority="none"
        status="todo"
        editPolicy={editableTaskPolicy}
        surface="dashboard"
        onSetDueDate={noop}
        onSetPriority={noop}
        onSetStatus={noop}
        onToggleMyDay={noop}
        onOpenNotes={noop}
        onSnoozeUntil={noop}
        snoozedUntil="2026-08-09T13:00:00.000Z"
      />,
    );

    expect(screen.getByRole('button', { name: 'Remove from My Day' }).parentElement).toHaveClass('flex');
    expect(screen.getByRole('button', { name: /^Change due date/ }).parentElement).toHaveClass('flex');
    expect(screen.getByRole('button', { name: 'Open notes' }).parentElement).toHaveClass('flex');
    expect(screen.getByRole('button', { name: 'Snooze task' }).parentElement).toHaveClass('flex');
  });

  it('keeps active My Day status and priority controls visible at narrow widths', () => {
    renderActions({
      surface: 'my-day',
      status: 'in_progress',
      priority: 'high',
      onSnoozeUntil: undefined,
    });

    expect(screen.getByRole('button', { name: 'Status: In Progress' }).parentElement).toHaveClass('flex');
    expect(screen.getByRole('button', { name: 'Priority: High' }).parentElement).toHaveClass('flex');
  });

  it('keeps actions in the same order when hover actions become persistent', () => {
    const { rerender } = renderActions();
    const actionNames = () => screen.getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
      .filter(Boolean);

    expect(actionNames()).toEqual([
      'Snooze task',
      'Add to My Day',
      'Add due date',
      'Add notes',
      'Set status',
      'Set priority',
    ]);

    rerender(
      <TaskRowActions
        dueDate="2026-08-08"
        hasDescription
        isInMyDay
        priority="none"
        status="todo"
        editPolicy={editableTaskPolicy}
        surface="dashboard"
        onSetDueDate={noop}
        onSetPriority={noop}
        onSetStatus={noop}
        onToggleMyDay={noop}
        onOpenNotes={noop}
        onSnoozeUntil={noop}
      />,
    );

    expect(actionNames()).toEqual([
      'Snooze task',
      'Remove from My Day',
      expect.stringMatching(/^Change due date, currently/),
      'Open notes',
      'Set status',
      'Set priority',
    ]);
  });

  it('caps Later today at 11:59 PM when selected after 8 PM', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T20:30:00-04:00'));
    const onSnoozeUntil = vi.fn();
    renderActions({ onSnoozeUntil });

    fireEvent.click(screen.getByRole('button', { name: 'Snooze task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Later today' }));

    expect(onSnoozeUntil).toHaveBeenCalledWith(new Date('2026-08-01T23:59:00-04:00').toISOString());
  });

  it('keeps applicable My Day state visible while disabling connector mutations', () => {
    const onToggleMyDay = vi.fn();
    renderActions({
      isInMyDay: true,
      priority: 'high',
      status: 'in_progress',
      editPolicy: makeTaskEditPolicy({
        sourceModel: 'remote-mirror',
        reasons: {
          priority: 'Priority is controlled by the upstream task source',
          status: 'Status is controlled by the upstream task source',
          dueDate: 'Due date is controlled by the upstream task source',
        },
      }),
      surface: 'my-day',
      onToggleMyDay,
      onSnoozeUntil: undefined,
    });

    expect(screen.getByRole('button', { name: 'Remove from My Day' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Priority is controlled by the upstream task source' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Status is controlled by the upstream task source' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add notes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Due date is controlled by the upstream task source' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Snooze task' })).not.toBeInTheDocument();
  });
});
