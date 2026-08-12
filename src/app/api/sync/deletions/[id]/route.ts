import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import db from '@/db';
import { syncDeletionSnapshots, tasks } from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { restoreDeletionSnapshot, type RestoreMode } from '@/lib/sync/deletion-recovery';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import type { GitHubRecoveryPreflight } from '@/lib/sync/deletion-recovery';

type DeletionSnapshot = typeof syncDeletionSnapshots.$inferSelect;

async function getSourceRestoreBlockReason(
  snapshot: Pick<DeletionSnapshot, 'connectorId' | 'taskData'>,
): Promise<string | null> {
  if (snapshot.connectorId === 'local' || !(await isConnectorEnabled(snapshot.connectorId))) {
    return 'The original connector is unavailable';
  }

  const capabilities = await getConnectorCapabilities(snapshot.connectorId);
  if (!capabilities) return 'The original connector is unavailable';
  if (capabilities.write === false) return 'Write is disabled for the original connector';
  if (capabilities.taskCreate !== true) return 'The original connector cannot create tasks';

  const task = snapshot.taskData;
  if (task.isChecklistItem) {
    if (capabilities.subtasks !== true || !task.parentId) {
      return 'The original connector cannot recreate this subtask';
    }
    const [parent] = await db.select({
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
    })
      .from(tasks)
      .where(eq(tasks.id, task.parentId))
      .limit(1);
    if (
      !parent
      || parent.connectorInstanceId !== snapshot.connectorId
      || parent.sourceId.startsWith('local:')
      || !parent.sourceId.includes(':')
    ) {
      return 'The original parent task is unavailable';
    }
  }

  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [snapshot] = await db.select()
    .from(syncDeletionSnapshots)
    .where(eq(syncDeletionSnapshots.id, id))
    .limit(1);
  if (!snapshot) return ApiErrors.notFound('Removed task snapshot');

  const task = snapshot.taskData;
  const sourceRestoreBlockReason = await getSourceRestoreBlockReason(snapshot);

  return NextResponse.json({
    snapshot: {
      id: snapshot.id,
      originalTaskId: snapshot.originalTaskId,
      connectorId: snapshot.connectorId,
      sourceId: snapshot.sourceId,
      title: snapshot.taskTitle,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      connectorType: task.connectorType,
      sourceListName: task.sourceListName,
      reason: snapshot.reason,
      deletedAt: snapshot.deletedAt,
      restoredAt: snapshot.restoredAt,
      restoredTaskId: snapshot.restoredTaskId,
      restoreMode: snapshot.restoreMode,
      canRestoreToSource: sourceRestoreBlockReason === null,
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = body.mode as RestoreMode | undefined;
  if (mode !== 'local' && mode !== 'source') {
    return ApiErrors.badRequest('mode must be local or source');
  }

  try {
    let githubPreflight: GitHubRecoveryPreflight | undefined;
    if (mode === 'source') {
      const [snapshot] = await db.select({
        connectorId: syncDeletionSnapshots.connectorId,
        taskData: syncDeletionSnapshots.taskData,
      })
        .from(syncDeletionSnapshots)
        .where(eq(syncDeletionSnapshots.id, id))
        .limit(1);
      if (!snapshot) return ApiErrors.notFound('Removed task snapshot');
      const blockReason = await getSourceRestoreBlockReason(snapshot);
      if (blockReason) return ApiErrors.forbidden(blockReason);
      if (snapshot.taskData.connectorType === 'github-issues') {
        const connector = await getOrInitializeConnector(snapshot.connectorId) as {
          preflightWriteRoute?: GitHubRecoveryPreflight;
        } | null;
        if (!connector?.preflightWriteRoute) {
          return ApiErrors.forbidden('The original GitHub connector cannot verify recovery identity');
        }
        githubPreflight = connector.preflightWriteRoute.bind(connector);
      }
    }

    const result = await restoreDeletionSnapshot(id, mode, githubPreflight);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Removed task snapshot not found') {
      return ApiErrors.notFound('Removed task snapshot');
    }
    if (error instanceof Error && error.message === 'The original parent task is unavailable') {
      return ApiErrors.forbidden(error.message);
    }
    return ApiErrors.internal('Failed to restore removed task', error);
  }
}
