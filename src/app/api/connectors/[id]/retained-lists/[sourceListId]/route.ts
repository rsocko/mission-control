import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { ApiErrors } from '@/lib/api-error';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { deleteTaskLocally } from '@/lib/tasks/local-task-lifecycle';
import {
  ConnectorOperationBusyError,
  runWithConnectorOperationLease,
} from '@/lib/sync/connector-lock';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; sourceListId: string }> },
) {
  const { id, sourceListId } = await params;

  try {
    const { operationalUtility } = await getWorkerPersistenceRepositories();
    if (!operationalUtility) {
      return NextResponse.json(
        { error: 'Operational utility persistence is not available in the selected backend' },
        { status: 503 },
      );
    }
    const retained = operationalUtility.retainedSourceLists;

    const result = await runWithConnectorOperationLease(id, 'retention', async () => {
      const { connector, sourceList } = await retained.loadSnapshot({
        connectorId: id,
        sourceListId,
      });
      if (!connector) return { kind: 'connector-not-found' } as const;
      if (connector.type !== 'github-issues') return { kind: 'unsupported' } as const;
      if (!sourceList) return { kind: 'source-list-not-found' } as const;
      if (isSourceListSelected(connector, sourceList)) return { kind: 'selected' } as const;

      const taskIds = await retained.listRetainedTaskIds({
        connectorId: id,
        sourceListSourceId: sourceList.sourceId,
      });

      // The source-list row is removed only after every local task delete
      // succeeded, so a failure leaves the list visible and retryable.
      for (const taskId of taskIds) await deleteTaskLocally(taskId);
      await retained.deleteSourceList({ connectorId: id, sourceListId: sourceList.id });
      return {
        kind: 'deleted',
        sourceListId: sourceList.id,
        deletedTasks: taskIds.length,
      } as const;
    });

    if (result.kind === 'connector-not-found') return ApiErrors.notFound('Connector');
    if (result.kind === 'unsupported') {
      return ApiErrors.badRequest('Retained-list purge is only available for GitHub repositories');
    }
    if (result.kind === 'source-list-not-found') return ApiErrors.notFound('Source list');
    if (result.kind === 'selected') {
      return ApiErrors.conflict('Remove the repository from sync before deleting its retained items');
    }
    return NextResponse.json({
      success: true,
      sourceListId: result.sourceListId,
      deletedTasks: result.deletedTasks,
      writeBack: 'none',
    });
  } catch (error) {
    if (error instanceof ConnectorOperationBusyError) {
      return ApiErrors.conflict('Connector has an active operation');
    }
    return ApiErrors.internal('Failed to delete retained repository items', error);
  }
}
