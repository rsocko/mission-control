import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { enrichAlert } from '@/lib/notifications/enrichment';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import { materializeNotificationActions } from '@/lib/notifications/providers';
import type { InboundNotification } from '@/types';

/**
 * POST /api/notifications/re-enrich
 *
 * Re-runs the enrichment pipeline on existing notifications.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const scope = (body.scope as string) || 'unenriched';
    const connectorType = body.connectorType as string | undefined;
    const ids = body.ids as string[] | undefined;
    const enableAI = body.enableAI === true;
    const limit = Math.min(Math.max(parseInt(body.limit || '100', 10), 1), 500);
    const persistence = await getNotificationWebPersistence();

    let selection:
      | { scope: 'all'; limit: number }
      | { scope: 'unenriched'; limit: number }
      | { scope: 'connector'; connectorType: string; limit: number }
      | { scope: 'ids'; ids: string[] };
    switch (scope) {
      case 'all':
      case 'unenriched':
        selection = { scope, limit };
        break;
      case 'connector':
        if (!connectorType) {
          return ApiErrors.badRequest('connectorType is required when scope is "connector"');
        }
        selection = { scope, connectorType, limit };
        break;
      case 'ids':
        if (!ids?.length) {
          return ApiErrors.badRequest('ids array is required when scope is "ids"');
        }
        selection = { scope, ids: ids.slice(0, 500) };
        break;
      default:
        return ApiErrors.badRequest(
          `Invalid scope: ${scope}. Use 'all', 'unenriched', 'connector', or 'ids'.`,
        );
    }

    const rows = await persistence.listNotificationsForReEnrichment(selection);
    let enriched = 0;
    let linked = 0;
    let aiEnriched = 0;
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const metadata = (
          typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
        ) as Record<string, unknown>;
        const notificationItem: InboundNotification = {
          id: row.id,
          sourceId: row.sourceId,
          connectorType: row.connectorType,
          connectorInstanceId: row.connectorInstanceId,
          title: row.title,
          body: row.body || undefined,
          level: row.level as InboundNotification['level'],
          category: row.category,
          isRead: row.readState !== 'unread',
          isActionable: row.isActionable,
          receivedAt: new Date().toISOString(),
          hubProjectIds: [],
          tags: [],
          metadata,
        };

        const result = await enrichAlert(notificationItem, {
          enableAI,
          enableEntityLinking: true,
        });
        if (result.relatedTaskId || result.relatedProjectId) linked++;
        if (result.aiEnrichment) aiEnriched++;

        const enrichedMetadata = {
          ...result.metadata,
          enrichment: {
            ...(result.metadata.enrichment as Record<string, unknown> || {}),
            reEnrichedAt: new Date().toISOString(),
          },
        };
        const actionRecords = materializeNotificationActions(
          row.id,
          result.actions,
          randomUUID,
        );
        await persistence.saveReEnrichedNotification({
          id: row.id,
          title: result.title,
          body: result.body,
          category: result.category,
          templateKey: result.templateKey,
          relatedTaskId: result.relatedTaskId,
          relatedProjectId: result.relatedProjectId,
          relatedEntityType: result.relatedEntityType,
          relatedEntityId: result.relatedEntityId,
          navigationTarget: result.navigationTarget,
          metadata: enrichedMetadata,
          presentation: result.presentation,
          providerSignature: Boolean(result.providerSignature),
          isActionable: result.isActionable,
          primaryActionId: actionRecords.find(action => action.isPrimary)?.id || null,
          actions: actionRecords,
        });
        enriched++;
      } catch (error) {
        errors.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return NextResponse.json({
      success: true,
      processed: rows.length,
      enriched,
      linked,
      aiEnriched,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    });
  } catch (error) {
    return ApiErrors.internal(
      error instanceof Error ? error.message : 'Re-enrichment failed',
    );
  }
}
