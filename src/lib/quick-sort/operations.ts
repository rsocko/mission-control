import db from '@/db';
import { taskTags, tasks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { QuickSortTaskSnapshot } from '@/types/quick-sort';

export type { QuickSortTaskSnapshot } from '@/types/quick-sort';

export const QUICK_SORT_MODES = [
  'no_priority',
  'quadrant',
  'no_effort',
  'no_tags',
  'no_planning_horizon',
] as const;

export type QuickSortMode = (typeof QUICK_SORT_MODES)[number];

export async function captureQuickSortTask(taskId: string): Promise<QuickSortTaskSnapshot | null> {
  const [task, links] = await Promise.all([
    db.select({
      updatedAt: tasks.updatedAt,
      status: tasks.status,
      statusReason: tasks.statusReason,
      localDisposition: tasks.localDisposition,
      priority: tasks.priority,
      planningHorizon: tasks.planningHorizon,
      dueDate: tasks.dueDate,
      completedAt: tasks.completedAt,
      microStatus: tasks.microStatus,
      snoozedUntil: tasks.snoozedUntil,
      reminderAt: tasks.reminderAt,
      effort: tasks.effort,
    }).from(tasks).where(eq(tasks.id, taskId)).get(),
    db.select({ tagId: taskTags.tagId })
      .from(taskTags)
      .where(eq(taskTags.taskId, taskId)),
  ]);
  if (!task) return null;
  return {
    ...task,
    tagIds: links.map((link) => link.tagId).sort(),
  };
}

export function snapshotsMatch(
  current: QuickSortTaskSnapshot,
  expected: QuickSortTaskSnapshot,
): boolean {
  return current.updatedAt === expected.updatedAt
    && current.status === expected.status
    && current.statusReason === expected.statusReason
    && current.localDisposition === expected.localDisposition
    && current.priority === expected.priority
    && current.planningHorizon === expected.planningHorizon
    && current.dueDate === expected.dueDate
    && current.completedAt === expected.completedAt
    && current.microStatus === expected.microStatus
    && current.snoozedUntil === expected.snoozedUntil
    && current.reminderAt === expected.reminderAt
    && current.effort === expected.effort
    && current.tagIds.join('\0') === expected.tagIds.join('\0');
}

export function buildUndoPatch(
  before: QuickSortTaskSnapshot,
  originalPatch: Record<string, unknown>,
): Record<string, unknown> {
  const undo: Record<string, unknown> = {};
  const snapshotFields: Record<string, unknown> = {
    status: before.status,
    statusReason: before.statusReason,
    localDisposition: before.localDisposition,
    priority: before.priority,
    planningHorizon: before.planningHorizon,
    dueDate: before.dueDate,
    microStatus: before.microStatus,
    snoozedUntil: before.snoozedUntil,
    reminderAt: before.reminderAt,
    effort: before.effort,
    tags: before.tagIds,
  };
  for (const field of Object.keys(originalPatch)) {
    if (field in snapshotFields) undo[field] = snapshotFields[field];
  }
  if ('status' in originalPatch) {
    undo.statusReason = before.statusReason;
    undo.microStatus = before.microStatus;
    undo.snoozedUntil = before.snoozedUntil;
    undo.reminderAt = before.reminderAt;
  }
  return undo;
}
