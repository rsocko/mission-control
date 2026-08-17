import db, { runTransaction } from '@/db';
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
  taskAttachments,
  taskDependencies,
  taskLinkedSources,
  taskProjects,
  taskSchedules,
  taskTags,
  tasks,
  weeklyOneThing,
} from '@/db/schema';
import { eq, or } from 'drizzle-orm';
import { detachTaskDescendants } from '@/lib/tasks/task-hierarchy-deletion';

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (typeof metadata !== 'string') return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function runLocalTaskDeletion(taskId: string, recursive: boolean): void {
  runTransaction((tx) => {
    const deleteTask = (id: string): void => {
      const childTasks = tx.select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.parentId, id))
        .all();
      if (recursive) {
        for (const childTask of childTasks) deleteTask(childTask.id);
      } else {
        detachTaskDescendants(tx, id);
      }

      tx.delete(taskTags).where(eq(taskTags.taskId, id)).run();
      tx.delete(projectAutoIncludeExclusions)
        .where(eq(projectAutoIncludeExclusions.taskId, id))
        .run();
      tx.delete(taskProjects).where(eq(taskProjects.taskId, id)).run();
      tx.delete(taskSchedules).where(eq(taskSchedules.taskId, id)).run();
      tx.delete(myDayItems).where(eq(myDayItems.taskId, id)).run();
      tx.delete(myDayExclusions).where(eq(myDayExclusions.taskId, id)).run();
      tx.delete(focusItems).where(eq(focusItems.taskId, id)).run();
      tx.delete(weeklyOneThing).where(eq(weeklyOneThing.taskId, id)).run();
      tx.delete(prioritySyncLog).where(eq(prioritySyncLog.taskId, id)).run();
      tx.delete(quickSortLog).where(eq(quickSortLog.taskId, id)).run();
      tx.delete(quickSortOperations).where(eq(quickSortOperations.taskId, id)).run();
      tx.delete(taskLinkedSources).where(eq(taskLinkedSources.taskId, id)).run();
      tx.delete(taskAttachments).where(eq(taskAttachments.taskId, id)).run();
      tx.delete(projectPhaseItems).where(eq(projectPhaseItems.taskId, id)).run();
      tx.update(notifications).set({ relatedTaskId: null }).where(eq(notifications.relatedTaskId, id)).run();
      tx.delete(taskDependencies).where(or(
        eq(taskDependencies.taskId, id),
        eq(taskDependencies.dependsOnTaskId, id),
      )).run();
      tx.delete(tasks).where(eq(tasks.id, id)).run();
    };

    deleteTask(taskId);
  });
}

export function deleteTaskLocally(taskId: string): void {
  runLocalTaskDeletion(taskId, false);
}

export function deleteTaskTreeLocally(taskId: string): void {
  runLocalTaskDeletion(taskId, true);
}

export function convertTaskTreeToLocal(
  taskId: string,
  resolution: 'keep_local' | 'archive_local',
): void {
  const now = new Date().toISOString();
  runTransaction((tx) => {
    const convertTree = (id: string): void => {
      const [task] = tx.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        metadata: tasks.metadata,
      }).from(tasks).where(eq(tasks.id, id)).all();
      if (!task) return;

      const children = tx.select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.parentId, id))
        .all();

      tx.update(tasks).set({
        sourceId: `local:${task.id}`,
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListId: null,
        sourceListName: null,
        syncStatus: 'synced',
        pushRetryCount: 0,
        updatedAt: now,
        lastSyncedAt: now,
        metadata: JSON.stringify({
          ...parseMetadata(task.metadata),
          retentionResolution: {
            action: resolution,
            resolvedAt: now,
            previousConnectorType: task.connectorType,
            previousConnectorInstanceId: task.connectorInstanceId,
            previousSourceId: task.sourceId,
          },
        }),
      }).where(eq(tasks.id, id)).run();

      for (const child of children) convertTree(child.id);
    };

    convertTree(taskId);
  });
}

export async function getTaskByRetentionIdentity(input: {
  connectorId: string;
  taskId?: string;
  taskSourceId: string;
}) {
  if (input.taskId) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (
      task
      && task.connectorInstanceId === input.connectorId
      && task.sourceId === input.taskSourceId
    ) {
      return task;
    }
  }

  const candidates = await db.select().from(tasks).where(eq(tasks.sourceId, input.taskSourceId));
  return candidates.find((task) => task.connectorInstanceId === input.connectorId);
}
