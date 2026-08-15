import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ModeSelector from '@/components/quick-sort/ModeSelector';
import QuickSortActions from '@/components/quick-sort/QuickSortActions';
import QuickSortCard, { getQuickSortSwipeAction } from '@/components/quick-sort/QuickSortCard';
import type { QuickSortQueueTask } from '@/lib/hooks/useQuickSortData';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

const triggerHapticFeedback = vi.hoisted(() => vi.fn());

vi.mock('@/lib/utils/haptics', () => ({
  triggerHaptic: vi.fn(),
  triggerHapticFeedback,
}));

vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({ onChange }: { onChange: (date: string) => void }) => (
    <button onClick={() => onChange('2026-08-15')}>Pick date</button>
  ),
}));

vi.mock('@/lib/utils/client-date', () => ({
  getLocalToday: () => '2026-07-30',
  getLocalTomorrow: () => '2026-07-31',
}));

vi.mock('@/components/ui/AnimatedCounter', () => ({
  AnimatedCounter: ({ value }: { value: number }) => (
    <span data-testid="animated-counter">{value}</span>
  ),
}));

const task: QuickSortQueueTask = {
  id: 'task-1',
  title: 'Plan this task',
  hasNotes: false,
  priority: 'critical',
  effort: null,
  status: 'todo',
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListId: null,
  sourceListName: null,
  dueDate: null,
  createdAt: '2026-07-30T12:00:00.000Z',
  projects: [],
  phases: [],
  tags: [],
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

describe('Quick Sort plan/schedule queue', () => {
  it('shows a launch point with the high-priority/no-date count', () => {
    const onSelect = vi.fn();
    render(
      <ModeSelector
        counts={{ no_priority: 1, no_effort: 2, no_tags: 3, no_due_date: 4 }}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Plan \/ Schedule/i }));

    expect(screen.getByText('P0 and P1 tasks without a due date')).toBeDefined();
    expect(screen.getAllByTestId('animated-counter').map((counter) => counter.textContent))
      .toEqual(['1', '2', '3', '4']);
    expect(onSelect).toHaveBeenCalledWith('no_due_date');
  });

  it('marks the active desktop queue as selected', () => {
    render(
      <ModeSelector
        counts={{ no_priority: 1, no_effort: 2, no_tags: 3, no_due_date: 4 }}
        onSelect={vi.fn()}
        selectedMode="no_effort"
      />,
    );

    expect(screen.getByRole('button', { name: /Estimate Effort/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Set Priority/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables empty queues and all queues during an in-flight update', () => {
    const { rerender } = render(
      <ModeSelector
        counts={{ no_priority: 1, no_effort: 0, no_tags: 3, no_due_date: 4 }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Estimate Effort/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Set Priority/i })).toBeEnabled();

    rerender(
      <ModeSelector
        counts={{ no_priority: 1, no_effort: 2, no_tags: 3, no_due_date: 4 }}
        onSelect={vi.fn()}
        disabled
      />,
    );

    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true);
  });

  it('offers today, tomorrow, and custom due-date actions', () => {
    const onApplyDueDate = vi.fn();
    render(
      <QuickSortActions
        task={task}
        mode="no_due_date"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyDueDate={onApplyDueDate}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick date' }));

    expect(onApplyDueDate.mock.calls).toEqual([
      ['2026-07-30'],
      ['2026-07-31'],
      ['2026-08-15'],
    ]);
  });

  it('keeps View task left of the primary completion actions', () => {
    const onViewTask = vi.fn();
    render(
      <QuickSortActions
        task={task}
        mode="no_due_date"
        onViewTask={onViewTask}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyDueDate={vi.fn()}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    const actionLabels = screen.getAllByRole('button').map((button) => button.textContent?.trim());
    expect(actionLabels.slice(-3)).toEqual(['View', 'Done', 'Skip']);
    fireEvent.click(screen.getByRole('button', { name: 'View task' }));
    expect(onViewTask).toHaveBeenCalledOnce();
  });

  it('maps priority and completion actions to semantic haptics', () => {
    const props = {
      task,
      onViewTask: vi.fn(),
      onSkip: vi.fn(),
      onMarkDone: vi.fn(),
      onSetLocalDisposition: vi.fn(),
      onApplyPriority: vi.fn(),
      onApplyEffort: vi.fn(),
      onApplyTag: vi.fn(),
      onApplyDueDate: vi.fn(),
      allTags: [],
      tagsLoading: false,
      recentTagIds: [],
      busy: false,
    };
    const { rerender } = render(<QuickSortActions {...props} mode="no_priority" />);

    fireEvent.click(screen.getByText('Critical').closest('button')!);
    rerender(<QuickSortActions {...props} mode="no_due_date" />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(triggerHapticFeedback.mock.calls).toEqual([
      ['priority'],
      ['taskComplete'],
    ]);
  });

  it('keeps Scout actions editable in Quick Sort', () => {
    const onApplyPriority = vi.fn();
    render(
      <QuickSortActions
        task={{ ...task, connectorType: 'scout', editPolicy: makeTaskEditPolicy({ sourceModel: 'ingested' }) }}
        mode="no_priority"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyPriority={onApplyPriority}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyDueDate={vi.fn()}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByText('High').closest('button')!);
    expect(onApplyPriority).toHaveBeenCalledWith('high');
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('explains blocked mirror actions without blocking task viewing', () => {
    const blockedReason = 'Priority is controlled by the upstream task source';
    const onSetLocalDisposition = vi.fn();
    render(
      <QuickSortActions
        task={{
          ...task,
          connectorType: 'github-issues',
          editPolicy: makeTaskEditPolicy({
            sourceModel: 'remote-mirror',
            reasons: { priority: blockedReason, status: 'Status is controlled by the upstream task source' },
          }),
        }}
        mode="no_priority"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={onSetLocalDisposition}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyDueDate={vi.fn()}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    expect(screen.getByText('High').closest('button')).toBeDisabled();
    expect(screen.getByText('High').closest('button')).toHaveAttribute('title', blockedReason);
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'View task' })).toBeEnabled();
    expect(screen.getByText('Mission Control only. The upstream task is unchanged.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Mark handled here/i }));
    expect(onSetLocalDisposition).toHaveBeenCalledWith('handled');
  });

  it('shows compact task context without rendering note contents', () => {
    render(
      <QuickSortCard
        task={{
          ...task,
          hasNotes: true,
          projects: [{ id: 'project-1', name: 'Launch '.repeat(30), color: '#6366f1' }],
          phases: [{ id: 'phase-1', name: 'Delivery '.repeat(30), projectId: 'project-1' }],
        }}
        mode="no_priority"
        stackIndex={0}
        onAcceptSuggestions={vi.fn()}
        onAcceptFocused={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByText(/Launch/)).toHaveClass('truncate');
    expect(screen.getByText(/Delivery/)).toHaveClass('truncate');
    expect(screen.getByText('Has notes')).toBeDefined();
    expect(screen.getByText(/Created/)).toHaveAttribute('title', `Created ${task.createdAt}`);
  });

  it('scrolls overflowing card content within the available card height', () => {
    render(
      <QuickSortCard
        task={{ ...task, title: 'A '.repeat(200) }}
        mode="no_priority"
        stackIndex={0}
        onAcceptSuggestions={vi.fn()}
        onAcceptFocused={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    const content = screen.getByRole('heading', { level: 2 }).parentElement;
    expect(content).toHaveClass('min-h-0', 'overflow-y-auto', 'overscroll-contain', 'touch-pan-y');
    expect(content).toHaveAttribute('tabindex', '0');
    expect(content).toHaveAttribute('aria-label', 'Task details');
  });

  it('treats swipe up as a skip gesture without changing horizontal swipe actions', () => {
    expect(getQuickSortSwipeAction({
      axis: 'y',
      offsetX: 0,
      offsetY: -120,
      velocityX: 0,
      velocityY: 0,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    })).toBe('skip');

    expect(getQuickSortSwipeAction({
      axis: 'x',
      offsetX: -120,
      offsetY: -160,
      velocityX: 0,
      velocityY: 0,
      hasSuggestions: true,
      hasFocusedSuggestion: false,
    })).toBe('acceptSuggestions');

    expect(getQuickSortSwipeAction({
      axis: 'y',
      offsetX: 0,
      offsetY: -40,
      velocityX: 0,
      velocityY: 0,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    })).toBe('snapBack');
  });
});
