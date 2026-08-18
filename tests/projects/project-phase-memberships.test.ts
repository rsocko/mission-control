import { describe, expect, it } from 'vitest';
import { syncTaskPhaseMemberships } from '@/app/projects/[id]/utils';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import type { ProjectTaskViewModel as ProjectTask } from '@/app/projects/[id]/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const task: ProjectTask = {
  id: 'task-1',
  title: 'Task',
  status: 'todo',
  priority: 'none',
  updatedAt: '2026-08-03T00:00:00.000Z',
  connectorType: 'local',
  connectorInstanceId: 'local',
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
  hubProjectIds: ['project-1'],
  projectPhaseMemberships: [{
    projectId: 'project-1',
    projectName: 'Website',
    phaseId: 'phase-old',
    phaseName: 'Old phase',
  }, {
    projectId: 'project-2',
    projectName: 'Mobile app',
    phaseId: 'phase-mobile',
    phaseName: 'Build',
  }],
};

function snapshot(phaseId: string | null): ProjectHierarchySnapshot {
  const phases: ProjectHierarchySnapshot['phases'] = phaseId
    ? [{
        id: phaseId,
        projectId: 'project-1',
        name: 'New phase',
        description: null,
        status: 'pending',
        color: null,
        estimatedDays: null,
        targetStart: null,
        targetEnd: null,
        startAfterPhaseId: null,
        sortOrder: 0,
        completedAt: null,
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:00:00.000Z',
      }]
    : [];
  return {
    projectId: 'project-1',
    revision: 2,
    phases,
    phaseItemsByPhase: phaseId
      ? {
          [phaseId]: [{
            id: 'item-1',
            phaseId,
            taskId: 'task-1',
            sortOrder: 0,
            estimatedEffortHours: null,
            isProposed: false,
            proposalType: null,
            createdAt: '2026-08-03T00:00:00.000Z',
          }],
        }
      : {},
  };
}

describe('syncTaskPhaseMemberships', () => {
  it('updates phase indicators from command, drag, bulk, and undo snapshots', () => {
    const moved = syncTaskPhaseMemberships([task], snapshot('phase-new'));
    expect(moved[0].projectPhaseMemberships).toContainEqual({
      projectId: 'project-1',
      projectName: 'Website',
      phaseId: 'phase-new',
      phaseName: 'New phase',
    });
    expect(moved[0].projectPhaseMemberships).toContainEqual({
      projectId: 'project-2',
      projectName: 'Mobile app',
      phaseId: 'phase-mobile',
      phaseName: 'Build',
    });

    const unphased = syncTaskPhaseMemberships(moved, snapshot(null));
    expect(unphased[0].projectPhaseMemberships).toContainEqual({
      projectId: 'project-1',
      projectName: 'Website',
      phaseId: null,
      phaseName: null,
    });
  });
});
