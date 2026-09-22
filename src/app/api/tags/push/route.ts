import { NextResponse } from 'next/server';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { executeFencedGitHubSourceMutation } from '@/lib/external-identities';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

/** Reads one field off a decoded JSON body without widening it to `any`. */
function readField(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.getOwnPropertyDescriptor(body, key)?.value;
}

/**
 * POST /api/tags/push — Push a hub tag to a source connector as a label/category.
 *
 * Body: { tagId: string, sourceListId: string }
 *
 * For per-list connectors (e.g. GitHub), sourceListId identifies which repo
 * to create the label on. The endpoint resolves the connector instance from
 * the source list row, initializes it, and calls createTagInSource().
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const tagId = readField(body, 'tagId');
    const sourceListId = readField(body, 'sourceListId');

    if (
      typeof tagId !== 'string' || !tagId
      || typeof sourceListId !== 'string' || !sourceListId
    ) {
      return NextResponse.json(
        { error: 'tagId and sourceListId are required' },
        { status: 400 },
      );
    }

    // Look up the tag
    const persistence = await getTaskCorePersistence();
    const tag = await persistence.organization.getTagPushSubject(tagId);
    if (!tag) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    // Look up the source list to find the connector instance
    const management = await getConnectorManagementPersistence();
    const list = await management.getSourceList(sourceListId);
    if (!list) {
      return NextResponse.json({ error: 'Source list not found' }, { status: 404 });
    }

    const connectorInstanceId = list.connectorInstanceId;

    // Verify connector exists and is not deleted
    const connectorRow = await management.getConnector(connectorInstanceId);
    if (!connectorRow || connectorRow.deletedAt !== null) {
      return NextResponse.json(
        { error: 'Connector not found or deleted' },
        { status: 404 },
      );
    }
    if (!isSourceListSelected(connectorRow, list)) {
      return NextResponse.json(
        { error: 'sourceListId is not selected for sync' },
        { status: 400 },
      );
    }

    // Get or initialize the connector
    const connector = await getOrInitializeConnector(connectorInstanceId);
    if (!connector) {
      return NextResponse.json(
        { error: 'Failed to initialize connector' },
        { status: 500 },
      );
    }

    if (!connector.createTagInSource) {
      return NextResponse.json(
        { error: `Connector "${connectorRow.type}" does not support creating tags` },
        { status: 422 },
      );
    }

    // Push the tag to the source (sourceId on the list row is the repo slug, e.g. "owner/repo")
    if (connector.type === 'github-issues') {
      await executeFencedGitHubSourceMutation({
        connectorInstanceId,
        sourceListId: list.id,
        operation: 'label',
        connector,
        write: () => connector.createTagInSource!(list.sourceId, tag.name, tag.color || undefined),
      });
    } else {
      await connector.createTagInSource(list.sourceId, tag.name, tag.color || undefined);
    }

    logger.info(
      { tagId, tagName: tag.name, sourceListId, connectorType: connectorRow.type },
      'Tag pushed to source',
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to push tag to source');
    return ApiErrors.internal('Failed to push tag', error);
  }
}
