import { NextResponse } from 'next/server';
import db from '@/db';
import { tags, connectorConfigs, sourceLists } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { executeFencedGitHubSourceMutation } from '@/lib/external-identities';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';

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
    const body = await request.json();
    const { tagId, sourceListId } = body;

    if (!tagId || !sourceListId) {
      return NextResponse.json(
        { error: 'tagId and sourceListId are required' },
        { status: 400 },
      );
    }

    // Look up the tag
    const [tag] = await db.select().from(tags).where(eq(tags.id, tagId)).limit(1);
    if (!tag) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    // Look up the source list to find the connector instance
    const [list] = await db
      .select()
      .from(sourceLists)
      .where(eq(sourceLists.id, sourceListId))
      .limit(1);
    if (!list) {
      return NextResponse.json({ error: 'Source list not found' }, { status: 404 });
    }

    const connectorInstanceId = list.connectorInstanceId;

    // Verify connector exists and is not deleted
    const [connectorRow] = await db
      .select({
        id: connectorConfigs.id,
        type: connectorConfigs.type,
        settings: connectorConfigs.settings,
        syncedLists: connectorConfigs.syncedLists,
      })
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.id, connectorInstanceId),
          isNull(connectorConfigs.deletedAt),
        ),
      );
    if (!connectorRow) {
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
    let connector =
      connectorRegistry.getConnector(connectorInstanceId) ?? null;
    if (!connector) {
      connector = await syncScheduler.initializeConnectorFromDb(
        connectorInstanceId,
      );
    }
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
