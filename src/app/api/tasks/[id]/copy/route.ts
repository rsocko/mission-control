import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { tasks, taskTags, taskProjects, connectorConfigs, sourceLists } from '@/db/schema';
import { and, eq, or } from 'drizzle-orm';
import { dbLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';

/**
 * POST /api/tasks/[id]/copy — Copy a task to a different source/connector
 * 
 * Body: { targetConnectorInstanceId, targetListId?, keepTags? }
 * 
 * Creates a new task in the target with the same title/description/priority/dueDate.
 * Does NOT remove from source (that's "move").
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
    let resolvedTargetListId: string | undefined;
    if (targetListId) {
      const [targetList] = await db.select().from(sourceLists)
        .where(and(
          eq(sourceLists.connectorInstanceId, targetConnectorInstanceId),
          or(eq(sourceLists.id, targetListId), eq(sourceLists.sourceId, targetListId)),
        ))
        .limit(1);
      if (!targetList || !isSourceListSelected(connectorConfig[0], targetList)) {
        return ApiErrors.badRequest('Target list is not selected for sync');
      }
      resolvedTargetListId = targetList.sourceId;
    }

    // Fetch the source task
    const sourceTask = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!sourceTask.length) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const src = sourceTask[0];
    const newId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create copy and associations in a single transaction
    try {
      runTransaction((tx) => {
        tx.insert(tasks).values({
          id: newId,
          sourceId: `local:${newId}`,
          connectorType: targetConnectorType,
          connectorInstanceId: targetConnectorInstanceId,
          title: src.title,
          description: src.description,
          status: 'todo',
          priority: src.priority,
          dueDate: src.dueDate,
          createdAt: now,
          updatedAt: now,
          depth: 0,
          isChecklistItem: false,
          sourceListId: resolvedTargetListId,
          metadata: '{}',
          syncStatus: 'pending_push',
          lastSyncedAt: now,
        }).run();

        // Copy tags if requested
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
      });
    } catch (err) {
      dbLogger.error({ err, sourceTaskId: id, newTaskId: newId, targetConnectorType, op: 'copyTask' },
        'Transaction rolled back: task copy failed');
      throw err;
    }

    return NextResponse.json({
      id: newId,
      message: `Task copied to ${targetConnectorType}`,
      sourceId: id,
    }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to copy task', error);
  }
}
