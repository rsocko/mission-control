import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MobileTriageFocus from '@/components/triage/mobile/MobileTriageFocus';
import type { TriageActionRecord, TriageItem } from '@/types';

const motionState = vi.hoisted(() => ({
  dragEnd: null as null | ((event: unknown, info: { offset: { x: number; y: number } }) => void),
  reduced: false,
  starts: [] as Array<Record<string, unknown>>,
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const triggerHapticFeedback = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

vi.mock('motion/react', async () => {
  const ReactModule = await import('react');
  const MotionDiv = ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>(
    function MockMotionDiv(props, ref) {
      const domProps = { ...props };
      const onDragEnd = domProps.onDragEnd;
      delete domProps.animate;
      delete domProps.drag;
      delete domProps.dragElastic;
      delete domProps.dragSnapToOrigin;
      delete domProps.onDragEnd;
      delete domProps.style;
      if (props.role === 'article') {
        motionState.dragEnd = onDragEnd as typeof motionState.dragEnd;
      }
      return <div ref={ref} {...domProps} />;
    },
  );

  return {
    motion: { div: MotionDiv },
    useAnimationControls: () => ({
      start: async (target: Record<string, unknown>) => {
        motionState.starts.push(target);
      },
    }),
    useMotionValue: (initial: number) => ({
      get: () => initial,
      set: vi.fn(),
    }),
    useReducedMotion: () => motionState.reduced,
    useTransform: () => 0,
  };
});

vi.mock('@/lib/utils/haptics', () => ({
  triggerHaptic: vi.fn(),
  triggerHapticFeedback,
}));

function makeItem(): TriageItem {
  return {
    id: 'item-1',
    sourcePlatform: 'github',
    sourceId: 'source-1',
    sourceUrl: 'https://example.com/item-1',
    title: 'Review swipe reliability',
    description: 'Exercise mobile triage gestures.',
    contentType: 'repo',
    capturedAt: '2026-08-03T18:00:00.000Z',
    ingestedAt: '2026-08-03T18:01:00.000Z',
    status: 'pending',
    aiCategories: [],
    aiSuggestedActions: [],
    aiRelevanceScore: 90,
    aiUrgency: 'time_sensitive',
    rawMetadata: {},
    actionsTaken: [],
  };
}

function makeSecondItem(): TriageItem {
  return {
    ...makeItem(),
    id: 'item-2',
    sourceId: 'source-2',
    sourceUrl: 'https://example.com/item-2',
    title: 'Review another gesture',
  };
}

function actionRecord(actionType: TriageActionRecord['actionType']): TriageActionRecord {
  return {
    id: `action-${actionType}`,
    actionType,
    appliedAt: '2026-08-03T20:00:00.000Z',
  };
}

async function swipe(offset: { x: number; y: number }) {
  await act(async () => {
    motionState.dragEnd?.({}, { offset });
    await Promise.resolve();
    await Promise.resolve();
  });
}

type ActionHandler = (
  id: string,
  actionType: TriageActionRecord['actionType'],
) => Promise<TriageActionRecord | null>;

function renderFocus(
  onAction: ReturnType<typeof vi.fn<ActionHandler>> = vi.fn(async (_id, actionType) =>
    actionRecord(actionType)),
  onUndoAction = vi.fn(async () => true),
  busyAction: string | null = null,
) {
  render(
    <MobileTriageFocus
      items={[makeItem(), makeSecondItem()]}
      onAction={onAction}
      onUndoAction={onUndoAction}
      busyAction={busyAction}
      loading={false}
    />,
  );
  return { onAction, onUndoAction };
}

describe('MobileTriageFocus swipe gestures', () => {
  beforeEach(() => {
    motionState.dragEnd = null;
    motionState.reduced = false;
    motionState.starts = [];
    toastSuccess.mockReset();
    toastError.mockReset();
    triggerHapticFeedback.mockReset();
  });

  it.each([
    ['right', { x: 151, y: 0 }, 'complete_action', 'Done', 'taskComplete'],
    ['left', { x: -151, y: 0 }, 'dismiss', 'Dismissed', 'delete'],
    ['up', { x: 0, y: -101 }, 'snooze', 'Snoozed', 'defer'],
  ] as const)('dispatches one %s swipe with an undo path', async (
    _direction,
    offset,
    actionType,
    label,
    haptic,
  ) => {
    const { onAction, onUndoAction } = renderFocus();

    await swipe(offset);

    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith('item-1', actionType, { showSuccessToast: false });
    expect(triggerHapticFeedback).toHaveBeenCalledWith(haptic);
    expect(toastSuccess).toHaveBeenCalledWith(label, expect.objectContaining({
      action: expect.objectContaining({ label: 'Undo' }),
      duration: 5000,
    }));

    const toastOptions = toastSuccess.mock.calls[0][1];
    await act(async () => {
      await toastOptions.action.onClick();
    });
    expect(onUndoAction).toHaveBeenCalledWith('item-1', actionRecord(actionType));
  });

  it('locks duplicate swipe dispatches until the first action settles', async () => {
    let resolveAction: ((record: TriageActionRecord) => void) | undefined;
    const onAction = vi.fn(() => new Promise<TriageActionRecord>((resolve) => {
      resolveAction = resolve;
    }));
    renderFocus(onAction);

    motionState.dragEnd?.({}, { offset: { x: 151, y: 0 } });
    motionState.dragEnd?.({}, { offset: { x: 151, y: 0 } });
    expect(onAction).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledOnce();

    await act(async () => {
      resolveAction?.(actionRecord('complete_action'));
      await Promise.resolve();
    });
  });

  it('does not dispatch while another action is busy', async () => {
    const { onAction } = renderFocus(undefined, undefined, 'dismiss');
    await swipe({ x: 151, y: 0 });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('snaps below-threshold gestures back without mutation', async () => {
    const { onAction } = renderFocus();
    await swipe({ x: 150, y: -100 });

    expect(onAction).not.toHaveBeenCalled();
    expect(motionState.starts).toContainEqual(expect.objectContaining({ x: 0, y: 0, opacity: 1 }));
  });

  it('restores the card when an action fails', async () => {
    const onAction = vi.fn(async () => null);
    renderFocus(onAction);
    await swipe({ x: -151, y: 0 });

    expect(onAction).toHaveBeenCalledOnce();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(motionState.starts.at(-1)).toEqual(expect.objectContaining({ x: 0, y: 0, opacity: 1 }));
  });

  it('unlocks and restores the card when an action rejects', async () => {
    const onAction = vi.fn()
      .mockRejectedValueOnce(new Error('Action unavailable'))
      .mockResolvedValueOnce(actionRecord('dismiss'));
    renderFocus(onAction);

    await swipe({ x: -151, y: 0 });
    await swipe({ x: -151, y: 0 });

    expect(toastError).toHaveBeenCalledWith('Action unavailable');
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('removes transition duration for reduced motion without changing the action', async () => {
    motionState.reduced = true;
    const { onAction } = renderFocus();
    await swipe({ x: 0, y: -101 });

    expect(onAction).toHaveBeenCalledWith('item-1', 'snooze', { showSuccessToast: false });
    expect(motionState.starts[0]).toEqual(expect.objectContaining({
      y: -400,
      transition: { duration: 0 },
    }));
  });

  it('uses the current iOS action labels', () => {
    renderFocus();
    expect(screen.getAllByText('Dismiss')).not.toHaveLength(0);
    expect(screen.getAllByText('Snooze')).not.toHaveLength(0);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it.each([
    ['ArrowRight', 'complete_action'],
    ['ArrowLeft', 'dismiss'],
    ['ArrowUp', 'snooze'],
  ] as const)('supports %s as a keyboard swipe equivalent', async (key, actionType) => {
    const { onAction } = renderFocus();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('article'), { key });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith('item-1', actionType, { showSuccessToast: false });
  });

  it('celebrates only after the final action succeeds', async () => {
    const props = {
      onAction: vi.fn(async () => actionRecord('complete_action')),
      onUndoAction: vi.fn(async () => true),
      busyAction: null,
      loading: false,
    };
    render(<MobileTriageFocus {...props} items={[makeItem()]} />);

    await swipe({ x: 151, y: 0 });

    expect(triggerHapticFeedback).toHaveBeenCalledOnce();
    expect(triggerHapticFeedback).toHaveBeenCalledWith('triageComplete');
  });

  it('does not celebrate when the final action fails', async () => {
    render(
      <MobileTriageFocus
        items={[makeItem()]}
        onAction={vi.fn(async () => null)}
        onUndoAction={vi.fn(async () => true)}
        busyAction={null}
        loading={false}
      />,
    );

    await swipe({ x: 151, y: 0 });

    expect(triggerHapticFeedback).not.toHaveBeenCalled();
  });

  it('does not celebrate an initially empty session', () => {
    render(
      <MobileTriageFocus
        items={[]}
        onAction={vi.fn()}
        onUndoAction={vi.fn()}
        busyAction={null}
        loading={false}
      />,
    );
    expect(triggerHapticFeedback).not.toHaveBeenCalled();
    expect(triggerHapticFeedback).not.toHaveBeenCalled();
  });
});
