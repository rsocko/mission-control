import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import type { RestoreMode } from '@/lib/sync/deletion-recovery';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import type { GitHubRecoveryPreflight } from '@/lib/sync/deletion-recovery';
import type {
  DeletionPersistence,
  DeletionSnapshotRecord,
} from '@/db/persistence/connector-execution';
import { getConnectorDeletionPersistence } from '@/lib/connectors/management-service';

async function getSourceRestoreBlockReason(
  persistence: DeletionPersistence,
  snapshot: Pick<DeletionSnapshotRecord, 'connectorId' | 'taskData'>,
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
    const parent = await persistence.getRestoreParent(task.parentId);
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
  const persistence = await getConnectorDeletionPersistence();
  const snapshot = await persistence.getSnapshot(id);
  if (!snapshot) return ApiErrors.notFound('Removed task snapshot');

  const task = snapshot.taskData;
  const sourceRestoreBlockReason = await getSourceRestoreBlockReason(persistence, snapshot);

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
    const persistence = await getConnectorDeletionPersistence();
    let githubPreflight: GitHubRecoveryPreflight | undefined;
    if (mode === 'source') {
      const snapshot = await persistence.getSnapshot(id);
      if (!snapshot) return ApiErrors.notFound('Removed task snapshot');
      const blockReason = await getSourceRestoreBlockReason(persistence, snapshot);
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

    const result = await persistence.restoreDeletionSnapshot(id, mode, githubPreflight);
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
