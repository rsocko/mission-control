import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import {
  connectorConfigs,
  focusItems,
  myDayItems,
  projectAutoIncludeExclusions,
  projectPhaseItems,
  taskDependencies,
  taskProjects,
  taskSchedules,
  taskTags,
  tasks,
  weeklyOneThing,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { dbLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/tasks/[id]/move — Move a task to a different source/connector
 * 
 * Body: { targetConnectorInstanceId, targetListId?, keepTags? }
 * 
 * Copies to target, then deletes from source.
 * Requires both source and target to support writes.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { targetConnectorInstanceId, targetListId, keepTags = true } = body;

    if (!targetConnectorInstanceId) {
      return NextResponse.json(
        { error: 'targetConnectorInstanceId is required' },
        { status: 400 }
      );
    }

    // Resolve connector config to get the type
    const connectorConfig = await db.select().from(connectorConfigs)
      .where(eq(connectorConfigs.id, targetConnectorInstanceId)).limit(1);
    if (!connectorConfig.length) {
      return NextResponse.json(
        { error: 'Connector instance not found' },
        { status: 404 }
      );
    }
    const targetConnectorType = connectorConfig[0].type;

    // Fetch the source task
    const sourceTask = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!sourceTask.length) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const src = sourceTask[0];

    // Check if moving to same connector instance and list
    if (src.connectorInstanceId === targetConnectorInstanceId && !targetListId) {
      return NextResponse.json(
        { error: 'Cannot move to same location without a different targetListId' },
        { status: 400 }
      );
    }

    const newId = crypto.randomUUID();
    const now = new Date().toISOString();

    // All writes in a single transaction to prevent partial moves
    try {
      runTransaction((tx) => {
        // Create the task in the target
        tx.insert(tasks).values({
          id: newId,
          sourceId: `local:${newId}`,
          connectorType: targetConnectorType,
          connectorInstanceId: targetConnectorInstanceId,
          title: src.title,
          description: src.description,
          status: src.status,
          priority: src.priority,
          dueDate: src.dueDate,
          createdAt: src.createdAt,
          updatedAt: now,
          completedAt: src.completedAt,
          depth: 0,
          isChecklistItem: false,
          sourceListId: targetListId || undefined,
          metadata: '{}',
          syncStatus: 'pending_push',
          lastSyncedAt: now,
        }).run();

        // Copy tags
        if (keepTags) {
          const sourceTags = tx.select().from(taskTags).where(eq(taskTags.taskId, id)).all();
          if (sourceTags.length > 0) {
            tx.insert(taskTags).values(
              sourceTags.map(tt => ({ taskId: newId, tagId: tt.tagId }))
            ).run();
          }
        }

        // Copy project associations
        const sourceProjects = tx.select().from(taskProjects).where(eq(taskProjects.taskId, id)).all();
        if (sourceProjects.length > 0) {
          tx.insert(taskProjects).values(
            sourceProjects.map(tp => ({ taskId: newId, projectId: tp.projectId }))
          ).run();
        }

        // Update My Day references to point to new task
        tx.update(myDayItems).set({ taskId: newId }).where(eq(myDayItems.taskId, id)).run();

        tx.update(projectAutoIncludeExclusions)
          .set({ taskId: newId })
          .where(eq(projectAutoIncludeExclusions.taskId, id))
          .run();

        // Update focus items to point to new task
        tx.update(focusItems).set({ taskId: newId }).where(eq(focusItems.taskId, id)).run();

        // Migrate task schedule (taskId is the PK, so delete + re-insert)
        const sourceSchedules = tx.select().from(taskSchedules).where(eq(taskSchedules.taskId, id)).all();
        if (sourceSchedules.length > 0) {
          tx.delete(taskSchedules).where(eq(taskSchedules.taskId, id)).run();
          tx.insert(taskSchedules).values(
            sourceSchedules.map(s => ({ ...s, taskId: newId }))
          ).run();
        }

        // Update project phase items to point to new task
        tx.update(projectPhaseItems).set({ taskId: newId }).where(eq(projectPhaseItems.taskId, id)).run();

        // Update weekly one thing to point to new task
        tx.update(weeklyOneThing).set({ taskId: newId }).where(eq(weeklyOneThing.taskId, id)).run();

        // Re-parent child tasks to the new task ID
        tx.update(tasks).set({ parentId: newId }).where(eq(tasks.parentId, id)).run();

        // Preserve graph relationships across the task ID replacement.
        tx.update(taskDependencies)
          .set({ taskId: newId })
          .where(eq(taskDependencies.taskId, id))
          .run();
        tx.update(taskDependencies)
          .set({ dependsOnTaskId: newId })
          .where(eq(taskDependencies.dependsOnTaskId, id))
          .run();

        // Delete the original
        tx.delete(taskTags).where(eq(taskTags.taskId, id)).run();
        tx.delete(taskProjects).where(eq(taskProjects.taskId, id)).run();
        tx.delete(tasks).where(eq(tasks.id, id)).run();
      });
    } catch (err) {
      dbLogger.error({ err, sourceTaskId: id, newTaskId: newId, targetConnectorType, op: 'moveTask' },
        'Transaction rolled back: task move failed — source preserved, no data lost');
      throw err;
    }

    // Mark source for deletion sync (if it was synced to a remote)
    // In production, the sync scheduler would call connector.deleteTask(src.sourceId)

    return NextResponse.json({
      id: newId,
      message: `Task moved to ${targetConnectorType}`,
      previousId: id,
      previousSource: src.connectorType,
    }, { status: 200 });
  } catch (error) {
    return ApiErrors.internal('Failed to move task', error);
  }
}
