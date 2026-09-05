import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { TASK_QUICK_SORT_QUEUE_MODES } from '@/lib/tasks/core/contracts';
import type { QuickSortTaskSnapshot } from '@/types/quick-sort';

export type { QuickSortTaskSnapshot } from '@/types/quick-sort';

export const QUICK_SORT_MODES = TASK_QUICK_SORT_QUEUE_MODES;

export type QuickSortMode = (typeof QUICK_SORT_MODES)[number];

export async function captureQuickSortTask(taskId: string): Promise<QuickSortTaskSnapshot | null> {
  return (await getTaskCorePersistence()).quickSort.captureTask(taskId);
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
