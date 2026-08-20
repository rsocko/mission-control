import { z } from 'zod';
import type { TaskField } from '@/types';
import { REMINDER_RELATIVE_RULE_VALUES } from '@/lib/tasks/relative-reminder';

const TASK_PATCH_SCHEMA = z.strictObject({
  title: z.string().trim().min(1),
  description: z.string().nullable(),
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled']),
  localDisposition: z.enum(['active', 'handled', 'dismissed']),
  priority: z.enum(['critical', 'high', 'medium', 'low', 'none']),
  dueDate: z.string().nullable(),
  kanbanColumn: z.string().nullable(),
  kanbanOrder: z.number().finite().nullable(),
  tags: z.array(z.string().min(1)),
  recurrence: z.string().nullable(),
  estimatedDuration: z.number().int().nonnegative().nullable(),
  microStatus: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  effort: z.number().int().min(1).max(5).nullable(),
  statusReason: z.enum(['completed', 'not_planned', 'duplicate', 'moved']).nullable(),
  reminderAt: z.string().datetime({ offset: true })
    .transform(value => new Date(value).toISOString())
    .nullable(),
  reminderRelative: z.enum(REMINDER_RELATIVE_RULE_VALUES).nullable(),
  reminderDueTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(),
  relativeReminderDueDateResolution: z.enum(['remove', 'convert_to_absolute']).optional(),
}).partial();

export type TaskPatchInput = z.infer<typeof TASK_PATCH_SCHEMA>;

const FIELD_BY_INPUT_KEY = {
  title: 'title',
  description: 'description',
  status: 'status',
  localDisposition: 'localDisposition',
  priority: 'priority',
  dueDate: 'dueDate',
  kanbanColumn: 'kanbanPlacement',
  kanbanOrder: 'kanbanPlacement',
  tags: 'tags',
  recurrence: 'recurrence',
  estimatedDuration: 'estimatedDuration',
  microStatus: 'microStatus',
  snoozedUntil: 'snoozedUntil',
  effort: 'effort',
  statusReason: 'statusReason',
  reminderAt: 'reminderAt',
  reminderRelative: 'reminderAt',
  reminderDueTime: 'reminderAt',
  relativeReminderDueDateResolution: 'reminderAt',
} as const satisfies Record<keyof TaskPatchInput, TaskField>;

const IMMUTABLE_INPUT_FIELDS = new Set([
  'metadata',
  'id',
  'sourceId',
  'connectorType',
  'connectorInstanceId',
  'sourceListId',
  'sourceListName',
  'createdAt',
  'updatedAt',
  'completedAt',
  'syncStatus',
  'lastSyncedAt',
  'pushRetryCount',
  'parentId',
  'depth',
  'isChecklistItem',
]);

export type ParsedTaskPatch =
  | { success: true; input: TaskPatchInput; fields: TaskField[] }
  | { success: false; error: string };

export function parseTaskPatchInput(value: unknown): ParsedTaskPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { success: false, error: 'Task update body must be an object' };
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return { success: false, error: 'Task update must include at least one field' };
  }

  const immutable = keys.filter((key) => IMMUTABLE_INPUT_FIELDS.has(key));
  if (immutable.length > 0) {
    return {
      success: false,
      error: `Immutable task fields cannot be changed: ${immutable.sort().join(', ')}`,
    };
  }

  const unsupported = keys.filter((key) => !(key in FIELD_BY_INPUT_KEY));
  if (unsupported.length > 0) {
    return {
      success: false,
      error: `Unsupported task fields: ${unsupported.sort().join(', ')}`,
    };
  }

  const parsed = TASK_PATCH_SCHEMA.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join('.') || 'request';
    return { success: false, error: `Invalid ${field}: ${issue.message}` };
  }

  const fields = [...new Set(
    Object.keys(parsed.data).map((key) => FIELD_BY_INPUT_KEY[key as keyof TaskPatchInput]),
  )];
  return { success: true, input: parsed.data, fields };
}
