import { z } from 'zod';
import type { ProjectPhase, ProjectPhaseItem } from '@/types';

const nonEmptyId = z.string().trim().min(1);
const uniqueIds = z.array(nonEmptyId).min(1).refine(
  (ids) => new Set(ids).size === ids.length,
  'IDs must be unique',
);

const storedPhaseItemSchema = z.object({
  id: nonEmptyId,
  estimatedEffortHours: z.number().nonnegative().nullable().optional(),
  isProposed: z.boolean().optional(),
  proposalType: z.string().nullable().optional(),
  createdAt: z.string(),
});

const phaseItemUpdateSchema = z.object({
  estimatedEffortHours: z.number().nonnegative().nullable().optional(),
  isProposed: z.boolean().optional(),
  proposalType: z.string().nullable().optional(),
});

const newPhaseItemSchema = phaseItemUpdateSchema;

const taskPlacementSchema = z.object({
  taskId: nonEmptyId,
  phaseId: nonEmptyId.nullable(),
  index: z.number().int().nonnegative(),
  item: storedPhaseItemSchema.optional(),
});

export const reorderPhasesCommandSchema = z.object({
  type: z.literal('reorder_phases'),
  orderedPhaseIds: uniqueIds,
});

export const moveTasksCommandSchema = z.object({
  type: z.literal('move_tasks'),
  taskIds: uniqueIds,
  toPhaseId: nonEmptyId.nullable(),
  toIndex: z.number().int().nonnegative(),
  newItem: newPhaseItemSchema.optional(),
  fromPhaseId: nonEmptyId.nullable().optional(),
  preserveExistingPosition: z.boolean().optional(),
});

export const restoreTaskPositionsCommandSchema = z.object({
  type: z.literal('restore_task_positions'),
  placements: z.array(taskPlacementSchema).min(1).refine(
    (placements) => new Set(placements.map((placement) => placement.taskId)).size === placements.length,
    'Task IDs must be unique',
  ),
});

export const assignTasksCommandSchema = z.object({
  type: z.literal('assign_tasks'),
  taskIds: uniqueIds,
  toPhaseId: nonEmptyId.nullable().optional(),
  toIndex: z.number().int().nonnegative().optional(),
  newItem: newPhaseItemSchema.optional(),
});

export const removeTasksCommandSchema = z.object({
  type: z.literal('remove_tasks'),
  taskIds: uniqueIds,
});

const projectTaskStateSchema = z.object({
  taskId: nonEmptyId,
  member: z.boolean(),
  excludedAt: z.string().nullable(),
  placement: taskPlacementSchema.nullable(),
});

export const restoreProjectTasksCommandSchema = z.object({
  type: z.literal('restore_project_tasks'),
  states: z.array(projectTaskStateSchema).min(1).refine(
    (states) => new Set(states.map((state) => state.taskId)).size === states.length,
    'Task IDs must be unique',
  ),
});

export const updatePhaseItemCommandSchema = z.object({
  type: z.literal('update_phase_item'),
  phaseId: nonEmptyId,
  taskId: nonEmptyId,
  toIndex: z.number().int().nonnegative().optional(),
  updates: phaseItemUpdateSchema,
});

export const projectHierarchyCommandSchema = z.discriminatedUnion('type', [
  reorderPhasesCommandSchema,
  moveTasksCommandSchema,
  restoreTaskPositionsCommandSchema,
  assignTasksCommandSchema,
  removeTasksCommandSchema,
  restoreProjectTasksCommandSchema,
  updatePhaseItemCommandSchema,
]);

export const projectHierarchyCommandRequestSchema = z.object({
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  command: projectHierarchyCommandSchema,
});

export type ProjectHierarchyCommand = z.infer<typeof projectHierarchyCommandSchema>;
export type ProjectHierarchyCommandRequest = z.infer<typeof projectHierarchyCommandRequestSchema>;

export interface ProjectHierarchySnapshot {
  projectId: string;
  revision: number;
  phases: ProjectPhase[];
  phaseItemsByPhase: Record<string, ProjectPhaseItem[]>;
}

export interface ProjectHierarchyCommandResult {
  commandId: string;
  revision: number;
  hierarchy: ProjectHierarchySnapshot;
  inverseCommand: ProjectHierarchyCommand;
}
