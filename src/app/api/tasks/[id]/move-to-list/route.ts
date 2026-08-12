import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, sourceLists } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { connectorRegistry } from '@/lib/connectors';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';
import { resolveTaskEditPolicy } from '@/lib/tasks/edit-policy';
import { isDemoMode } from '@/lib/mode';
import { syncScheduler } from '@/lib/sync';

/**
 * POST /api/tasks/[id]/move-to-list — Move a task to a different list within the same connector.
 * 
 * Body: { targetListId: string }
 * 
 * Calls the connector's moveTaskToList to move it remotely, then updates the local DB.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { targetListId } = body;

    if (!targetListId) {
      return NextResponse.json(
        { error: 'targetListId is required' },
        { status: 400 }
      );
    }

    // Fetch the task
    const taskRows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!taskRows.length) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const task = taskRows[0];

    const localIdentity = task.sourceId.startsWith('local:') || task.connectorType === 'local';
    const [caps, connectorEnabled] = localIdentity
      ? [null, true] as const
      : await Promise.all([
          getConnectorCapabilities(task.connectorInstanceId),
          isConnectorEnabled(task.connectorInstanceId),
        ]);
    const editPolicy = resolveTaskEditPolicy({
      sourceId: task.sourceId,
      connectorType: task.connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    }, caps);
    if (!editPolicy.sourceMoveSupported) {
      return ApiErrors.forbidden(editPolicy.sourceMoveReason ?? 'This task cannot be moved within its source');
    }

    // Fetch the target list to get its sourceId (the remote list ID)
    const targetListRows = await db.select().from(sourceLists).where(eq(sourceLists.id, targetListId)).limit(1);
    if (!targetListRows.length) {
      return NextResponse.json({ error: 'Target list not found' }, { status: 404 });
    }
    const targetList = targetListRows[0];
    if (targetList.connectorInstanceId !== task.connectorInstanceId) {
      return ApiErrors.badRequest('Target list must belong to the task source');
    }

    let newSourceId: string | undefined;
    if (editPolicy.sourceModel !== 'mc-owned') {
      const connector = connectorRegistry.getConnector(task.connectorInstanceId)
        ?? await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId);
      if (!connector?.moveTaskToList) {
        return ApiErrors.forbidden('The upstream source does not support moving this task');
      }
      try {
        const result = await connector.moveTaskToList(task.sourceId, targetList.sourceId);
        if (result) {
          newSourceId = result;
        }
      } catch (remoteErr) {
        logger.error({ err: remoteErr, taskId: id }, 'Remote task move failed');
        return NextResponse.json({ error: 'Failed to move task at its source' }, { status: 502 });
      }
    }

    const previousSourceListId = task.sourceListId;

    // Find the previous list's DB id so the client can undo
    let previousListId: string | null = null;
    if (previousSourceListId) {
      const prevListRows = await db.select({ id: sourceLists.id }).from(sourceLists)
        .where(and(eq(sourceLists.sourceId, previousSourceListId), eq(sourceLists.connectorInstanceId, task.connectorInstanceId)))
        .limit(1);
      if (prevListRows.length) {
        previousListId = prevListRows[0].id;
      }
    }

    // Update local DB — sourceListId stores the remote list ID (sourceId), not DB id
    await db.update(tasks).set({
      sourceListId: targetList.sourceId,
      ...(newSourceId ? { sourceId: newSourceId } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(tasks.id, id));

    return NextResponse.json({ success: true, newSourceId, previousListId });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to move task to list');
    return ApiErrors.internal('Failed to move task', error);
  }
}
