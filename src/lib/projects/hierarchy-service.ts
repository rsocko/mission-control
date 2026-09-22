import 'server-only';

import { randomUUID } from 'crypto';
import {
  ProjectHierarchyServiceError,
  resolveCommittedProjectHierarchyCommand,
  type ProjectHierarchyActor,
  type ProjectHierarchyPersistence,
} from '@/db/persistence/project-hierarchy';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getStoredTaskMutationPolicy } from '@/lib/tasks/mutation-policy';
import { projectHierarchyMutationRequirements } from './hierarchy-transitions';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandRequest,
  ProjectHierarchyCommandResult,
  ProjectHierarchySnapshot,
} from './hierarchy-types';
import type { ProjectPhaseItem, TaskField } from '@/types';

type PhaseItemMetadata = NonNullable<
  Extract<ProjectHierarchyCommand, { type: 'move_tasks' }>['newItem']
>;

export { ProjectHierarchyServiceError };
export type { ProjectHierarchyActor };

/**
 * Backend-neutral orchestration for the project-hierarchy command boundary.
 * Every read and mutation is delegated to the selected worker composition's
 * `projectAutomation.hierarchy` adapter; this module owns no driver, SQL,
 * transaction, or backend selection.
 */
async function hierarchyRepository(): Promise<ProjectHierarchyPersistence> {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.projectAutomation.hierarchy;
}

export async function getProjectHierarchySnapshot(
  projectId: string,
): Promise<ProjectHierarchySnapshot | null> {
  return (await hierarchyRepository()).getSnapshot(projectId);
}

export async function listProjectPhaseItems(
  phaseId: string,
): Promise<ProjectPhaseItem[]> {
  return (await hierarchyRepository()).listPhaseItems(phaseId);
}

export async function findProjectPhaseItemTaskId(
  phaseId: string,
  itemId: string,
): Promise<string | null> {
  return (await hierarchyRepository()).findPhaseItemTask(phaseId, itemId);
}

async function enforceMutationPolicy(command: ProjectHierarchyCommand) {
  const policies = await Promise.all(
    projectHierarchyMutationRequirements(command).flatMap(({ taskId, fields }) => (
      fields.map(async (field: TaskField) => ({
        taskId,
        mutation: await getStoredTaskMutationPolicy(taskId, field),
      }))
    )),
  );
  const missing = policies.find(({ mutation }) => mutation === null);
  if (missing) {
    throw new ProjectHierarchyServiceError('Task not found', 404, 'TASK_NOT_FOUND');
  }
  const blocked = policies.find(({ mutation }) => mutation?.policy.mutation === 'blocked');
  if (blocked?.mutation) {
    throw new ProjectHierarchyServiceError(
      blocked.mutation.policy.reason
        ?? 'Project placement cannot be changed for this task source',
      403,
      'TASK_MUTATION_BLOCKED',
    );
  }
}

export async function applyProjectHierarchyCommand(input: {
  projectId: string;
  request: ProjectHierarchyCommandRequest;
  actor?: ProjectHierarchyActor;
}): Promise<ProjectHierarchyCommandResult> {
  const hierarchy = await hierarchyRepository();

  // Replay is resolved before the task-source policy preflight so an already
  // committed command keeps returning its original result even after a later
  // policy change; the adapter repeats this check inside its transaction.
  const committed = await hierarchy.findCommittedCommand(input.request.commandId);
  if (committed) return resolveCommittedProjectHierarchyCommand(committed, input);

  await enforceMutationPolicy(input.request.command);

  return hierarchy.applyAuthorizedCommand({
    projectId: input.projectId,
    request: input.request,
    actor: input.actor,
  });
}

async function requireProjectIdForPhase(phaseId: string): Promise<string> {
  const projectId = await (await hierarchyRepository()).findPhaseProjectId(phaseId);
  if (!projectId) {
    throw new ProjectHierarchyServiceError(
      'Phase does not belong to a project',
      404,
      'PHASE_NOT_IN_PROJECT',
    );
  }
  return projectId;
}

async function applyLatestHierarchyCommand(input: {
  projectId: string;
  command: ProjectHierarchyCommand;
  actor?: ProjectHierarchyActor;
}) {
  const snapshot = await getProjectHierarchySnapshot(input.projectId);
  if (!snapshot) {
    throw new ProjectHierarchyServiceError('Project not found', 404, 'PROJECT_NOT_FOUND');
  }
  return await applyProjectHierarchyCommand({
    projectId: input.projectId,
    request: {
      commandId: randomUUID(),
      expectedRevision: snapshot.revision,
      command: input.command,
    },
    actor: input.actor,
  });
}

async function applyLatestPhaseCommand(input: {
  phaseId: string;
  command: ProjectHierarchyCommand;
  actor?: ProjectHierarchyActor;
}) {
  return await applyLatestHierarchyCommand({
    projectId: await requireProjectIdForPhase(input.phaseId),
    command: input.command,
    actor: input.actor,
  });
}

export async function assignTasksToProject(input: {
  projectId: string;
  taskIds: string[];
  phaseId?: string | null;
  toIndex?: number;
  newItem?: PhaseItemMetadata;
  actor?: ProjectHierarchyActor;
}) {
  return await applyLatestHierarchyCommand({
    projectId: input.projectId,
    command: {
      type: 'assign_tasks',
      taskIds: input.taskIds,
      toPhaseId: input.phaseId,
      toIndex: input.toIndex,
      newItem: input.newItem,
    },
    actor: input.actor,
  });
}

export async function removeTasksFromProject(input: {
  projectId: string;
  taskIds: string[];
  actor?: ProjectHierarchyActor;
}) {
  return await applyLatestHierarchyCommand({
    projectId: input.projectId,
    command: {
      type: 'remove_tasks',
      taskIds: input.taskIds,
    },
    actor: input.actor,
  });
}

export async function placeTasksInProjectPhase(input: {
  phaseId: string;
  taskIds: string[];
  toIndex: number;
  newItem?: PhaseItemMetadata;
  preserveExistingPosition?: boolean;
  actor?: ProjectHierarchyActor;
}) {
  return await applyLatestPhaseCommand({
    phaseId: input.phaseId,
    actor: input.actor,
    command: {
      type: 'move_tasks',
      taskIds: input.taskIds,
      toPhaseId: input.phaseId,
      toIndex: input.toIndex,
      newItem: input.newItem,
      preserveExistingPosition: input.preserveExistingPosition,
    },
  });
}

export async function removeTasksFromProjectPhase(input: {
  phaseId: string;
  taskIds: string[];
  actor?: ProjectHierarchyActor;
}) {
  return await applyLatestPhaseCommand({
    phaseId: input.phaseId,
    actor: input.actor,
    command: {
      type: 'move_tasks',
      taskIds: input.taskIds,
      toPhaseId: null,
      toIndex: 0,
      fromPhaseId: input.phaseId,
    },
  });
}

export async function reorderTasksInProjectPhase(input: {
  phaseId: string;
  orderedTaskIds: string[];
  actor?: ProjectHierarchyActor;
}) {
  return await applyLatestPhaseCommand({
    phaseId: input.phaseId,
    actor: input.actor,
    command: {
      type: 'move_tasks',
      taskIds: input.orderedTaskIds,
      toPhaseId: input.phaseId,
      toIndex: 0,
      fromPhaseId: input.phaseId,
    },
  });
}

export async function updateProjectPhaseItem(input: {
  phaseId: string;
  taskId: string;
  toIndex?: number;
  updates: Extract<ProjectHierarchyCommand, { type: 'update_phase_item' }>['updates'];
  actor?: ProjectHierarchyActor;
}) {
  return await applyLatestPhaseCommand({
    phaseId: input.phaseId,
    actor: input.actor,
    command: {
      type: 'update_phase_item',
      phaseId: input.phaseId,
      taskId: input.taskId,
      toIndex: input.toIndex,
      updates: input.updates,
    },
  });
}
