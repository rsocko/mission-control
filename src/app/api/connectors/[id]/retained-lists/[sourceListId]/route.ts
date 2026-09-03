import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import db from '@/db';
import { connectorConfigs, sourceLists, tasks } from '@/db/schema';
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
    const result = await runWithConnectorOperationLease(id, 'retention', async () => {
      const [connector] = await db.select().from(connectorConfigs)
        .where(eq(connectorConfigs.id, id))
        .limit(1);
      if (!connector) return { kind: 'connector-not-found' } as const;
      if (connector.type !== 'github-issues') return { kind: 'unsupported' } as const;

      const [sourceList] = await db.select().from(sourceLists)
        .where(and(
          eq(sourceLists.id, sourceListId),
          eq(sourceLists.connectorInstanceId, id),
        ))
        .limit(1);
      if (!sourceList) return { kind: 'source-list-not-found' } as const;
      if (isSourceListSelected(connector, sourceList)) return { kind: 'selected' } as const;

      const taskRows = await db.select({ id: tasks.id }).from(tasks)
        .where(and(
          eq(tasks.connectorInstanceId, id),
          eq(tasks.sourceListId, sourceList.sourceId),
        ));

      for (const task of taskRows) await deleteTaskLocally(task.id);
      await db.delete(sourceLists).where(eq(sourceLists.id, sourceList.id));
      return {
        kind: 'deleted',
        sourceListId: sourceList.id,
        deletedTasks: taskRows.length,
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
