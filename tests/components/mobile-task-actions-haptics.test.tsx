import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileTaskActions } from '@/components/task-list/MobileTaskActions';
import type { TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type { TaskEditPolicy } from '@/types';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

const triggerHapticFeedback = vi.hoisted(() => vi.fn());

vi.mock('@/lib/utils/haptics', () => ({
  triggerHapticFeedback,
}));

vi.mock('@/components/ui/MobileSheet', () => ({
  MobileSheet: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

function makeActions(): TaskContextMenuActions {
  return {
    onComplete: vi.fn(),
    onSetPriority: vi.fn(),
    onDueToday: vi.fn(),
    onDueTomorrow: vi.fn(),
    onPickDate: vi.fn(),
    onDelete: vi.fn(),
  };
}

function renderActions(actions: TaskContextMenuActions, editPolicy: TaskEditPolicy = editableTaskPolicy) {
  return render(
    <MobileTaskActions
      isOpen
      onClose={vi.fn()}
      task={{
        id: 'task-1',
        title: 'Review native feedback',
        status: 'todo',
        priority: 'none',
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceId: null,
        dueDate: null,
        localDisposition: 'active',
        taskSourceModel: 'mc-owned',
        editPolicy,
      }}
      actions={actions}
    />,
  );
}

describe('MobileTaskActions haptics', () => {
  beforeEach(() => {
    triggerHapticFeedback.mockReset();
  });

  it('maps complete, priority, and delete actions to semantic feedback', () => {
    const actions = makeActions();
    renderActions(actions);

    fireEvent.click(screen.getByRole('button', { name: 'Mark as completed' }));
    fireEvent.click(screen.getByRole('button', { name: /Set priority/ }));
    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));

    expect(triggerHapticFeedback.mock.calls).toEqual([
      ['taskComplete'],
      ['priority'],
      ['delete'],
    ]);
    expect(actions.onComplete).toHaveBeenCalledOnce();
    expect(actions.onSetPriority).toHaveBeenCalledWith('high');
    expect(actions.onDelete).toHaveBeenCalledOnce();
  });

  it('disables source-owned mobile actions with the field-specific reason', () => {
    const statusReason = 'Status is controlled by the upstream task source';
    const actions = makeActions();
    renderActions(actions, makeTaskEditPolicy({
      sourceModel: 'remote-mirror',
      reasons: { status: statusReason },
      removalReason: 'Mirrored tasks must be handled or dismissed in Mission Control',
    }));

    const completeButton = screen.getByRole('button', { name: 'Mark as completed' });
    expect(completeButton).toBeDisabled();
    expect(completeButton).toHaveAttribute('title', statusReason);
    fireEvent.click(completeButton);
    expect(actions.onComplete).not.toHaveBeenCalled();
  });
});
