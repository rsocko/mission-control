import { z } from 'zod';
import type { ProjectPhase, ProjectPhaseItem } from '@/types';

const nonEmptyId = z.string().trim().min(1);
const uniqueIds = z.array(nonEmptyId).min(1).refine(
  (ids) => new Set(ids).size === ids.length,
  'IDs must be unique',
);

export const reorderPhasesCommandSchema = z.object({
  type: z.literal('reorder_phases'),
  orderedPhaseIds: uniqueIds,
});

export const moveTasksCommandSchema = z.object({
  type: z.literal('move_tasks'),
  taskIds: uniqueIds,
  toPhaseId: nonEmptyId.nullable(),
  toIndex: z.number().int().nonnegative(),
});

export const restoreTaskPositionsCommandSchema = z.object({
  type: z.literal('restore_task_positions'),
  placements: z.array(z.object({
    taskId: nonEmptyId,
    phaseId: nonEmptyId.nullable(),
    index: z.number().int().nonnegative(),
  })).min(1).refine(
    (placements) => new Set(placements.map((placement) => placement.taskId)).size === placements.length,
    'Task IDs must be unique',
  ),
});

export const projectHierarchyCommandSchema = z.discriminatedUnion('type', [
  reorderPhasesCommandSchema,
  moveTasksCommandSchema,
  restoreTaskPositionsCommandSchema,
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
