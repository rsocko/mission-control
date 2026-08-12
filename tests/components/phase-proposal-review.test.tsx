import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PhaseProposalReview, {
  type PhaseProposal,
} from '@/components/projects/PhaseProposalReview';

const {
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
} = vi.hoisted(() => ({
  executeProjectHierarchyCommand: vi.fn(),
  loadProjectHierarchy: vi.fn(),
}));

vi.mock('@/lib/projects/hierarchy-client', () => ({
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => {
      const rest = { ...props };
      for (const key of ['variants', 'initial', 'animate', 'exit', 'transition', 'layout']) {
        delete rest[key];
      }
      return <div {...rest}>{children as React.ReactNode}</div>;
    },
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    loading: vi.fn(() => 'proposal-toast'),
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

const proposal: PhaseProposal = {
  phases: [{
    name: 'Next',
    description: 'Next work',
    color: '#123456',
    estimatedDays: 2,
    taskIds: ['task-1'],
    reasoning: 'Move the task',
  }],
  overallReasoning: 'A better plan',
  suggestedNewTasks: [],
  suggestedClosures: [],
};

describe('PhaseProposalReview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loadProjectHierarchy.mockResolvedValue({ revision: 7 });
    executeProjectHierarchyCommand.mockResolvedValue({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ phase: { id: 'phase-new' } }),
    }));
  });

  it('moves existing tasks through the hierarchy command instead of duplicate phase insertion', async () => {
    const onAccept = vi.fn();
    render(
      <PhaseProposalReview
        proposal={proposal}
        projectId="project-1"
        taskMap={new Map([['task-1', {
          id: 'task-1',
          title: 'Existing task',
          priority: 'medium',
          status: 'todo',
          connectorType: 'local',
        }]])}
        onAccept={onAccept}
        onReject={vi.fn()}
        isOpen
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));

    await waitFor(() => expect(executeProjectHierarchyCommand).toHaveBeenCalledWith({
      projectId: 'project-1',
      expectedRevision: 7,
      command: {
        type: 'move_tasks',
        taskIds: ['task-1'],
        toPhaseId: 'phase-new',
        toIndex: 0,
      },
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalled();
  });
});
