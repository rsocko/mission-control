import { NextResponse } from 'next/server';
import db from '@/db';
import { notifications, notificationActions } from '@/db/schema';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { enrichAlert } from '@/lib/notifications/enrichment';
import { materializeNotificationActions } from '@/lib/notifications/providers';
import type { InboundNotification } from '@/types';
import { randomUUID } from 'crypto';

/**
 * POST /api/notifications/re-enrich
 *
 * Re-runs the enrichment pipeline on existing notifications.
 * Useful after parser improvements, AI model upgrades, or new entity data.
 *
 * Body:
 *   - scope: 'all' | 'unenriched' | 'connector' | 'ids' (default: 'unenriched')
 *   - connectorType?: string (required when scope = 'connector')
 *   - ids?: string[] (required when scope = 'ids')
 *   - enableAI?: boolean (default: false — opt-in for bulk re-enrichment)
 *   - limit?: number (default: 100, max: 500)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const scope = (body.scope as string) || 'unenriched';
    const connectorType = body.connectorType as string | undefined;
    const ids = body.ids as string[] | undefined;
    const enableAI = body.enableAI === true;
    const limit = Math.min(Math.max(parseInt(body.limit || '100', 10), 1), 500);

    // ─── Build query based on scope ────────────────────────────────────
    let rows: Array<{
      id: string;
      sourceId: string;
      connectorType: string;
      connectorInstanceId: string;
      title: string;
      body: string | null;
      level: string;
      category: string;
      state: string;
      readState: string;
      isActionable: boolean;
      metadata: unknown;
    }>;

    switch (scope) {
      case 'all':
        rows = await db.select({
          id: notifications.id,
          sourceId: notifications.sourceId,
          connectorType: notifications.connectorType,
          connectorInstanceId: notifications.connectorInstanceId,
          title: notifications.title,
          body: notifications.body,
          level: notifications.level,
          category: notifications.category,
          state: notifications.state,
          readState: notifications.readState,
          isActionable: notifications.isActionable,
          metadata: notifications.metadata,
        })
          .from(notifications)
          .orderBy(desc(notifications.receivedAt))
          .limit(limit);
        break;

      case 'unenriched':
        // Notifications that haven't been enriched yet (empty presentation or no enrichment metadata)
        rows = await db.select({
          id: notifications.id,
          sourceId: notifications.sourceId,
          connectorType: notifications.connectorType,
          connectorInstanceId: notifications.connectorInstanceId,
          title: notifications.title,
          body: notifications.body,
          level: notifications.level,
          category: notifications.category,
          state: notifications.state,
          readState: notifications.readState,
          isActionable: notifications.isActionable,
          metadata: notifications.metadata,
        })
          .from(notifications)
          .where(
            sql`json_extract(${notifications.metadata}, '$.enrichment') IS NULL`
          )
          .orderBy(desc(notifications.receivedAt))
          .limit(limit);
        break;

      case 'connector':
        if (!connectorType) {
          return ApiErrors.badRequest('connectorType is required when scope is "connector"');
        }
        rows = await db.select({
          id: notifications.id,
          sourceId: notifications.sourceId,
          connectorType: notifications.connectorType,
          connectorInstanceId: notifications.connectorInstanceId,
          title: notifications.title,
          body: notifications.body,
          level: notifications.level,
          category: notifications.category,
          state: notifications.state,
          readState: notifications.readState,
          isActionable: notifications.isActionable,
          metadata: notifications.metadata,
        })
          .from(notifications)
          .where(eq(notifications.connectorType, connectorType))
          .orderBy(desc(notifications.receivedAt))
          .limit(limit);
        break;

      case 'ids':
        if (!ids?.length) {
          return ApiErrors.badRequest('ids array is required when scope is "ids"');
        }
        rows = await db.select({
          id: notifications.id,
          sourceId: notifications.sourceId,
          connectorType: notifications.connectorType,
          connectorInstanceId: notifications.connectorInstanceId,
          title: notifications.title,
          body: notifications.body,
          level: notifications.level,
          category: notifications.category,
          state: notifications.state,
          readState: notifications.readState,
          isActionable: notifications.isActionable,
          metadata: notifications.metadata,
        })
          .from(notifications)
          .where(inArray(notifications.id, ids.slice(0, 500)));
        break;

      default:
        return ApiErrors.badRequest(`Invalid scope: ${scope}. Use 'all', 'unenriched', 'connector', or 'ids'.`);
    }

    // ─── Re-enrich each notification ──────────────────────────────────
    let enriched = 0;
    let linked = 0;
    let aiEnriched = 0;
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>;

        // Build a pseudo-InboundNotification for the enrichment pipeline
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
        const primaryActionId = actionRecords.find(action => action.isPrimary)?.id || null;

        db.transaction(tx => {
          tx.update(notifications)
            .set({
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
              ...(result.providerSignature
                ? {
                    isActionable: result.isActionable,
                    primaryActionId,
                  }
                : {}),
            })
            .where(eq(notifications.id, row.id))
            .run();

          if (result.providerSignature) {
            tx.delete(notificationActions)
              .where(and(
                eq(notificationActions.notificationId, row.id),
                eq(notificationActions.createdBy, 'connector'),
                eq(notificationActions.executionState, 'pending'),
              ))
              .run();
            if (actionRecords.length > 0) {
              tx.insert(notificationActions).values(actionRecords).run();
            }
          }
        });

        enriched++;
      } catch (err) {
        errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
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
  } catch (err) {
    return ApiErrors.internal(err instanceof Error ? err.message : 'Re-enrichment failed');
  }
}
