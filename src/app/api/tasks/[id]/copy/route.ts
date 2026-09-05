import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

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

    const newId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { ancillary } = await getTaskCorePersistence();
    const outcome = await ancillary.copyTask({
      sourceTaskId: id,
      newTaskId: newId,
      targetConnectorInstanceId,
      targetListId: targetListId || null,
      keepTags,
      now,
    });
    if (outcome.kind === 'connector-not-found') {
      return NextResponse.json({ error: 'Connector instance not found' }, { status: 404 });
    }
    if (outcome.kind === 'source-list-not-found' || outcome.kind === 'source-list-not-selected') {
      return ApiErrors.badRequest('Target list is not selected for sync');
    }
    if (outcome.kind === 'task-not-found') {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: newId,
      message: `Task copied to ${outcome.connectorType}`,
      sourceId: id,
    }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to copy task', error);
  }
}
