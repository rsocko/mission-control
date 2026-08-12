import 'server-only';

import { randomUUID } from 'crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runTransaction, schema } from '@/db';
import {
  hubProjects,
  projectHierarchyCommands,
  projectHierarchyMutationContext,
  projectPhaseItems,
  projectPhases,
  taskProjects,
} from '@/db/schema';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandRequest,
  ProjectHierarchyCommandResult,
  ProjectHierarchySnapshot,
} from './hierarchy-types';
import type { ProjectPhase, ProjectPhaseItem, ProjectPhaseStatus } from '@/types';

type HierarchyDatabase = BetterSQLite3Database<typeof schema>;
type TaskPlacement = Extract<ProjectHierarchyCommand, { type: 'restore_task_positions' }>['placements'][number];

export type ProjectHierarchyActor = {
  type: 'user' | 'system' | 'ai';
  id?: string;
};

export class ProjectHierarchyServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
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
      if (index !== -1) return { taskId, phaseId: phase.id, index };
    }
    return { taskId, phaseId: null, index: 0 };
  });
}

function applyTaskPlacements(
  database: HierarchyDatabase,
  projectId: string,
  placements: TaskPlacement[],
  snapshot: ProjectHierarchySnapshot,
): ProjectHierarchyCommand {
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
          id: randomUUID(),
          phaseId: placement.phaseId,
          taskId: placement.taskId,
          sortOrder: 0,
          estimatedEffortHours: null,
          isProposed: false,
          proposalType: null,
          createdAt: now,
        };
    destination.splice(Math.min(placement.index, destination.length), 0, item);
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
    type: 'restore_task_positions',
    placements: inversePlacements,
  };
}

function applyCommand(
  database: HierarchyDatabase,
  projectId: string,
  command: ProjectHierarchyCommand,
  snapshot: ProjectHierarchySnapshot,
): ProjectHierarchyCommand {
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
      command.orderedPhaseIds.forEach((phaseId, index) => {
        database.update(projectPhases)
          .set({ sortOrder: index, updatedAt: new Date().toISOString() })
          .where(eq(projectPhases.id, phaseId))
          .run();
      });
      return {
        type: 'reorder_phases',
        orderedPhaseIds: currentIds,
      };
    }
    case 'move_tasks': {
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
          .filter((item) => command.taskIds.includes(item.taskId)).length
        : 0;
      const boundedIndex = Math.min(
        command.toIndex,
        Math.max(0, (destinationLength ?? 0) - movingFromDestination),
      );
      return applyTaskPlacements(
        database,
        projectId,
        command.taskIds.map((taskId, index) => ({
          taskId,
          phaseId: command.toPhaseId,
          index: boundedIndex + index,
        })),
        snapshot,
      );
    }
    case 'restore_task_positions':
      return applyTaskPlacements(database, projectId, command.placements, snapshot);
  }
}

export function applyProjectHierarchyCommand(input: {
  projectId: string;
  request: ProjectHierarchyCommandRequest;
  actor?: ProjectHierarchyActor;
}): ProjectHierarchyCommandResult {
  return runTransaction((tx) => {
    const existing = tx.select().from(projectHierarchyCommands)
      .where(eq(projectHierarchyCommands.id, input.request.commandId))
      .get();
    if (existing) {
      if (existing.projectId !== input.projectId || !sameRequest(existing.request, input.request)) {
        throw new ProjectHierarchyServiceError(
          'Command ID has already been used for a different request',
          409,
          'COMMAND_ID_CONFLICT',
        );
      }
      return existing.result;
    }

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
    const inverseCommand = applyCommand(
      tx,
      input.projectId,
      input.request.command,
      before,
    );
    const nextRevision = before.revision + 1;
    const now = new Date().toISOString();
    tx.update(hubProjects)
      .set({
        hierarchyRevision: nextRevision,
        updatedAt: now,
      })
      .where(and(
        eq(hubProjects.id, input.projectId),
        eq(hubProjects.hierarchyRevision, before.revision),
      ))
      .run();
    tx.delete(projectHierarchyMutationContext)
      .where(eq(projectHierarchyMutationContext.projectId, input.projectId))
      .run();
    const hierarchy = requireSnapshot(tx, input.projectId);
    const result: ProjectHierarchyCommandResult = {
      commandId: input.request.commandId,
      revision: nextRevision,
      hierarchy,
      inverseCommand,
    };
    tx.insert(projectHierarchyCommands).values({
      id: input.request.commandId,
      projectId: input.projectId,
      baseRevision: before.revision,
      resultRevision: nextRevision,
      commandType: input.request.command.type,
      request: input.request,
      inverseCommand,
      result,
      actorType: input.actor?.type ?? 'user',
      actorId: input.actor?.id,
      createdAt: now,
    }).run();

    return result;
  });
}
