import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileSwipeTaskRow } from '@/components/today/MobileSwipeTaskRow';
import type { MyDayItem } from '@/components/today/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';
import { makeTaskEditPolicy } from '../fixtures/task-edit-policy';

const motionHandlers = vi.hoisted(() => ({
  onDrag: null as null | ((event: unknown, info: { offset: { x: number } }) => void),
  onDragEnd: null as null | ((event: unknown, info: { offset: { x: number } }) => void),
}));
const triggerHaptic = vi.hoisted(() => vi.fn());
const triggerHapticFeedback = vi.hoisted(() => vi.fn());

vi.mock('@/lib/utils/haptics', () => ({
  triggerHaptic,
  triggerHapticFeedback,
}));

vi.mock('@/components/ui/CompletionBurst', () => ({
  CompletionBurst: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('motion/react', async () => {
  const ReactModule = await import('react');
  const MotionDiv = ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>(
    function MockMotionDiv(props, ref) {
      const domProps = { ...props };
      if (props.drag === 'x') {
        motionHandlers.onDrag = props.onDrag as typeof motionHandlers.onDrag;
        motionHandlers.onDragEnd = props.onDragEnd as typeof motionHandlers.onDragEnd;
      }
      delete domProps.drag;
      delete domProps.dragConstraints;
      delete domProps.dragElastic;
      delete domProps.dragMomentum;
      delete domProps.dragTransition;
      delete domProps.onDrag;
      delete domProps.onDragEnd;
      delete domProps.style;
      return <div ref={ref} {...domProps} />;
    },
  );
  return {
    motion: { div: MotionDiv },
    useMotionValue: () => 0,
    useReducedMotion: () => false,
    useTransform: () => 0,
  };
});

const item: MyDayItem = {
  id: 'day-item-1',
  taskId: 'task-1',
  order: 0,
  isAutoIncluded: false,
  addedAt: '2026-08-03T20:00:00.000Z',
  title: 'Review haptics',
  status: 'todo',
  priority: 'high',
  dueDate: null,
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListName: null,
  createdAt: '2026-08-03T19:00:00.000Z',
  tags: [],
  hasDescription: false,
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

function renderRow() {
  const props = {
    item,
    onComplete: vi.fn(),
    onRemoveFromDay: vi.fn(),
    onTap: vi.fn(),
    onScheduleTomorrow: vi.fn(),
    onSchedulePickDay: vi.fn(),
    onSnooze: vi.fn(),
  };
  render(<MobileSwipeTaskRow {...props} />);
  return props;
}

describe('MobileSwipeTaskRow haptics', () => {
  beforeEach(() => {
    motionHandlers.onDrag = null;
    motionHandlers.onDragEnd = null;
    triggerHaptic.mockReset();
    triggerHapticFeedback.mockReset();
  });

  it('emits one native defer pattern when a left swipe commits', () => {
    const { onRemoveFromDay } = renderRow();

    motionHandlers.onDrag?.({}, { offset: { x: -100 } });
    motionHandlers.onDragEnd?.({}, { offset: { x: -100 } });

    expect(triggerHaptic).toHaveBeenCalledOnce();
    expect(triggerHapticFeedback).toHaveBeenCalledOnce();
    expect(triggerHapticFeedback).toHaveBeenCalledWith('defer');
    expect(onRemoveFromDay).toHaveBeenCalledWith('task-1');
  });

  it('maps completion and snooze actions without duplicate native feedback', () => {
    const { onComplete, onSnooze } = renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'Complete Review haptics' }));
    expect(triggerHapticFeedback).toHaveBeenLastCalledWith('taskComplete');
    expect(onComplete).toHaveBeenCalledWith('task-1');

    render(
      <MobileSwipeTaskRow
        item={item}
        onComplete={onComplete}
        onRemoveFromDay={vi.fn()}
        onTap={vi.fn()}
        onScheduleTomorrow={vi.fn()}
        onSchedulePickDay={vi.fn()}
        onSnooze={onSnooze}
        scheduleTrayOpen
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Snooze for 1 hour' }).at(-1)!);

    expect(triggerHapticFeedback).toHaveBeenLastCalledWith('defer');
    expect(onSnooze).toHaveBeenCalledWith('task-1', '1hr');
    expect(triggerHapticFeedback).toHaveBeenCalledTimes(2);
  });

  it('shows the shared checked treatment while completion is in progress', () => {
    render(
      <MobileSwipeTaskRow
        item={item}
        onComplete={vi.fn()}
        onRemoveFromDay={vi.fn()}
        onTap={vi.fn()}
        onScheduleTomorrow={vi.fn()}
        onSchedulePickDay={vi.fn()}
        onSnooze={vi.fn()}
        isCompleting
      />,
    );

    const completionButton = screen.getByRole('button', { name: 'Complete Review haptics' });
    expect(completionButton).toBeDisabled();
    expect(completionButton).toHaveClass('bg-green-400', 'text-white');
    expect(completionButton.querySelector('svg')).toBeInTheDocument();
  });

  it('offers local-only mirror disposition actions in the mobile tray', () => {
    const onSetLocalDisposition = vi.fn();
    render(
      <MobileSwipeTaskRow
        item={{
          ...item,
          connectorType: 'github-issues',
          taskSourceModel: 'remote-mirror',
          editPolicy: makeTaskEditPolicy({
            sourceModel: 'remote-mirror',
            connectorEnabled: false,
          }),
        }}
        onComplete={vi.fn()}
        onRemoveFromDay={vi.fn()}
        onSetLocalDisposition={onSetLocalDisposition}
        onTap={vi.fn()}
        onScheduleTomorrow={vi.fn()}
        onSchedulePickDay={vi.fn()}
        onSnooze={vi.fn()}
        scheduleTrayOpen
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Mark handled here/i }));
    expect(onSetLocalDisposition).toHaveBeenCalledWith('task-1', 'handled');
  });
});
