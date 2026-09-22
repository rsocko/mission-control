import { NextResponse } from 'next/server';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { executeFencedGitHubTaskMutation } from '@/lib/external-identities';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { TagLinkedTaskRow } from '@/lib/tasks/core/contracts';

/** Reads one field off a decoded JSON body without widening it to `any`. */
function readField(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.getOwnPropertyDescriptor(body, key)?.value;
}

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
    const body: unknown = await request.json();
    const tagId = readField(body, 'tagId');

    if (!tagId || typeof tagId !== 'string') {
      return ApiErrors.badRequest('tagId is required');
    }

    // Look up the tag and every task it is linked to in one read.
    const persistence = await getTaskCorePersistence();
    const context = await persistence.organization.getTagSourceRemovalContext(tagId);
    const tag = context.tag;
    if (!tag) {
      return ApiErrors.notFound('Tag');
    }
    if (context.tasks.length === 0) {
      return NextResponse.json({ success: true, removed: 0 });
    }

    // Group tasks by connector instance
    const byConnector = new Map<string, TagLinkedTaskRow[]>();
    for (const task of context.tasks) {
      if (!task.connectorInstanceId || task.connectorInstanceId === 'local') continue;
      const list = byConnector.get(task.connectorInstanceId) || [];
      list.push(task);
      byConnector.set(task.connectorInstanceId, list);
    }

    const management = await getConnectorManagementPersistence();
    let removedCount = 0;
    const errors: string[] = [];

    for (const [connectorInstanceId, sourceTasks] of byConnector) {
      // Verify connector exists
      const connectorRow = await management.getConnector(connectorInstanceId);
      if (!connectorRow || connectorRow.deletedAt !== null) continue;

      // Get or initialize the connector
      const connector = await getOrInitializeConnector(connectorInstanceId);
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
