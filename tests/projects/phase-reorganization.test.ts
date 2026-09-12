import { describe, expect, it } from 'vitest';
import {
  normalizePhaseReorganizationProposal,
  type PhaseReorganizationProposal,
} from '@/lib/projects/phase-reorganization';
import { planProjectHierarchyCommand } from '@/lib/projects/hierarchy-transitions';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import type { ProjectPhase, ProjectPhaseItem } from '@/types';

const NOW = '2026-09-12T20:00:00.000Z';

function phase(id: string, name: string, sortOrder: number): ProjectPhase {
  return {
    id,
    projectId: 'project-1',
    name,
    description: null,
    status: 'pending',
    color: '#3b82f6',
    estimatedDays: null,
    targetStart: null,
    targetEnd: null,
    startAfterPhaseId: null,
    sortOrder,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function item(phaseId: string, taskId: string, sortOrder: number): ProjectPhaseItem {
  return {
    id: `item-${taskId}`,
    phaseId,
    taskId,
    sortOrder,
    estimatedEffortHours: null,
    isProposed: false,
    proposalType: null,
    createdAt: NOW,
  };
}

function snapshot(): ProjectHierarchySnapshot {
  return {
    projectId: 'project-1',
    revision: 4,
    phases: [
      phase('phase-large', 'Launch', 0),
      phase('phase-maintenance', 'Maintenance', 1),
    ],
    phaseItemsByPhase: {
      'phase-large': [
        item('phase-large', 'task-one', 0),
        item('phase-large', 'task-two', 1),
        item('phase-large', 'task-three', 2),
      ],
      'phase-maintenance': [item('phase-maintenance', 'task-four', 0)],
    },
  };
}

describe('phase reorganization proposals', () => {
  it('allows only source tasks and recovers omissions into the source phase', () => {
    const proposal = normalizePhaseReorganizationProposal({
      recommendation: 'reorganize',
      overallReasoning: 'Separate maintenance from launch work.',
      destinations: [
        {
          kind: 'existing',
          phaseId: 'phase-maintenance',
          taskIds: ['task-two', 'task-four'],
          reasoning: 'Maintenance work',
        },
        {
          kind: 'new',
          phaseId: null,
          name: 'Launch follow-up',
          taskIds: ['task-three', 'task-three'],
          reasoning: 'Follow-up work',
        },
      ],
    }, snapshot(), 'phase-large');

    expect(proposal.destinations).toEqual([
      expect.objectContaining({
        phaseId: 'phase-large',
        taskIds: ['task-one'],
      }),
      expect.objectContaining({
        phaseId: 'phase-maintenance',
        taskIds: ['task-two'],
      }),
      expect.objectContaining({
        kind: 'new',
        name: 'Launch follow-up',
        taskIds: ['task-three'],
      }),
    ]);
  });

  it('falls back to keeping the phase when the model response is unusable', () => {
    const proposal = normalizePhaseReorganizationProposal(
      null,
      snapshot(),
      'phase-large',
    );

    expect(proposal.recommendation).toBe('keep');
    expect(proposal.destinations).toEqual([
      expect.objectContaining({
        phaseId: 'phase-large',
        taskIds: ['task-one', 'task-two', 'task-three'],
      }),
    ]);
  });
});

describe('atomic phase structure replacement', () => {
  it('creates a phase, moves tasks, and produces an inverse snapshot command', () => {
    const before = snapshot();
    const created = phase('phase-follow-up', 'Launch follow-up', 1);
    const maintenance = { ...before.phases[1], sortOrder: 2 };
    const proposal: PhaseReorganizationProposal = {
      sourcePhaseId: 'phase-large',
      hierarchyRevision: 4,
      recommendation: 'reorganize',
      overallReasoning: 'Split follow-up work.',
      destinations: [],
    };
    expect(proposal.recommendation).toBe('reorganize');

    const plan = planProjectHierarchyCommand({
      snapshot: before,
      taskStates: ['task-one', 'task-two', 'task-three', 'task-four'].map((taskId) => ({
        taskId,
        member: true,
        excludedAt: null,
      })),
      command: {
        type: 'replace_phase_structure',
        phases: [before.phases[0], created, maintenance],
        placements: [
          { taskId: 'task-one', phaseId: 'phase-large', index: 0 },
          { taskId: 'task-two', phaseId: 'phase-large', index: 1 },
          { taskId: 'task-three', phaseId: 'phase-follow-up', index: 0 },
          { taskId: 'task-four', phaseId: 'phase-maintenance', index: 0 },
        ],
      },
      now: NOW,
      newItemId: () => 'unused-item-id',
    });

    expect(plan.changed).toBe(true);
    expect(plan.mutations).toContainEqual({ kind: 'insert_phase', phase: created });
    expect(plan.mutations).toContainEqual(expect.objectContaining({
      kind: 'move_phase_item',
      itemId: 'item-task-three',
      phaseId: 'phase-follow-up',
    }));
    expect(plan.inverseCommand).toEqual({
      type: 'replace_phase_structure',
      phases: before.phases,
      placements: [
        expect.objectContaining({ taskId: 'task-one', phaseId: 'phase-large', index: 0 }),
        expect.objectContaining({ taskId: 'task-two', phaseId: 'phase-large', index: 1 }),
        expect.objectContaining({ taskId: 'task-three', phaseId: 'phase-large', index: 2 }),
        expect.objectContaining({ taskId: 'task-four', phaseId: 'phase-maintenance', index: 0 }),
      ],
    });
  });
});
