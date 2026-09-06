import { NextResponse } from 'next/server';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import logger from '@/lib/logger';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';
import { resolveTaskEditPolicy } from '@/lib/tasks/edit-policy';
import { isDemoMode } from '@/lib/mode';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

/** Reads one field off a decoded JSON body without widening it to `any`. */
function readField(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.getOwnPropertyDescriptor(body, key)?.value;
}

/**
 * POST /api/tasks/[id]/move-to-list — Move a task to a different list within the same connector.
 *
 * Body: { targetListId: string }
 *
 * Every validating read runs first, then at most one remote move happens, and
 * only then is the local row finalized — so a failed remote move never leaves
 * a task pointing at a list it was never moved to.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body: unknown = await request.json();
    const targetListId = readField(body, 'targetListId');

    if (typeof targetListId !== 'string' || !targetListId) {
      return NextResponse.json(
        { error: 'targetListId is required' },
        { status: 400 }
      );
    }

    // Fetch the task
    const persistence = await getTaskCorePersistence();
    const task = await persistence.organization.getTaskMoveToListContext(id);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

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
    const management = await getConnectorManagementPersistence();
    const targetList = await management.getSourceList(targetListId);
    if (!targetList) {
      return NextResponse.json({ error: 'Target list not found' }, { status: 404 });
    }
    if (targetList.connectorInstanceId !== task.connectorInstanceId) {
      return ApiErrors.badRequest('Target list must belong to the task source');
    }
    const targetConnector = await management.getConnector(targetList.connectorInstanceId);
    if (!targetConnector || !isSourceListSelected(targetConnector, targetList)) {
      return ApiErrors.badRequest('Target list is not selected for sync');
    }

    let newSourceId: string | undefined;
    if (editPolicy.sourceModel !== 'mc-owned') {
      const connector = await getOrInitializeConnector(task.connectorInstanceId);
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
      const snapshot = await management.getConnectorListSnapshot(task.connectorInstanceId);
      previousListId = snapshot.sourceLists
        .find((list) => list.sourceId === previousSourceListId)?.id ?? null;
    }

    // Update local DB — sourceListId stores the remote list ID (sourceId), not DB id
    await persistence.organization.finalizeTaskMoveToList({
      taskId: id,
      sourceListId: targetList.sourceId,
      sourceId: newSourceId ?? null,
      updatedAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true, newSourceId, previousListId });
  } catch (error) {
    logger.error({ err: error, taskId: id }, 'Failed to move task to list');
    return ApiErrors.internal('Failed to move task', error);
  }
}
