import { ProjectHierarchyServiceError } from '@/db/persistence/project-hierarchy';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchySnapshot,
} from './hierarchy-types';
import type { ProjectPhaseItem, TaskField } from '@/types';

/**
 * Pure, in-memory project-hierarchy transition planner (L15).
 *
 * Both the SQLite and PostgreSQL adapters call this planner with authoritative
 * state they loaded under their own lock, and then execute the returned
 * row-level mutations in order. The seven-command state machine, dense
 * ordering, phase-item identity/metadata preservation, membership/exclusion
 * derivation, inverse-command derivation, and the changed/no-op distinction
 * live here exactly once; the adapters carry no command semantics.
 */

type TaskPlacement = Extract<
  ProjectHierarchyCommand,
  { type: 'restore_task_positions' }
>['placements'][number];
type ProjectTaskState = Extract<
  ProjectHierarchyCommand,
  { type: 'restore_project_tasks' }
>['states'][number];
type PhaseItemMetadata = NonNullable<
  Extract<ProjectHierarchyCommand, { type: 'move_tasks' }>['newItem']
>;
type PhaseItemUpdates = Extract<
  ProjectHierarchyCommand,
  { type: 'update_phase_item' }
>['updates'];

export interface ProjectHierarchyTaskState {
  taskId: string;
  member: boolean;
  excludedAt: string | null;
}

export type ProjectHierarchyMutation =
  | { kind: 'add_task_membership'; taskId: string }
  | { kind: 'remove_task_membership'; taskId: string }
  | { kind: 'upsert_task_exclusion'; taskId: string; excludedAt: string }
  | { kind: 'delete_task_exclusion'; taskId: string }
  | { kind: 'delete_phase_item'; itemId: string }
  | { kind: 'insert_phase_item'; item: ProjectPhaseItem }
  | { kind: 'move_phase_item'; itemId: string; phaseId: string; sortOrder: number }
  | { kind: 'update_phase_item_metadata'; itemId: string; updates: PhaseItemUpdates }
  | { kind: 'set_phase_sort_order'; phaseId: string; sortOrder: number; updatedAt: string };

export interface ProjectHierarchyPlanInput {
  snapshot: ProjectHierarchySnapshot;
  /** Membership/exclusion state for every task the command references. */
  taskStates: readonly ProjectHierarchyTaskState[];
  command: ProjectHierarchyCommand;
  /** Single timestamp used for new items, exclusions, and phase updates. */
  now: string;
  /** Identity source for phase items the command creates. */
  newItemId: () => string;
}

export interface ProjectHierarchyPlan {
  changed: boolean;
  inverseCommand: ProjectHierarchyCommand;
  mutations: ProjectHierarchyMutation[];
}

interface PlanState {
  snapshot: ProjectHierarchySnapshot;
  phaseIds: string[];
  itemsByPhase: Map<string, ProjectPhaseItem[]>;
  members: Set<string>;
  exclusions: Map<string, string>;
  now: string;
  newItemId: () => string;
  mutations: ProjectHierarchyMutation[];
}

interface AppliedCommand {
  inverseCommand: ProjectHierarchyCommand;
  changed: boolean;
}

/** Every task whose membership/exclusion state the planner needs. */
export function projectHierarchyCommandTaskIds(
  command: ProjectHierarchyCommand,
): string[] {
  switch (command.type) {
    case 'reorder_phases':
      return [];
    case 'move_tasks':
    case 'assign_tasks':
    case 'remove_tasks':
      return [...command.taskIds];
    case 'restore_task_positions':
      return command.placements.map((placement) => placement.taskId);
    case 'restore_project_tasks':
      return command.states.map((state) => state.taskId);
    case 'update_phase_item':
      return [command.taskId];
  }
}

/** Task-source mutation-policy fields each command requires (L05/L07 boundary). */
export function projectHierarchyMutationRequirements(
  command: ProjectHierarchyCommand,
): Array<{ taskId: string; fields: readonly TaskField[] }> {
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
      return [{ taskId: command.taskId, fields: ['phases'] as const }];
  }
}

export function planProjectHierarchyCommand(
  input: ProjectHierarchyPlanInput,
): ProjectHierarchyPlan {
  const state: PlanState = {
    snapshot: input.snapshot,
    phaseIds: input.snapshot.phases.map((phase) => phase.id),
    itemsByPhase: new Map(input.snapshot.phases.map((phase) => [
      phase.id,
      [...(input.snapshot.phaseItemsByPhase[phase.id] ?? [])],
    ])),
    members: new Set(
      input.taskStates.filter((task) => task.member).map((task) => task.taskId),
    ),
    exclusions: new Map(
      input.taskStates.flatMap((task) => (
        task.excludedAt === null ? [] : [[task.taskId, task.excludedAt] as const]
      )),
    ),
    now: input.now,
    newItemId: input.newItemId,
    mutations: [],
  };
  const applied = applyCommand(state, input.command);
  return {
    changed: applied.changed,
    inverseCommand: applied.inverseCommand,
    mutations: state.mutations,
  };
}

function applyCommand(
  state: PlanState,
  command: ProjectHierarchyCommand,
): AppliedCommand {
  switch (command.type) {
    case 'reorder_phases': {
      const currentIds = [...state.phaseIds];
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
      const inverseCommand: ProjectHierarchyCommand = {
        type: 'reorder_phases',
        orderedPhaseIds: currentIds,
      };
      const changed = command.orderedPhaseIds.some(
        (phaseId, index) => phaseId !== currentIds[index],
      );
      if (!changed) return { inverseCommand, changed: false };
      command.orderedPhaseIds.forEach((phaseId, index) => {
        state.mutations.push({
          kind: 'set_phase_sort_order',
          phaseId,
          sortOrder: index,
          updatedAt: state.now,
        });
      });
      state.phaseIds = [...command.orderedPhaseIds];
      return { inverseCommand, changed: true };
    }
    case 'move_tasks': {
      const currentPlacements = placementsFromState(state, command.taskIds);
      if (
        command.fromPhaseId !== undefined
        && currentPlacements.some((placement) => placement.phaseId !== command.fromPhaseId)
      ) {
        throw new ProjectHierarchyServiceError(
          'Task placement changed before this phase operation could be applied',
          409,
          'HIERARCHY_SOURCE_CONFLICT',
          state.snapshot,
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
      const destination = command.toPhaseId
        ? state.itemsByPhase.get(command.toPhaseId)
        : [];
      if (command.toPhaseId && destination === undefined) {
        throw new ProjectHierarchyServiceError(
          'Destination phase must belong to this project',
          404,
          'PHASE_NOT_IN_PROJECT',
        );
      }
      const destinationLength = destination?.length ?? 0;
      const movingFromDestination = command.toPhaseId
        ? (destination ?? []).filter((item) => taskIds.includes(item.taskId)).length
        : 0;
      const boundedIndex = Math.min(
        command.toIndex,
        Math.max(0, destinationLength - movingFromDestination),
      );
      return applyTaskPlacements(
        state,
        taskIds.map((taskId, index) => ({
          taskId,
          phaseId: command.toPhaseId,
          index: boundedIndex + index,
        })),
        command.newItem,
      );
    }
    case 'restore_task_positions':
      return applyTaskPlacements(state, command.placements);
    case 'assign_tasks': {
      const beforeStates = captureProjectTaskStates(state, command.taskIds);
      const destination = command.toPhaseId
        ? state.itemsByPhase.get(command.toPhaseId)
        : [];
      if (command.toPhaseId && destination === undefined) {
        throw new ProjectHierarchyServiceError(
          'Destination phase must belong to this project',
          404,
          'PHASE_NOT_IN_PROJECT',
        );
      }
      const startIndex = command.toIndex ?? destination?.length ?? 0;
      const states = beforeStates.map((entry, index): ProjectTaskState => {
        let placement = entry.placement;
        if (command.toPhaseId !== undefined) {
          placement = command.toPhaseId
            ? command.toIndex === undefined && entry.placement?.phaseId === command.toPhaseId
              ? entry.placement
              : {
                taskId: entry.taskId,
                phaseId: command.toPhaseId,
                index: startIndex + index,
                item: entry.placement?.item,
              }
            : null;
        }
        return {
          taskId: entry.taskId,
          member: true,
          excludedAt: null,
          placement,
        };
      });
      return applyProjectTaskStates(
        state,
        states,
        command.taskIds.length === 1 ? command.newItem : undefined,
      );
    }
    case 'remove_tasks': {
      const beforeStates = captureProjectTaskStates(state, command.taskIds);
      const excludedAt = state.now;
      return applyProjectTaskStates(
        state,
        beforeStates.map((entry) => entry.member
          ? { taskId: entry.taskId, member: false, excludedAt, placement: null }
          : entry),
      );
    }
    case 'restore_project_tasks':
      return applyProjectTaskStates(state, command.states);
    case 'update_phase_item': {
      const phaseItems = state.itemsByPhase.get(command.phaseId);
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
          currentItem[field as keyof PhaseItemUpdates],
        ]),
      ) as PhaseItemUpdates;
      const metadataChanged = Object.entries(command.updates).some(
        ([field, value]) => currentItem[field as keyof PhaseItemUpdates] !== value,
      );
      const placementResult = command.toIndex === undefined
        ? { changed: false }
        : applyTaskPlacements(state, [{
          taskId: command.taskId,
          phaseId: command.phaseId,
          index: command.toIndex,
        }]);
      if (metadataChanged) {
        state.mutations.push({
          kind: 'update_phase_item_metadata',
          itemId: currentItem.id,
          updates: command.updates,
        });
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

function placementsFromState(state: PlanState, taskIds: string[]): TaskPlacement[] {
  return taskIds.map((taskId) => {
    for (const phaseId of state.phaseIds) {
      const items = state.itemsByPhase.get(phaseId) ?? [];
      const index = items.findIndex((item) => item.taskId === taskId);
      if (index !== -1) {
        const item = items[index];
        return {
          taskId,
          phaseId,
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

function captureProjectTaskStates(
  state: PlanState,
  taskIds: string[],
): ProjectTaskState[] {
  const placementByTask = new Map(
    placementsFromState(state, taskIds).map((placement) => [placement.taskId, placement]),
  );
  return taskIds.map((taskId) => {
    const placement = placementByTask.get(taskId);
    return {
      taskId,
      member: state.members.has(taskId),
      excludedAt: state.exclusions.get(taskId) ?? null,
      placement: placement?.phaseId ? placement : null,
    };
  });
}

function samePlacement(left: TaskPlacement | null, right: TaskPlacement | null) {
  return left?.phaseId === right?.phaseId
    && left?.index === right?.index
    && left?.item?.id === right?.item?.id;
}

function applyProjectTaskStates(
  state: PlanState,
  states: ProjectTaskState[],
  newItem?: PhaseItemMetadata,
): AppliedCommand {
  const taskIds = states.map((entry) => entry.taskId);
  const beforeStates = captureProjectTaskStates(state, taskIds);
  const beforeByTask = new Map(beforeStates.map((entry) => [entry.taskId, entry]));
  const relationshipChanged = states.some((entry) => {
    const before = beforeByTask.get(entry.taskId)!;
    return before.member !== entry.member || before.excludedAt !== entry.excludedAt;
  });
  const placementRequested = states.some((entry) => (
    !samePlacement(beforeByTask.get(entry.taskId)!.placement, entry.placement)
  ));
  const inverseCommand: ProjectHierarchyCommand = {
    type: 'restore_project_tasks',
    states: beforeStates,
  };
  if (!relationshipChanged && !placementRequested) {
    return { inverseCommand, changed: false };
  }

  let placementDeleted = false;
  for (const entry of states) {
    if (entry.member) {
      state.mutations.push({ kind: 'add_task_membership', taskId: entry.taskId });
      state.members.add(entry.taskId);
    } else {
      for (const phaseId of state.phaseIds) {
        const items = state.itemsByPhase.get(phaseId) ?? [];
        const removed = items.filter((item) => item.taskId === entry.taskId);
        if (removed.length === 0) continue;
        placementDeleted = true;
        for (const item of removed) {
          state.mutations.push({ kind: 'delete_phase_item', itemId: item.id });
        }
        state.itemsByPhase.set(
          phaseId,
          items.filter((item) => item.taskId !== entry.taskId),
        );
      }
      state.mutations.push({ kind: 'remove_task_membership', taskId: entry.taskId });
      state.members.delete(entry.taskId);
    }

    if (entry.excludedAt) {
      state.mutations.push({
        kind: 'upsert_task_exclusion',
        taskId: entry.taskId,
        excludedAt: entry.excludedAt,
      });
      state.exclusions.set(entry.taskId, entry.excludedAt);
    } else {
      state.mutations.push({ kind: 'delete_task_exclusion', taskId: entry.taskId });
      state.exclusions.delete(entry.taskId);
    }
  }

  const memberPlacements = states
    .filter((entry) => entry.member)
    .map((entry) => entry.placement ?? {
      taskId: entry.taskId,
      phaseId: null,
      index: 0,
    });
  const placementResult = memberPlacements.length > 0
    ? applyTaskPlacements(state, memberPlacements, newItem)
    : undefined;

  return {
    inverseCommand,
    changed: relationshipChanged || placementDeleted || placementResult?.changed === true,
  };
}

function applyTaskPlacements(
  state: PlanState,
  placements: TaskPlacement[],
  newItem?: PhaseItemMetadata,
): AppliedCommand {
  const taskIds = placements.map((placement) => placement.taskId);
  if (taskIds.some((taskId) => !state.members.has(taskId))) {
    throw new ProjectHierarchyServiceError(
      'Every task must belong to this project',
      404,
      'TASK_NOT_IN_PROJECT',
    );
  }
  for (const placement of placements) {
    if (placement.phaseId && !state.itemsByPhase.has(placement.phaseId)) {
      throw new ProjectHierarchyServiceError(
        'Destination phase must belong to this project',
        404,
        'PHASE_NOT_IN_PROJECT',
      );
    }
  }

  const existingByTask = new Map<string, ProjectPhaseItem>();
  for (const phaseId of state.phaseIds) {
    for (const item of state.itemsByPhase.get(phaseId) ?? []) {
      if (!taskIds.includes(item.taskId)) continue;
      if (existingByTask.has(item.taskId)) {
        throw new ProjectHierarchyServiceError(
          'A task is assigned to more than one phase in this project',
          409,
          'DUPLICATE_PHASE_ASSIGNMENT',
          state.snapshot,
        );
      }
      existingByTask.set(item.taskId, item);
    }
  }

  const inversePlacements = placementsFromState(state, taskIds);
  const inverseCommand: ProjectHierarchyCommand = {
    type: 'restore_task_positions',
    placements: inversePlacements,
  };
  const movedTaskIds = new Set(taskIds);
  const nextItemsByPhase = new Map(state.phaseIds.map((phaseId) => [
    phaseId,
    (state.itemsByPhase.get(phaseId) ?? []).filter(
      (item) => !movedTaskIds.has(item.taskId),
    ),
  ]));

  const desiredByTask = new Map(
    placements.map((placement) => [placement.taskId, placement]),
  );
  const indexedPlacements = placements.map((placement, requestIndex) => ({
    placement,
    requestIndex,
  }));
  indexedPlacements.sort((left, right) => (
    (left.placement.phaseId ?? '').localeCompare(right.placement.phaseId ?? '')
    || left.placement.index - right.placement.index
    || left.requestIndex - right.requestIndex
  ));

  const createdItemIds = new Set<string>();
  for (const { placement } of indexedPlacements) {
    if (!placement.phaseId) continue;
    const destination = nextItemsByPhase.get(placement.phaseId)!;
    const existing = existingByTask.get(placement.taskId);
    const item: ProjectPhaseItem = existing
      ? { ...existing, phaseId: placement.phaseId }
      : {
        id: placement.item?.id ?? state.newItemId(),
        phaseId: placement.phaseId,
        taskId: placement.taskId,
        sortOrder: 0,
        estimatedEffortHours:
          placement.item?.estimatedEffortHours ?? newItem?.estimatedEffortHours ?? null,
        isProposed: placement.item?.isProposed ?? newItem?.isProposed ?? false,
        proposalType: placement.item?.proposalType ?? newItem?.proposalType ?? null,
        createdAt: placement.item?.createdAt ?? state.now,
      };
    if (!existing) createdItemIds.add(item.id);
    destination.splice(Math.min(placement.index, destination.length), 0, item);
  }

  const changed = state.phaseIds.some((phaseId) => {
    const current = state.itemsByPhase.get(phaseId) ?? [];
    const next = nextItemsByPhase.get(phaseId) ?? [];
    return current.length !== next.length
      || current.some((item, index) => (
        item.id !== next[index]?.id
        || item.taskId !== next[index]?.taskId
        || item.phaseId !== next[index]?.phaseId
        || item.sortOrder !== index
      ));
  });
  if (!changed) return { inverseCommand, changed: false };

  for (const taskId of taskIds) {
    const existing = existingByTask.get(taskId);
    if (existing && !desiredByTask.get(taskId)!.phaseId) {
      state.mutations.push({ kind: 'delete_phase_item', itemId: existing.id });
    }
  }

  const affectedPhaseIds = new Set<string>();
  for (const placement of [...inversePlacements, ...placements]) {
    if (placement.phaseId) affectedPhaseIds.add(placement.phaseId);
  }
  for (const phaseId of affectedPhaseIds) {
    (nextItemsByPhase.get(phaseId) ?? []).forEach((item, index) => {
      if (createdItemIds.has(item.id)) {
        state.mutations.push({
          kind: 'insert_phase_item',
          item: { ...item, phaseId, sortOrder: index },
        });
      } else {
        state.mutations.push({
          kind: 'move_phase_item',
          itemId: item.id,
          phaseId,
          sortOrder: index,
        });
      }
    });
  }

  for (const phaseId of state.phaseIds) {
    const next = nextItemsByPhase.get(phaseId) ?? [];
    state.itemsByPhase.set(
      phaseId,
      affectedPhaseIds.has(phaseId)
        ? next.map((item, index) => ({ ...item, phaseId, sortOrder: index }))
        : next,
    );
  }

  return { inverseCommand, changed: true };
}
