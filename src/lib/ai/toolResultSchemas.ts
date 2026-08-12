import { z } from 'zod';

const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
const taskPrioritySchema = z.enum(['critical', 'high', 'medium', 'low', 'none']);
const dateStringSchema = z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid date');

export const taskReferenceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: dateStringSchema.nullable().optional(),
  source: z.string().nullable().optional(),
  sourceList: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  reason: z.string().optional(),
});

export const taskSearchResultSchema = z.array(taskReferenceSchema);

export const taskSummaryResultSchema = z.object({
  total: z.number().nonnegative(),
  open: z.number().nonnegative(),
  overdue: z.number().nonnegative(),
  critical: z.number().nonnegative(),
  done: z.number().nonnegative(),
  bySource: z.record(z.string(), z.number().nonnegative()),
  overdueItems: z.array(taskReferenceSchema).optional(),
});

export const dayPlanResultSchema = z.object({
  suggestions: z.array(taskReferenceSchema),
  totalOverdue: z.number().nonnegative(),
  totalOpen: z.number().nonnegative(),
  availableMinutes: z.number().nonnegative().optional(),
});

export const taskMutationResultSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    taskId: z.string().min(1),
    title: z.string().min(1),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    dueDate: dateStringSchema.nullable(),
    source: z.string().nullable(),
    sourceList: z.string().nullable(),
    completedAt: dateStringSchema.optional(),
    newPriority: taskPrioritySchema.optional(),
  }),
  z.object({
    success: z.literal(false),
    taskId: z.string().min(1),
    error: z.string().min(1),
  }),
]);

export type TaskReference = z.infer<typeof taskReferenceSchema>;
export type TaskSummaryResult = z.infer<typeof taskSummaryResultSchema>;
export type DayPlanResult = z.infer<typeof dayPlanResultSchema>;
export type TaskMutationResult = z.infer<typeof taskMutationResultSchema>;
