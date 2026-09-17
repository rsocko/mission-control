import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhaseReorganizationReview } from '@/components/projects/PhaseReorganizationReview';
import type { PhaseReorganizationProposal } from '@/lib/projects/phase-reorganization';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';

const { executeProjectHierarchyCommand, loadProjectHierarchy } = vi.hoisted(() => ({
  executeProjectHierarchyCommand: vi.fn(),
  loadProjectHierarchy: vi.fn(),
}));

vi.mock('@/lib/projects/hierarchy-client', () => ({
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
}));

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const proposal: PhaseReorganizationProposal = {
  sourcePhaseId: 'phase-large',
  hierarchyRevision: 8,
  recommendation: 'reorganize',
  overallReasoning: 'Separate follow-up work.',
  destinations: [
    {
      kind: 'existing',
      phaseId: 'phase-large',
      name: 'Launch',
      description: '',
      color: '#3b82f6',
      estimatedDays: 3,
      taskIds: ['task-one'],
      reasoning: 'Core launch work stays here.',
    },
    {
      kind: 'new',
      phaseId: null,
      name: 'Launch follow-up',
      description: 'Post-launch work',
      color: '#3b82f6',
      estimatedDays: 2,
      taskIds: ['task-two'],
      reasoning: 'This work follows launch.',
    },
  ],
};

describe('PhaseReorganizationReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', { randomUUID: () => 'phase-new' });
    loadProjectHierarchy.mockResolvedValue({
      projectId: 'project-1',
      revision: 8,
      phases: [{
        id: 'phase-large',
        projectId: 'project-1',
        name: 'Launch',
        description: null,
        status: 'pending',
        color: '#3b82f6',
        estimatedDays: 3,
        targetStart: null,
        targetEnd: null,
        startAfterPhaseId: null,
        sortOrder: 0,
        completedAt: null,
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      }],
      phaseItemsByPhase: {
        'phase-large': [
          {
            id: 'item-one',
            phaseId: 'phase-large',
            taskId: 'task-one',
            sortOrder: 0,
            estimatedEffortHours: null,
            isProposed: false,
            proposalType: null,
            createdAt: '2026-09-12T00:00:00.000Z',
          },
          {
            id: 'item-two',
            phaseId: 'phase-large',
            taskId: 'task-two',
            sortOrder: 1,
            estimatedEffortHours: null,
            isProposed: false,
            proposalType: null,
            createdAt: '2026-09-12T00:00:00.000Z',
          },
        ],
      },
    } satisfies ProjectHierarchySnapshot);
    executeProjectHierarchyCommand.mockResolvedValue({});
  });

  it('applies selected destinations through one atomic hierarchy command', async () => {
    const onAccept = vi.fn();
    render(
      <PhaseReorganizationReview
        proposal={proposal}
        projectId="project-1"
        taskMap={new Map([
          ['task-one', { id: 'task-one', title: 'Launch core' }],
          ['task-two', { id: 'task-two', title: 'Write follow-up' }],
        ])}
        isOpen
        onAccept={onAccept}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByText('Proposed result:').parentElement)
      .toHaveTextContent('1 task move into 1 new phase.');
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }));

    await waitFor(() => expect(executeProjectHierarchyCommand).toHaveBeenCalledTimes(1));
    expect(executeProjectHierarchyCommand).toHaveBeenCalledWith({
      projectId: 'project-1',
      expectedRevision: 8,
      command: expect.objectContaining({
        type: 'replace_phase_structure',
        phases: [
          expect.objectContaining({ id: 'phase-large', sortOrder: 0 }),
          expect.objectContaining({ id: 'phase-new', name: 'Launch follow-up', sortOrder: 1 }),
        ],
        placements: [
          expect.objectContaining({ taskId: 'task-one', phaseId: 'phase-large', index: 0 }),
          expect.objectContaining({ taskId: 'task-two', phaseId: 'phase-new', index: 0 }),
        ],
      }),
    });
    expect(onAccept).toHaveBeenCalled();
  });
});
