import type { SmartScoreTaskMomentumRow } from './contracts';

interface PlanningActivityRow {
  taskId: string;
  latestMyDayDate: string | null;
  latestMyDayAddedAt: string | null;
  lastMyDayCommittedAt: string | null;
  lastMyDayWithdrawnAt: string | null;
  inProgressStartedAt: string | null;
}

interface SubtaskActivityRow {
  taskId: string | null;
  lastSubtaskCompletedAt: string | null;
}

export function mergeSmartScoreMomentumRows(
  taskIds: readonly string[],
  planningRows: readonly PlanningActivityRow[],
  subtaskRows: readonly SubtaskActivityRow[],
): SmartScoreTaskMomentumRow[] {
  const byTaskId = new Map<string, SmartScoreTaskMomentumRow>(
    taskIds.map((taskId) => [taskId, {
      taskId,
      latestMyDayDate: null,
      latestMyDayAddedAt: null,
      lastMyDayCommittedAt: null,
      lastMyDayWithdrawnAt: null,
      inProgressStartedAt: null,
      lastSubtaskCompletedAt: null,
    }]),
  );

  for (const row of planningRows) {
    const current = byTaskId.get(row.taskId);
    if (!current) continue;
    byTaskId.set(row.taskId, { ...current, ...row });
  }

  for (const row of subtaskRows) {
    if (!row.taskId) continue;
    const current = byTaskId.get(row.taskId);
    if (!current) continue;
    byTaskId.set(row.taskId, {
      ...current,
      lastSubtaskCompletedAt: row.lastSubtaskCompletedAt,
    });
  }

  return taskIds.map((taskId) => byTaskId.get(taskId)!);
}
