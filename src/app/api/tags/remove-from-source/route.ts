import { NextResponse } from 'next/server';
import db from '@/db';
import { tags, taskTags, tasks, connectorConfigs } from '@/db/schema';
import { eq, inArray, and, isNull } from 'drizzle-orm';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { executeFencedGitHubTaskMutation } from '@/lib/external-identities';

/**
 * POST /api/tags/remove-from-source — Remove a tag from the source system for all linked tasks.
 *
 * Body: { tagId: string }
 *
 * For each task linked to this tag that has a source connector supporting
 * removeTagFromTask, calls the connector to remove the label/tag.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { tagId } = body;

    if (!tagId || typeof tagId !== 'string') {
      return ApiErrors.badRequest('tagId is required');
    }

    // Look up the tag
    const [tag] = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
    if (!tag) {
      return ApiErrors.notFound('Tag');
    }

    // Find all tasks linked to this tag
    const linkedTaskIds = await db
      .select({ taskId: taskTags.taskId })
      .from(taskTags)
      .where(eq(taskTags.tagId, tagId));

    if (linkedTaskIds.length === 0) {
      return NextResponse.json({ success: true, removed: 0 });
    }

    // Get task details for source write-back
    const taskIds = linkedTaskIds.map(r => r.taskId);
    const linkedTasks = await db
      .select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorInstanceId: tasks.connectorInstanceId,
      })
      .from(tasks)
      .where(inArray(tasks.id, taskIds));

    // Group tasks by connector instance
    const byConnector = new Map<string, typeof linkedTasks>();
    for (const task of linkedTasks) {
      if (!task.connectorInstanceId || task.connectorInstanceId === 'local') continue;
      const list = byConnector.get(task.connectorInstanceId) || [];
      list.push(task);
      byConnector.set(task.connectorInstanceId, list);
    }

    let removedCount = 0;
    const errors: string[] = [];

    for (const [connectorInstanceId, sourceTasks] of byConnector) {
      // Verify connector exists
      const [connectorRow] = await db
        .select({ id: connectorConfigs.id, type: connectorConfigs.type })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, connectorInstanceId),
            isNull(connectorConfigs.deletedAt),
          ),
        );
      if (!connectorRow) continue;

      // Get or initialize the connector
      let connector = connectorRegistry.getConnector(connectorInstanceId) ?? null;
      if (!connector) {
        connector = await syncScheduler.initializeConnectorFromDb(connectorInstanceId);
      }
      if (!connector || !connector.removeTagFromTask) continue;

      for (const task of sourceTasks) {
        try {
          await executeFencedGitHubTaskMutation({
            connectorInstanceId,
            taskId: task.id,
            operation: 'label',
            connector,
            write: () => connector.removeTagFromTask!(task.sourceId, tag.name),
          });
          removedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ sourceId: task.sourceId, tagName: tag.name, error: msg }, 'Failed to remove tag from source task');
          errors.push(`${task.sourceId}: ${msg}`);
        }
      }
    }

    logger.info(
      { tagId, tagName: tag.name, removedCount, errorCount: errors.length },
      'Tag removed from source tasks',
    );

    return NextResponse.json({
      success: true,
      removed: removedCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to remove tag from source');
    return ApiErrors.internal('Failed to remove tag from source', error);
  }
}
