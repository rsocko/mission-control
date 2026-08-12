import { NextResponse } from 'next/server';
import { getValidToken } from '@/lib/auth';
import { getTimezone } from '@/lib/mode';
import db, { runTransaction } from '@/db';
import { tasks, connectorConfigs } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { connectorLogger, dbLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/connectors/[id]/cross-account — Copy/move a task between accounts
 * Body: { taskId, targetInstanceId, action: 'copy' | 'move', targetListId? }
 * 
 * This enables moving tasks from Personal → Work (or vice versa) via Graph API.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sourceInstanceId } = await params;
  const body = await request.json();
  const { taskId, targetInstanceId, action, targetListId } = body;

  if (!taskId || !targetInstanceId || !action) {
    return NextResponse.json(
      { error: 'taskId, targetInstanceId, and action are required' },
      { status: 400 }
    );
  }

  if (action !== 'copy' && action !== 'move') {
    return NextResponse.json(
      { error: 'action must be "copy" or "move"' },
      { status: 400 }
    );
  }

  try {
    // Get source task, verifying it belongs to the source connector
    const [sourceTask] = await db.select().from(tasks).where(
      and(eq(tasks.id, taskId), eq(tasks.connectorInstanceId, sourceInstanceId))
    );
    if (!sourceTask) {
      return NextResponse.json({ error: 'Task not found for this connector' }, { status: 404 });
    }

    // Get target connector config
    const [targetConfig] = await db.select().from(connectorConfigs).where(eq(connectorConfigs.id, targetInstanceId));
    if (!targetConfig) {
      return NextResponse.json({ error: 'Target connector not found' }, { status: 404 });
    }

    // Get access token for target account
    const targetToken = await getValidToken(targetInstanceId);

    // Determine target list
    let listId = targetListId;
    if (!listId) {
      // Use the default task list
      const listsRes = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
        headers: { Authorization: `Bearer ${targetToken}` },
      });
      const lists = await listsRes.json();
      const defaultList = lists.value?.find((l: { wellknownListName: string }) => l.wellknownListName === 'defaultList')
        || lists.value?.[0];
      listId = defaultList?.id;
    }

    if (!listId) {
      return NextResponse.json({ error: 'No target list available' }, { status: 400 });
    }

    // Create task in target account via Graph API
    const createRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/todo/lists/${listId}/tasks`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${targetToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: sourceTask.title,
          body: sourceTask.description ? { content: sourceTask.description, contentType: 'text' } : undefined,
          importance: sourceTask.priority === 'critical' || sourceTask.priority === 'high' ? 'high'
            : sourceTask.priority === 'low' ? 'low' : 'normal',
          dueDateTime: sourceTask.dueDate ? {
            dateTime: `${sourceTask.dueDate}T00:00:00`,
            timeZone: getTimezone(),
          } : undefined,
        }),
      }
    );

    if (!createRes.ok) {
      const errorBody = await createRes.text();
      connectorLogger.error({ err: errorBody, status: createRes.status }, 'Graph API create failed in cross-account operation');
      return NextResponse.json({ error: 'Failed to create in target. The external service returned an error.' }, { status: 502 });
    }

    const created = await createRes.json();

    // Wrap local DB writes in a transaction (Graph API call stays outside)
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    try {
      runTransaction((tx) => {
        // If move (not copy), mark source as done or delete
        if (action === 'move') {
          tx.update(tasks).set({
            status: 'cancelled',
            updatedAt: now,
            metadata: JSON.stringify({
              ...(typeof sourceTask.metadata === 'string' ? JSON.parse(sourceTask.metadata) : sourceTask.metadata),
              movedTo: { instanceId: targetInstanceId, remoteId: created.id },
            }),
          }).where(eq(tasks.id, taskId)).run();
        }

        // Also create a local record for the new task in the target instance
        tx.insert(tasks).values({
          id: newId,
          sourceId: created.id,
          connectorType: targetConfig.type,
          connectorInstanceId: targetInstanceId,
          title: sourceTask.title,
          description: sourceTask.description,
          status: 'todo',
          priority: sourceTask.priority,
          dueDate: sourceTask.dueDate,
          createdAt: now,
          updatedAt: now,
          depth: 0,
          isChecklistItem: false,
          metadata: JSON.stringify({ graphId: created.id, listId }),
          syncStatus: 'synced',
          lastSyncedAt: now,
        }).run();
      });
    } catch (err) {
      dbLogger.error({ err, taskId, targetInstanceId, action, remoteId: created.id, op: 'crossAccountMove' },
        'Transaction rolled back: cross-account local writes failed after remote task was created');
      throw err;
    }

    return NextResponse.json({
      success: true,
      action,
      sourceTaskId: taskId,
      targetTaskId: newId,
      targetRemoteId: created.id,
      targetInstance: targetInstanceId,
    });
  } catch (error) {
    connectorLogger.error({ err: error }, 'Cross-account operation failed');
    return ApiErrors.internal('Operation failed', error);
  }
}
