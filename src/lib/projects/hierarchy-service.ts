import 'server-only';

import { randomUUID } from 'crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runTransaction, schema } from '@/db';
import {
  hubProjects,
  projectAutoIncludeExclusions,
  projectHierarchyCommands,
  projectHierarchyMutationContext,
  projectPhaseItems,
  projectPhases,
  taskProjects,
} from '@/db/schema';
import { getStoredTaskMutationPolicy } from '@/lib/tasks/mutation-policy';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandRequest,
  ProjectHierarchyCommandResult,
  ProjectHierarchySnapshot,
} from './hierarchy-types';
import type {
  ProjectPhase,
  ProjectPhaseItem,
  ProjectPhaseStatus,
  TaskField,
} from '@/types';

type HierarchyDatabase = BetterSQLite3Database<typeof schema>;
type TaskPlacement = Extract<ProjectHierarchyCommand, { type: 'restore_task_positions' }>['placements'][number];
type ProjectTaskState = Extract<ProjectHierarchyCommand, { type: 'restore_project_tasks' }>['states'][number];
type PhaseItemMetadata = NonNullable<
  Extract<ProjectHierarchyCommand, { type: 'move_tasks' }>['newItem']
>;
type AppliedCommand = {
  inverseCommand: ProjectHierarchyCommand;
  changed: boolean;
};

export type ProjectHierarchyActor = {
  type: 'user' | 'system' | 'ai';
  id?: string;
};

export class ProjectHierarchyServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    readonly current?: ProjectHierarchySnapshot,
  ) {
    super(message);
  }
}

function getSnapshot(
  database: HierarchyDatabase,
  projectId: string,
): ProjectHierarchySnapshot | null {
  const project = database.select({
    id: hubProjects.id,
    hierarchyRevision: hubProjects.hierarchyRevision,
  }).from(hubProjects).where(eq(hubProjects.id, projectId)).get();
  if (!project) return null;

  const phaseRows = database.select().from(projectPhases)
    .where(eq(projectPhases.projectId, projectId))
    .orderBy(asc(projectPhases.sortOrder), asc(projectPhases.createdAt), asc(projectPhases.id))
    .all();
  const phases: ProjectPhase[] = phaseRows.map((phase) => ({
    ...phase,
    status: parseProjectPhaseStatus(phase.status),
  }));
  const phaseIds = phases.map((phase) => phase.id);
  const items = phaseIds.length > 0
    ? database.select().from(projectPhaseItems)
      .where(inArray(projectPhaseItems.phaseId, phaseIds))
      .orderBy(
        asc(projectPhaseItems.phaseId),
        asc(projectPhaseItems.sortOrder),
        asc(projectPhaseItems.createdAt),
        asc(projectPhaseItems.id),
      )
      .all()
    : [];
  const phaseItemsByPhase = Object.fromEntries(
    phases.map((phase) => [
      phase.id,
      items.filter((item) => item.phaseId === phase.id),
    ]),
  );

  return {
    projectId,
    revision: project.hierarchyRevision,
    phases,
    phaseItemsByPhase,
  };
}

function parseProjectPhaseStatus(status: string): ProjectPhaseStatus {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') {
    return status;
  }
  throw new Error(`Invalid project phase status: ${status}`);
}

export function getProjectHierarchySnapshot(projectId: string): ProjectHierarchySnapshot | null {
  return runTransaction((tx) => getSnapshot(tx, projectId), { readOnly: true });
}

function requireSnapshot(database: HierarchyDatabase, projectId: string) {
  const snapshot = getSnapshot(database, projectId);
  if (!snapshot) {
    throw new ProjectHierarchyServiceError(
      'Project not found',
      404,
      'PROJECT_NOT_FOUND',
    );
  }
  return snapshot;
}

function sameRequest(
  left: ProjectHierarchyCommandRequest,
  right: ProjectHierarchyCommandRequest,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateProjectTasks(
  database: HierarchyDatabase,
  projectId: string,
  taskIds: string[],
) {
  const memberships = database.select({ taskId: taskProjects.taskId })
    .from(taskProjects)
    .where(and(
      eq(taskProjects.projectId, projectId),
      inArray(taskProjects.taskId, taskIds),
    ))
    .all();
  const membershipIds = new Set(memberships.map((membership) => membership.taskId));
  if (taskIds.some((taskId) => !membershipIds.has(taskId))) {
    throw new ProjectHierarchyServiceError(
      'Every task must belong to this project',
      404,
      'TASK_NOT_IN_PROJECT',
    );
  }
}

function taskPlacementsFromSnapshot(
  snapshot: ProjectHierarchySnapshot,
  taskIds: string[],
): TaskPlacement[] {
  return taskIds.map((taskId) => {
    for (const phase of snapshot.phases) {
      const index = snapshot.phaseItemsByPhase[phase.id]
        .findIndex((item) => item.taskId === taskId);
      if (index !== -1) {
        const item = snapshot.phaseItemsByPhase[phase.id][index];
        return {
          taskId,
          phaseId: phase.id,
          index,
          item: {
            id: item.id,
            estimatedEffortHours: item.estimatedEffortHours,
            isProposed: item.isProposed,
            proposalType: item.proposalType,
            createdAt: item.createdAt,
          },
        };
      }
    }
    return { taskId, phaseId: null, index: 0 };
  });
}

function applyTaskPlacements(
  database: HierarchyDatabase,
  projectId: string,
  placements: TaskPlacement[],
  snapshot: ProjectHierarchySnapshot,
  newItem?: PhaseItemMetadata,
): AppliedCommand {
  const taskIds = placements.map((placement) => placement.taskId);
  validateProjectTasks(database, projectId, taskIds);

  const phaseIds = new Set(snapshot.phases.map((phase) => phase.id));
  for (const placement of placements) {
    if (placement.phaseId && !phaseIds.has(placement.phaseId)) {
      throw new ProjectHierarchyServiceError(
        'Destination phase must belong to this project',
        404,
        'PHASE_NOT_IN_PROJECT',
      );
    }
  }

  const existingByTask = new Map<string, ProjectPhaseItem>();
  for (const items of Object.values(snapshot.phaseItemsByPhase)) {
    for (const item of items) {
      if (!taskIds.includes(item.taskId)) continue;
      if (existingByTask.has(item.taskId)) {
        throw new ProjectHierarchyServiceError(
          'A task is assigned to more than one phase in this project',
          409,
          'DUPLICATE_PHASE_ASSIGNMENT',
          snapshot,
        );
      }
      existingByTask.set(item.taskId, item);
    }
  }

  const inversePlacements = taskPlacementsFromSnapshot(snapshot, taskIds);
  const movedTaskIds = new Set(taskIds);
  const nextItemsByPhase = Object.fromEntries(
    snapshot.phases.map((phase) => [
      phase.id,
      snapshot.phaseItemsByPhase[phase.id].filter((item) => !movedTaskIds.has(item.taskId)),
    ]),
  ) as Record<string, ProjectPhaseItem[]>;

  const now = new Date().toISOString();
  const desiredByTask = new Map(placements.map((placement) => [placement.taskId, placement]));
  const indexedPlacements = placements.map((placement, requestIndex) => ({
    placement,
    requestIndex,
  }));
  indexedPlacements.sort((left, right) => (
    (left.placement.phaseId ?? '').localeCompare(right.placement.phaseId ?? '')
    || left.placement.index - right.placement.index
    || left.requestIndex - right.requestIndex
  ));

  for (const { placement } of indexedPlacements) {
    if (!placement.phaseId) continue;
    const destination = nextItemsByPhase[placement.phaseId];
    const existing = existingByTask.get(placement.taskId);
    const item: ProjectPhaseItem = existing
      ? { ...existing, phaseId: placement.phaseId }
      : {
          id: placement.item?.id ?? randomUUID(),
          phaseId: placement.phaseId,
          taskId: placement.taskId,
          sortOrder: 0,
          estimatedEffortHours:
            placement.item?.estimatedEffortHours ?? newItem?.estimatedEffortHours ?? null,
          isProposed: placement.item?.isProposed ?? newItem?.isProposed ?? false,
          proposalType: placement.item?.proposalType ?? newItem?.proposalType ?? null,
          createdAt: placement.item?.createdAt ?? now,
        };
    destination.splice(Math.min(placement.index, destination.length), 0, item);
  }

  const changed = snapshot.phases.some((phase) => {
    const current = snapshot.phaseItemsByPhase[phase.id];
    const next = nextItemsByPhase[phase.id];
    return current.length !== next.length
      || current.some((item, index) => (
        item.id !== next[index]?.id
        || item.taskId !== next[index]?.taskId
        || item.phaseId !== next[index]?.phaseId
        || item.sortOrder !== index
      ));
  });
  if (!changed) {
    return {
      inverseCommand: {
        type: 'restore_task_positions',
        placements: inversePlacements,
      },
      changed: false,
    };
  }

  for (const taskId of taskIds) {
    const existing = existingByTask.get(taskId);
    const desired = desiredByTask.get(taskId)!;
    if (!desired.phaseId) {
      if (existing) {
        database.delete(projectPhaseItems)
          .where(eq(projectPhaseItems.id, existing.id))
          .run();
      }
      continue;
    }

    if (existing) {
      database.update(projectPhaseItems)
        .set({ phaseId: desired.phaseId })
        .where(eq(projectPhaseItems.id, existing.id))
        .run();
    } else {
      const inserted = nextItemsByPhase[desired.phaseId]
        .find((item) => item.taskId === taskId)!;
      database.insert(projectPhaseItems).values(inserted).run();
    }
  }

  const affectedPhaseIds = new Set<string>();
  for (const placement of [...inversePlacements, ...placements]) {
    if (placement.phaseId) affectedPhaseIds.add(placement.phaseId);
  }
  for (const phaseId of affectedPhaseIds) {
    nextItemsByPhase[phaseId].forEach((item, index) => {
      database.update(projectPhaseItems)
        .set({ phaseId, sortOrder: index })
        .where(eq(projectPhaseItems.id, item.id))
        .run();
    });
  }

  return {
    inverseCommand: {
      type: 'restore_task_positions',
      placements: inversePlacements,
    },
    changed: true,
  };
}

function captureProjectTaskStates(
  database: HierarchyDatabase,
  projectId: string,
  taskIds: string[],
  snapshot: ProjectHierarchySnapshot,
): ProjectTaskState[] {
  const memberships = database.select({ taskId: taskProjects.taskId })
    .from(taskProjects)
    .where(and(
      eq(taskProjects.projectId, projectId),
      inArray(taskProjects.taskId, taskIds),
    ))
    .all();
  const exclusions = database.select({
    taskId: projectAutoIncludeExclusions.taskId,
    excludedAt: projectAutoIncludeExclusions.excludedAt,
  }).from(projectAutoIncludeExclusions)
    .where(and(
      eq(projectAutoIncludeExclusions.projectId, projectId),
      inArray(projectAutoIncludeExclusions.taskId, taskIds),
    ))
    .all();
  const memberIds = new Set(memberships.map((membership) => membership.taskId));
  const exclusionByTask = new Map(
    exclusions.map((exclusion) => [exclusion.taskId, exclusion.excludedAt]),
  );
  const placementByTask = new Map(
    taskPlacementsFromSnapshot(snapshot, taskIds)
      .map((placement) => [placement.taskId, placement]),
  );

  return taskIds.map((taskId) => {
    const placement = placementByTask.get(taskId);
    return {
      taskId,
      member: memberIds.has(taskId),
      excludedAt: exclusionByTask.get(taskId) ?? null,
      placement: placement?.phaseId ? placement : null,
    };
  });
}

function samePlacement(
  left: TaskPlacement | null,
  right: TaskPlacement | null,
) {
  return left?.phaseId === right?.phaseId
    && left?.index === right?.index
    && left?.item?.id === right?.item?.id;
}

function applyProjectTaskStates(
  database: HierarchyDatabase,
  projectId: string,
  states: ProjectTaskState[],
  snapshot: ProjectHierarchySnapshot,
  newItem?: PhaseItemMetadata,
): AppliedCommand {
  const taskIds = states.map((state) => state.taskId);
  const beforeStates = captureProjectTaskStates(database, projectId, taskIds, snapshot);
  const beforeByTask = new Map(beforeStates.map((state) => [state.taskId, state]));
  const relationshipChanged = states.some((state) => {
    const before = beforeByTask.get(state.taskId)!;
    return before.member !== state.member
      || before.excludedAt !== state.excludedAt;
  });
  const placementRequested = states.some((state) => (
    !samePlacement(beforeByTask.get(state.taskId)!.placement, state.placement)
  ));
  const inverseCommand: ProjectHierarchyCommand = {
    type: 'restore_project_tasks',
    states: beforeStates,
  };
  if (!relationshipChanged && !placementRequested) {
    return { inverseCommand, changed: false };
  }

  let placementDeleted = false;
  for (const state of states) {
    if (state.member) {
      database.insert(taskProjects).values({
        taskId: state.taskId,
        projectId,
      }).onConflictDoNothing().run();
    } else {
      const phaseIds = snapshot.phases.map((phase) => phase.id);
      if (phaseIds.length > 0) {
        const deletion = database.delete(projectPhaseItems).where(and(
          eq(projectPhaseItems.taskId, state.taskId),
          inArray(projectPhaseItems.phaseId, phaseIds),
        )).run();
        placementDeleted ||= deletion.changes > 0;
      }
      database.delete(taskProjects).where(and(
        eq(taskProjects.taskId, state.taskId),
        eq(taskProjects.projectId, projectId),
      )).run();
    }

    if (state.excludedAt) {
      database.insert(projectAutoIncludeExclusions).values({
        taskId: state.taskId,
        projectId,
        excludedAt: state.excludedAt,
      }).onConflictDoUpdate({
        target: [
          projectAutoIncludeExclusions.projectId,
          projectAutoIncludeExclusions.taskId,
        ],
        set: { excludedAt: state.excludedAt },
      }).run();
    } else {
      database.delete(projectAutoIncludeExclusions).where(and(
        eq(projectAutoIncludeExclusions.taskId, state.taskId),
        eq(projectAutoIncludeExclusions.projectId, projectId),
      )).run();
    }
  }

  const memberPlacements = states
    .filter((state) => state.member)
    .map((state) => state.placement ?? {
      taskId: state.taskId,
      phaseId: null,
      index: 0,
    });
  const placementResult = memberPlacements.length > 0
    ? applyTaskPlacements(
      database,
      projectId,
      memberPlacements,
      requireSnapshot(database, projectId),
      newItem,
    )
    : undefined;

  return {
    inverseCommand,
    changed: relationshipChanged || placementDeleted || placementResult?.changed === true,
  };
}

function applyCommand(
  database: HierarchyDatabase,
  projectId: string,
  command: ProjectHierarchyCommand,
  snapshot: ProjectHierarchySnapshot,
): AppliedCommand {
  switch (command.type) {
    case 'reorder_phases': {
      const currentIds = snapshot.phases.map((phase) => phase.id);
      if (
        command.orderedPhaseIds.length !== currentIds.length
        || command.orderedPhaseIds.some((phaseId) => !currentIds.includes(phaseId))
      ) {
        throw new ProjectHierarchyServiceError(
          'Phase order must contain every project phase exactly once',
          400,
          'INVALID_PHASE_ORDER',
        );
      }
      const changed = command.orderedPhaseIds.some(
        (phaseId, index) => phaseId !== currentIds[index],
      );
      if (!changed) {
        return {
          inverseCommand: {
            type: 'reorder_phases',
            orderedPhaseIds: currentIds,
          },
          changed: false,
        };
      }
      command.orderedPhaseIds.forEach((phaseId, index) => {
        database.update(projectPhases)
          .set({ sortOrder: index, updatedAt: new Date().toISOString() })
          .where(eq(projectPhases.id, phaseId))
          .run();
      });
      return {
        inverseCommand: {
          type: 'reorder_phases',
          orderedPhaseIds: currentIds,
        },
        changed: true,
      };
    }
    case 'move_tasks': {
      const currentPlacements = taskPlacementsFromSnapshot(snapshot, command.taskIds);
      if (
        command.fromPhaseId !== undefined
        && currentPlacements.some((placement) => placement.phaseId !== command.fromPhaseId)
      ) {
        throw new ProjectHierarchyServiceError(
          'Task placement changed before this phase operation could be applied',
          409,
          'HIERARCHY_SOURCE_CONFLICT',
          snapshot,
        );
      }
      const taskIds = command.preserveExistingPosition
        ? currentPlacements
          .filter((placement) => placement.phaseId !== command.toPhaseId)
          .map((placement) => placement.taskId)
        : command.taskIds;
      if (taskIds.length === 0) {
        return {
          inverseCommand: {
            type: 'restore_task_positions',
            placements: currentPlacements,
          },
          changed: false,
        };
      }
      const destinationLength = command.toPhaseId
        ? snapshot.phaseItemsByPhase[command.toPhaseId]?.length
        : 0;
      if (command.toPhaseId && destinationLength === undefined) {
        throw new ProjectHierarchyServiceError(
          'Destination phase must belong to this project',
          404,
          'PHASE_NOT_IN_PROJECT',
        );
      }
      const movingFromDestination = command.toPhaseId
        ? snapshot.phaseItemsByPhase[command.toPhaseId]
          .filter((item) => taskIds.includes(item.taskId)).length
        : 0;
      const boundedIndex = Math.min(
        command.toIndex,
        Math.max(0, (destinationLength ?? 0) - movingFromDestination),
      );
      return applyTaskPlacements(
        database,
        projectId,
        taskIds.map((taskId, index) => ({
          taskId,
          phaseId: command.toPhaseId,
          index: boundedIndex + index,
        })),
        snapshot,
        command.newItem,
      );
    }
    case 'restore_task_positions':
      return applyTaskPlacements(database, projectId, command.placements, snapshot);
    case 'assign_tasks': {
      const beforeStates = captureProjectTaskStates(
        database,
        projectId,
        command.taskIds,
        snapshot,
      );
      const destinationLength = command.toPhaseId
        ? snapshot.phaseItemsByPhase[command.toPhaseId]?.length
        : 0;
      if (command.toPhaseId && destinationLength === undefined) {
        throw new ProjectHierarchyServiceError(
          'Destination phase must belong to this project',
          404,
          'PHASE_NOT_IN_PROJECT',
        );
      }
      const startIndex = command.toIndex ?? destinationLength ?? 0;
      const states = beforeStates.map((state, index): ProjectTaskState => {
        let placement = state.placement;
        if (command.toPhaseId !== undefined) {
          placement = command.toPhaseId
            ? command.toIndex === undefined && state.placement?.phaseId === command.toPhaseId
              ? state.placement
              : {
                taskId: state.taskId,
                phaseId: command.toPhaseId,
                index: startIndex + index,
                item: state.placement?.item,
              }
            : null;
        }
        return {
          taskId: state.taskId,
          member: true,
          excludedAt: null,
          placement,
        };
      });
      return applyProjectTaskStates(
        database,
        projectId,
        states,
        snapshot,
        command.taskIds.length === 1 ? command.newItem : undefined,
      );
    }
    case 'remove_tasks': {
      const beforeStates = captureProjectTaskStates(
        database,
        projectId,
        command.taskIds,
        snapshot,
      );
      const excludedAt = new Date().toISOString();
      return applyProjectTaskStates(
        database,
        projectId,
        beforeStates.map((state) => state.member
          ? {
              taskId: state.taskId,
              member: false,
              excludedAt,
              placement: null,
            }
          : state),
        snapshot,
      );
    }
    case 'restore_project_tasks':
      return applyProjectTaskStates(database, projectId, command.states, snapshot);
    case 'update_phase_item': {
      const phaseItems = snapshot.phaseItemsByPhase[command.phaseId];
      if (!phaseItems) {
        throw new ProjectHierarchyServiceError(
          'Phase does not belong to this project',
          404,
          'PHASE_NOT_IN_PROJECT',
        );
      }
      const currentIndex = phaseItems.findIndex((item) => item.taskId === command.taskId);
      if (currentIndex === -1) {
        throw new ProjectHierarchyServiceError(
          'Phase item not found',
          404,
          'PHASE_ITEM_NOT_FOUND',
        );
      }
      const currentItem = phaseItems[currentIndex];
      const inverseUpdates = Object.fromEntries(
        Object.keys(command.updates).map((field) => [
          field,
          currentItem[field as keyof Pick<
            ProjectPhaseItem,
            'estimatedEffortHours' | 'isProposed' | 'proposalType'
          >],
        ]),
      ) as Extract<ProjectHierarchyCommand, { type: 'update_phase_item' }>['updates'];
      const metadataChanged = Object.entries(command.updates).some(
        ([field, value]) => currentItem[field as keyof typeof inverseUpdates] !== value,
      );
      const placementResult = command.toIndex === undefined
        ? { changed: false }
        : applyTaskPlacements(database, projectId, [{
            taskId: command.taskId,
            phaseId: command.phaseId,
            index: command.toIndex,
          }], snapshot);
      if (metadataChanged) {
        database.update(projectPhaseItems)
          .set(command.updates)
          .where(eq(projectPhaseItems.id, currentItem.id))
          .run();
      }
      return {
        inverseCommand: {
          type: 'update_phase_item',
          phaseId: command.phaseId,
          taskId: command.taskId,
          toIndex: command.toIndex === undefined ? undefined : currentIndex,
          updates: inverseUpdates,
        },
        changed: metadataChanged || placementResult.changed,
      };
    }
  }
}

function taskMutationRequirements(command: ProjectHierarchyCommand) {
  switch (command.type) {
    case 'reorder_phases':
      return [];
    case 'move_tasks':
    case 'restore_task_positions':
      return (command.type === 'move_tasks'
        ? command.taskIds
        : command.placements.map((placement) => placement.taskId))
        .map((taskId) => ({ taskId, fields: ['phases'] as const }));
    case 'assign_tasks':
      return command.taskIds.map((taskId) => ({
        taskId,
        fields: command.toPhaseId !== undefined
          ? ['projects', 'phases'] as const
          : ['projects'] as const,
      }));
    case 'remove_tasks':
      return command.taskIds.map((taskId) => ({
        taskId,
        fields: ['projects', 'phases'] as const,
      }));
    case 'restore_project_tasks':
      return command.states.map((state) => ({
        taskId: state.taskId,
        fields: ['projects', 'phases'] as const,
      }));
    case 'update_phase_item':
      return [{
        taskId: command.taskId,
        fields: ['phases'] as const,
      }];
  }
}

async function enforceMutationPolicy(command: ProjectHierarchyCommand) {
  const requirements = taskMutationRequirements(command);
  const policies = await Promise.all(
    requirements.flatMap(({ taskId, fields }) => (
      fields.map(async (field: TaskField) => ({
        taskId,
        mutation: await getStoredTaskMutationPolicy(taskId, field),
      }))
    )),
  );
  const missing = policies.find(({ mutation }) => mutation === null);
  if (missing) {
    throw new ProjectHierarchyServiceError(
      'Task not found',
      404,
      'TASK_NOT_FOUND',
    );
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

function resolveExistingCommand(
  existing: typeof projectHierarchyCommands.$inferSelect,
  input: {
    projectId: string;
    request: ProjectHierarchyCommandRequest;
  },
) {
  if (existing.projectId !== input.projectId || !sameRequest(existing.request, input.request)) {
    throw new ProjectHierarchyServiceError(
      'Command ID has already been used for a different request',
      409,
      'COMMAND_ID_CONFLICT',
    );
  }
  return existing.result;
}

export async function applyProjectHierarchyCommand(input: {
  projectId: string;
  request: ProjectHierarchyCommandRequest;
  actor?: ProjectHierarchyActor;
}): Promise<ProjectHierarchyCommandResult> {
  const committed = runTransaction((tx) => (
    tx.select().from(projectHierarchyCommands)
      .where(eq(projectHierarchyCommands.id, input.request.commandId))
      .get()
  ), { readOnly: true });
  if (committed) return resolveExistingCommand(committed, input);

  await enforceMutationPolicy(input.request.command);

  return runTransaction((tx) => {
    const existing = tx.select().from(projectHierarchyCommands)
      .where(eq(projectHierarchyCommands.id, input.request.commandId))
      .get();
    if (existing) return resolveExistingCommand(existing, input);

    const before = requireSnapshot(tx, input.projectId);
    if (before.revision !== input.request.expectedRevision) {
      throw new ProjectHierarchyServiceError(
        'Project hierarchy changed; reload the latest plan and try again',
        409,
        'HIERARCHY_REVISION_CONFLICT',
        before,
      );
    }

    tx.insert(projectHierarchyMutationContext)
      .values({ projectId: input.projectId })
      .run();
    const applied = applyCommand(
      tx,
      input.projectId,
      input.request.command,
      before,
    );
    if (!applied.changed) {
      const now = new Date().toISOString();
      tx.delete(projectHierarchyMutationContext)
        .where(eq(projectHierarchyMutationContext.projectId, input.projectId))
        .run();
      const result: ProjectHierarchyCommandResult = {
        commandId: input.request.commandId,
        revision: before.revision,
        hierarchy: before,
        inverseCommand: applied.inverseCommand,
      };
      tx.insert(projectHierarchyCommands).values({
        id: input.request.commandId,
        projectId: input.projectId,
        baseRevision: before.revision,
        resultRevision: before.revision,
        commandType: input.request.command.type,
        request: input.request,
        inverseCommand: applied.inverseCommand,
        result,
        actorType: input.actor?.type ?? 'user',
        actorId: input.actor?.id,
        createdAt: now,
      }).run();
      return result;
    }

    const nextRevision = before.revision + 1;
    const now = new Date().toISOString();
    const revisionUpdate = tx.update(hubProjects)
      .set({
        hierarchyRevision: nextRevision,
        updatedAt: now,
      })
      .where(and(
        eq(hubProjects.id, input.projectId),
        eq(hubProjects.hierarchyRevision, before.revision),
      ))
      .run();
    if (revisionUpdate.changes !== 1) {
      throw new ProjectHierarchyServiceError(
        'Project hierarchy changed; reload the latest plan and try again',
        409,
        'HIERARCHY_REVISION_CONFLICT',
        requireSnapshot(tx, input.projectId),
      );
    }
    tx.delete(projectHierarchyMutationContext)
      .where(eq(projectHierarchyMutationContext.projectId, input.projectId))
      .run();
    const hierarchy = requireSnapshot(tx, input.projectId);
    const result: ProjectHierarchyCommandResult = {
      commandId: input.request.commandId,
      revision: nextRevision,
      hierarchy,
      inverseCommand: applied.inverseCommand,
    };
    tx.insert(projectHierarchyCommands).values({
      id: input.request.commandId,
      projectId: input.projectId,
      baseRevision: before.revision,
      resultRevision: nextRevision,
      commandType: input.request.command.type,
      request: input.request,
      inverseCommand: applied.inverseCommand,
      result,
      actorType: input.actor?.type ?? 'user',
      actorId: input.actor?.id,
      createdAt: now,
    }).run();

    return result;
  });
}

function requireProjectIdForPhase(phaseId: string) {
  const phase = runTransaction((tx) => tx.select({
    projectId: projectPhases.projectId,
  }).from(projectPhases).where(eq(projectPhases.id, phaseId)).get(), { readOnly: true });
  if (!phase?.projectId) {
    throw new ProjectHierarchyServiceError(
      'Phase does not belong to a project',
      404,
      'PHASE_NOT_IN_PROJECT',
    );
  }
  return phase.projectId;
}

async function applyLatestHierarchyCommand(input: {
  projectId: string;
  command: ProjectHierarchyCommand;
  actor?: ProjectHierarchyActor;
}) {
  const snapshot = getProjectHierarchySnapshot(input.projectId);
  if (!snapshot) {
    throw new ProjectHierarchyServiceError(
      'Project not found',
      404,
      'PROJECT_NOT_FOUND',
    );
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
  const projectId = requireProjectIdForPhase(input.phaseId);
  return await applyLatestHierarchyCommand({
    projectId,
    command: {
      type: 'move_tasks',
      taskIds: input.taskIds,
      toPhaseId: input.phaseId,
      toIndex: input.toIndex,
      newItem: input.newItem,
      preserveExistingPosition: input.preserveExistingPosition,
    },
    actor: input.actor,
  });
}

export async function removeTasksFromProjectPhase(input: {
  phaseId: string;
  taskIds: string[];
  actor?: ProjectHierarchyActor;
}) {
  const projectId = requireProjectIdForPhase(input.phaseId);
  return await applyLatestHierarchyCommand({
    projectId,
    command: {
      type: 'move_tasks',
      taskIds: input.taskIds,
      toPhaseId: null,
      toIndex: 0,
      fromPhaseId: input.phaseId,
    },
    actor: input.actor,
  });
}

export async function reorderTasksInProjectPhase(input: {
  phaseId: string;
  orderedTaskIds: string[];
  actor?: ProjectHierarchyActor;
}) {
  const projectId = requireProjectIdForPhase(input.phaseId);
  return await applyLatestHierarchyCommand({
    projectId,
    command: {
      type: 'move_tasks',
      taskIds: input.orderedTaskIds,
      toPhaseId: input.phaseId,
      toIndex: 0,
      fromPhaseId: input.phaseId,
    },
    actor: input.actor,
  });
}

export async function updateProjectPhaseItem(input: {
  phaseId: string;
  taskId: string;
  toIndex?: number;
  updates: Extract<ProjectHierarchyCommand, { type: 'update_phase_item' }>['updates'];
  actor?: ProjectHierarchyActor;
}) {
  const projectId = requireProjectIdForPhase(input.phaseId);
  return await applyLatestHierarchyCommand({
    projectId,
    command: {
      type: 'update_phase_item',
      phaseId: input.phaseId,
      taskId: input.taskId,
      toIndex: input.toIndex,
      updates: input.updates,
    },
    actor: input.actor,
  });
}
