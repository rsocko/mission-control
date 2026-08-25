import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ModeSelector from '@/components/quick-sort/ModeSelector';
import QuickSortActions from '@/components/quick-sort/QuickSortActions';
import QuickSortCard, {
  getQuickSortGestureAxis,
  getQuickSortSwipeAction,
  resolveQuickSortGestureAxis,
} from '@/components/quick-sort/QuickSortCard';
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
  planningHorizon: null,
  createdAt: '2026-07-30T12:00:00.000Z',
  projects: [],
  phases: [],
  tags: [],
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

describe('Quick Sort planning horizon queue', () => {
  it('shows a launch point for tasks without a planning horizon', () => {
    const onSelect = vi.fn();
    render(
      <ModeSelector
        counts={{ no_priority: 1, quadrant: 1, no_effort: 2, no_tags: 3, no_planning_horizon: 4 }}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Set Time Horizon/i }));

    expect(screen.getByText('Tasks not yet placed in Next, Soon, Later, or Someday')).toBeDefined();
    expect(screen.getAllByTestId('animated-counter').map((counter) => counter.textContent))
      .toEqual(['1', '1', '2', '3', '4']);
    expect(onSelect).toHaveBeenCalledWith('no_planning_horizon');
  });

  it('marks the active desktop queue as selected', () => {
    render(
      <ModeSelector
        counts={{ no_priority: 1, quadrant: 1, no_effort: 2, no_tags: 3, no_planning_horizon: 4 }}
        onSelect={vi.fn()}
        selectedMode="no_effort"
      />,
    );

    expect(screen.getByRole('button', { name: /Estimate Effort/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Pick Quadrant/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables empty queues and all queues during an in-flight update', () => {
    const { rerender } = render(
      <ModeSelector
        counts={{ no_priority: 1, quadrant: 1, no_effort: 0, no_tags: 3, no_planning_horizon: 4 }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Estimate Effort/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Pick Quadrant/i })).toBeEnabled();

    rerender(
      <ModeSelector
        counts={{ no_priority: 1, quadrant: 1, no_effort: 2, no_tags: 3, no_planning_horizon: 4 }}
        onSelect={vi.fn()}
        disabled
      />,
    );

    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true);
  });

  it('offers all planning horizon actions', () => {
    const onApplyPlanningHorizon = vi.fn();
    render(
      <QuickSortActions
        task={task}
        mode="no_planning_horizon"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyQuadrant={vi.fn()}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyPlanningHorizon={onApplyPlanningHorizon}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Someday' }));

    expect(screen.getByRole('button', { name: 'Next' })).toHaveClass('text-emerald-400');
    expect(screen.getByRole('button', { name: 'Soon' })).toHaveClass('text-blue-400');
    expect(screen.getByRole('button', { name: 'Later' })).toHaveClass('text-violet-400');
    expect(screen.getByRole('button', { name: 'Someday' })).toHaveClass('text-slate-400');
    expect(onApplyPlanningHorizon.mock.calls).toEqual([
      ['next'],
      ['soon'],
      ['later'],
      ['someday'],
    ]);
  });

  it('applies safe quadrant actions and confirms elimination', () => {
    const onApplyQuadrant = vi.fn();
    render(
      <QuickSortActions
        task={task}
        mode="quadrant"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyQuadrant={onApplyQuadrant}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyPlanningHorizon={vi.fn()}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Do first/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick date' }));
    fireEvent.click(screen.getByRole('button', { name: /Delegate/i }));
    fireEvent.click(screen.getByRole('button', { name: /Eliminate/i }));

    expect(screen.getByRole('alertdialog', { name: 'Confirm eliminate task' })).toBeInTheDocument();
    expect(onApplyQuadrant.mock.calls).toEqual([
      ['do_first'],
      ['schedule', '2026-08-15'],
      ['delegate'],
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Eliminate' }));
    expect(onApplyQuadrant).toHaveBeenLastCalledWith('eliminate');
  });

  it('keeps direct priority assignment as a separate action', () => {
    const onApplyPriority = vi.fn();
    render(
      <QuickSortActions
        task={task}
        mode="no_priority"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyQuadrant={vi.fn()}
        onApplyPriority={onApplyPriority}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyPlanningHorizon={vi.fn()}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /P1 High/i }));

    expect(onApplyPriority).toHaveBeenCalledWith('high');
    expect(screen.queryByRole('button', { name: /Do first/i })).not.toBeInTheDocument();
  });

  it('keeps View task left of the primary completion actions', () => {
    const onViewTask = vi.fn();
    render(
      <QuickSortActions
        task={task}
        mode="no_planning_horizon"
        onViewTask={onViewTask}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyQuadrant={vi.fn()}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyPlanningHorizon={vi.fn()}
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

  it('maps quadrant and completion actions to semantic haptics', () => {
    triggerHapticFeedback.mockClear();
    const onApplyQuadrant = vi.fn();
    const props = {
      task,
      onViewTask: vi.fn(),
      onSkip: vi.fn(),
      onMarkDone: vi.fn(),
      onSetLocalDisposition: vi.fn(),
      onApplyQuadrant,
      onApplyPriority: vi.fn(),
      onApplyEffort: vi.fn(),
      onApplyTag: vi.fn(),
      onApplyPlanningHorizon: vi.fn(),
      allTags: [],
      tagsLoading: false,
      recentTagIds: [],
      busy: false,
    };
    const { rerender } = render(<QuickSortActions {...props} mode="quadrant" />);

    fireEvent.click(screen.getByRole('button', { name: /Do first/i }));
    rerender(<QuickSortActions {...props} mode="no_planning_horizon" />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(triggerHapticFeedback.mock.calls).toEqual([
      ['priority'],
      ['taskComplete'],
    ]);
    expect(onApplyQuadrant).toHaveBeenCalledWith('do_first');
  });

  it('keeps Scout actions editable in Quick Sort', () => {
    const onApplyQuadrant = vi.fn();
    render(
      <QuickSortActions
        task={{ ...task, connectorType: 'scout', editPolicy: makeTaskEditPolicy({ sourceModel: 'ingested' }) }}
        mode="quadrant"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={vi.fn()}
        onApplyQuadrant={onApplyQuadrant}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyPlanningHorizon={vi.fn()}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Do first/i }));
    expect(onApplyQuadrant).toHaveBeenCalledWith('do_first');
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
        mode="quadrant"
        onViewTask={vi.fn()}
        onSkip={vi.fn()}
        onMarkDone={vi.fn()}
        onSetLocalDisposition={onSetLocalDisposition}
        onApplyQuadrant={vi.fn()}
        onApplyPriority={vi.fn()}
        onApplyEffort={vi.fn()}
        onApplyTag={vi.fn()}
        onApplyPlanningHorizon={vi.fn()}
        allTags={[]}
        tagsLoading={false}
        recentTagIds={[]}
        busy={false}
      />,
    );

    expect(screen.getByRole('button', { name: /Do first/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Do first/i })).toHaveAttribute('title', blockedReason);
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

  it('keeps overflowing card content constrained within the available card height', () => {
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
    expect(screen.getByTestId('quick-sort-swipe-handle')).toHaveClass('h-11', 'touch-none');
  });

  it('resolves a flick axis at gesture end when no pan frame locked one', () => {
    // A fast flick can end before Motion flushes a pan frame, leaving the axis unlocked.
    expect(resolveQuickSortGestureAxis(null, 4, -140)).toBe('y');
    expect(resolveQuickSortGestureAxis(null, -140, 6)).toBe('x');

    // The fallback must not relax the travel or dominance rules.
    expect(resolveQuickSortGestureAxis(null, 0, -8)).toBeNull();
    expect(resolveQuickSortGestureAxis(null, 40, -38)).toBeNull();

    // An axis locked during the drag still wins over the final offsets.
    expect(resolveQuickSortGestureAxis('x', 20, -200)).toBe('x');
    expect(resolveQuickSortGestureAxis('y', -200, 20)).toBe('y');

    expect(getQuickSortSwipeAction({
      axis: resolveQuickSortGestureAxis(null, 4, -140),
      offsetX: 4,
      offsetY: -140,
      velocityX: 0,
      velocityY: -900,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    })).toBe('skip');
  });

  it('requires meaningful, directionally dominant travel before committing gestures', () => {
    expect(getQuickSortGestureAxis(8, -9)).toBeNull();
    expect(getQuickSortGestureAxis(40, -38)).toBeNull();
    expect(getQuickSortGestureAxis(-60, 20)).toBe('x');
    expect(getQuickSortGestureAxis(20, -60)).toBe('y');

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
      axis: 'y',
      offsetX: 0,
      offsetY: 0,
      velocityX: 0,
      velocityY: -600,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    })).toBe('snapBack');

    expect(getQuickSortSwipeAction({
      axis: 'y',
      offsetX: 8,
      offsetY: -60,
      velocityX: 0,
      velocityY: -600,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    })).toBe('skip');

    expect(getQuickSortSwipeAction({
      axis: 'x',
      offsetX: -120,
      offsetY: -40,
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

    expect(getQuickSortSwipeAction({
      axis: 'y',
      offsetX: 90,
      offsetY: -110,
      velocityX: 0,
      velocityY: -700,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    })).toBe('snapBack');
  });

  it('treats swipe down as undo only when operation history is available', () => {
    const gesture = {
      axis: 'y' as const,
      offsetX: 0,
      offsetY: 120,
      velocityX: 0,
      velocityY: 0,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    };

    expect(getQuickSortSwipeAction({ ...gesture, hasUndo: true })).toBe('undo');
    expect(getQuickSortSwipeAction({ ...gesture, hasUndo: false })).toBe('snapBack');
  });

  it('blocks skip gestures during updates and routes policy-blocked skips to feedback', () => {
    const gesture = {
      axis: 'y' as const,
      offsetX: 0,
      offsetY: -120,
      velocityX: 0,
      velocityY: 0,
      hasSuggestions: false,
      hasFocusedSuggestion: false,
    };

    expect(getQuickSortSwipeAction({ ...gesture, busy: true })).toBe('snapBack');
    expect(getQuickSortSwipeAction({ ...gesture, canSkip: false })).toBe('blockedSkip');
  });

  it('describes unavailable skip gestures and disables the handle while busy', () => {
    const blockedReason = 'Snooze is controlled by the upstream task source';
    const { rerender } = render(
      <QuickSortCard
        task={{
          ...task,
          editPolicy: makeTaskEditPolicy({
            sourceModel: 'remote-mirror',
            mutations: { snoozedUntil: 'blocked' },
            reasons: { snoozedUntil: blockedReason },
          }),
        }}
        mode="no_priority"
        stackIndex={0}
        onAcceptSuggestions={vi.fn()}
        onAcceptFocused={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    const handle = screen.getByTestId('quick-sort-swipe-handle');
    expect(handle).toHaveAccessibleName(expect.stringContaining(`Skip unavailable. ${blockedReason}`));
    expect(handle).toHaveAttribute('title', blockedReason);

    rerender(
      <QuickSortCard
        task={task}
        mode="no_priority"
        stackIndex={0}
        onAcceptSuggestions={vi.fn()}
        onAcceptFocused={vi.fn()}
        onSkip={vi.fn()}
        busy
      />,
    );
    expect(handle).toHaveAttribute('aria-disabled', 'true');
  });
});
