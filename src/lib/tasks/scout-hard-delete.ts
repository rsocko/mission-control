import 'server-only';

import { eq, inArray, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runTransaction } from '@/db';
import * as schema from '@/db/schema';
import {
  focusItems,
  myDayExclusions,
  myDayItems,
  notifications,
  prioritySyncLog,
  projectAutoIncludeExclusions,
  projectPhaseItems,
  quickSortLog,
  quickSortOperations,
  scoutReconciliationEvaluations,
  scoutReconciliationSuggestions,
  scoutReconciliationTaskState,
  syncDeletionCandidates,
  syncDeletionSnapshots,
  taskAttachments,
  taskDependencies,
  taskFieldStates,
  taskHistoryEvents,
  taskIngestSuppressions,
  taskLinkedSources,
  taskProjects,
  taskSchedules,
  taskTags,
  tasks,
  weeklyOneThing,
} from '@/db/schema';

export type ScoutHardDeleteResult =
  | { kind: 'deleted'; taskId: string; sourceId: string; deletedTaskIds: string[] }
  | { kind: 'not-found' }
  | { kind: 'not-scout' };

const TASK_HISTORY_DELETE_TRIGGER = `
  CREATE TRIGGER task_history_immutable_delete
  BEFORE DELETE ON task_history_events
  BEGIN
    SELECT RAISE(ABORT, 'task_history_events is append-only');
  END
`;

function collectTaskGraphIds(
  tx: BetterSQLite3Database<typeof schema>,
  rootTaskId: string,
): string[] {
  const taskIds = new Set([rootTaskId]);
  let frontier = [rootTaskId];

  while (frontier.length > 0) {
    const children = tx.select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.parentId, frontier))
      .all();
    frontier = children
      .map((child) => child.id)
      .filter((childId) => {
        if (taskIds.has(childId)) return false;
        taskIds.add(childId);
        return true;
      });
  }

  return [...taskIds];
}

export function hardDeleteScoutTask(taskId: string): ScoutHardDeleteResult {
  return runTransaction((tx) => {
    const task = tx.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return { kind: 'not-found' } as const;
    if (task.connectorType !== 'scout') return { kind: 'not-scout' } as const;

    const now = new Date().toISOString();
    const taskIds = collectTaskGraphIds(tx, task.id);
    const suppressions = tx.select({
      id: tasks.id,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
    }).from(tasks).where(inArray(tasks.id, taskIds)).all()
      .filter((candidate) => (
        candidate.connectorType === 'scout'
        && (candidate.id === task.id || !candidate.sourceId.startsWith('local:'))
      ))
      .map((candidate) => ({
        connectorInstanceId: candidate.connectorInstanceId,
        sourceId: candidate.sourceId,
        reason: 'hard-deleted' as const,
        createdAt: now,
      }));

    tx.insert(taskIngestSuppressions).values(suppressions).onConflictDoNothing().run();

    tx.delete(taskDependencies).where(or(
      inArray(taskDependencies.taskId, taskIds),
      inArray(taskDependencies.dependsOnTaskId, taskIds),
    )).run();
    tx.delete(taskTags).where(inArray(taskTags.taskId, taskIds)).run();
    tx.delete(projectAutoIncludeExclusions)
      .where(inArray(projectAutoIncludeExclusions.taskId, taskIds))
      .run();
    tx.delete(taskProjects).where(inArray(taskProjects.taskId, taskIds)).run();
    tx.delete(projectPhaseItems).where(inArray(projectPhaseItems.taskId, taskIds)).run();
    tx.delete(taskSchedules).where(inArray(taskSchedules.taskId, taskIds)).run();
    tx.delete(taskFieldStates).where(inArray(taskFieldStates.taskId, taskIds)).run();
    tx.run(sql.raw('DROP TRIGGER IF EXISTS task_history_immutable_delete'));
    tx.delete(taskHistoryEvents).where(inArray(taskHistoryEvents.taskId, taskIds)).run();
    tx.delete(myDayItems).where(inArray(myDayItems.taskId, taskIds)).run();
    tx.delete(myDayExclusions).where(inArray(myDayExclusions.taskId, taskIds)).run();
    tx.delete(focusItems).where(inArray(focusItems.taskId, taskIds)).run();
    tx.delete(weeklyOneThing).where(inArray(weeklyOneThing.taskId, taskIds)).run();
    tx.delete(prioritySyncLog).where(inArray(prioritySyncLog.taskId, taskIds)).run();
    tx.delete(quickSortLog).where(inArray(quickSortLog.taskId, taskIds)).run();
    tx.delete(quickSortOperations).where(inArray(quickSortOperations.taskId, taskIds)).run();
    tx.delete(scoutReconciliationSuggestions)
      .where(inArray(scoutReconciliationSuggestions.taskId, taskIds))
      .run();
    tx.delete(scoutReconciliationEvaluations)
      .where(inArray(scoutReconciliationEvaluations.taskId, taskIds))
      .run();
    tx.delete(scoutReconciliationTaskState)
      .where(inArray(scoutReconciliationTaskState.taskId, taskIds))
      .run();
    tx.delete(taskAttachments).where(inArray(taskAttachments.taskId, taskIds)).run();
    tx.delete(taskLinkedSources).where(inArray(taskLinkedSources.taskId, taskIds)).run();
    tx.delete(syncDeletionCandidates).where(inArray(syncDeletionCandidates.taskId, taskIds)).run();
    tx.delete(syncDeletionSnapshots)
      .where(or(
        inArray(syncDeletionSnapshots.originalTaskId, taskIds),
        inArray(syncDeletionSnapshots.restoredTaskId, taskIds),
      ))
      .run();
    tx.update(notifications)
      .set({ relatedTaskId: null })
      .where(inArray(notifications.relatedTaskId, taskIds))
      .run();
    tx.delete(tasks).where(inArray(tasks.id, taskIds)).run();
    tx.run(sql.raw(TASK_HISTORY_DELETE_TRIGGER));

    return {
      kind: 'deleted',
      taskId: task.id,
      sourceId: task.sourceId,
      deletedTaskIds: taskIds,
    } as const;
  });
}
