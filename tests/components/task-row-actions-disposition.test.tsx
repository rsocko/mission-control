import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskRowActions } from '@/components/task-row/TaskRowActions';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

const BASE_PROPS = {
  dueDate: null,
  hasDescription: false,
  isInMyDay: false,
  priority: 'none',
  status: 'todo',
  editPolicy: editableTaskPolicy,
  surface: 'dashboard' as const,
  onSetDueDate: vi.fn(),
  onSetPriority: vi.fn(),
  onSetStatus: vi.fn(),
  onToggleMyDay: vi.fn(),
  onOpenNotes: vi.fn(),
};

describe('TaskRowActions remote-mirror disposition', () => {
  it('offers local-only handled and dismissed actions with upstream explanation', () => {
    const onSetLocalDisposition = vi.fn();
    render(
      <TooltipProvider>
        <TaskRowActions
          {...BASE_PROPS}
          editPolicy={makeTaskEditPolicy({ sourceModel: 'remote-mirror' })}
          localDisposition="active"
          onSetLocalDisposition={onSetLocalDisposition}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', {
      name: 'Manage read-only task in Mission Control',
    }));
    expect(screen.getByText(
      /These actions never change the upstream task's status/i,
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {
      name: /Mark handled here.*without completing the upstream task/i,
    }));
    expect(onSetLocalDisposition).toHaveBeenCalledWith('handled');
  });

  it('does not expose disposition actions for source-managed tasks', () => {
    render(
      <TooltipProvider>
        <TaskRowActions
          {...BASE_PROPS}
          editPolicy={makeTaskEditPolicy({ sourceModel: 'remote-managed' })}
          localDisposition="active"
          onSetLocalDisposition={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole('button', {
      name: 'Manage read-only task in Mission Control',
    })).not.toBeInTheDocument();
  });

  it('lets a transitioned source-managed task restore a preserved disposition', () => {
    const onSetLocalDisposition = vi.fn();
    render(
      <TooltipProvider>
        <TaskRowActions
          {...BASE_PROPS}
          editPolicy={makeTaskEditPolicy({ sourceModel: 'remote-managed' })}
          localDisposition="handled"
          onSetLocalDisposition={onSetLocalDisposition}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', {
      name: 'Restore task in Mission Control',
    }));
    expect(screen.queryByRole('button', {
      name: /Mark handled here/i,
    })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {
      name: /Keep active.*Show this task in active Mission Control views/i,
    }));
    expect(onSetLocalDisposition).toHaveBeenCalledWith('active');
  });
});
