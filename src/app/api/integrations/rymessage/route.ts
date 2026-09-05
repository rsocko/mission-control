import logger from '@/lib/logger';
import { normalizeNotificationLevel } from '@/lib/notifications/levels';
import { indexAlert, removeAlertFromIndex } from '@/lib/search/fts';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication-service';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { WebhookSearchableNotification } from '@/db/persistence/webhook-integrations';

/**
 * RyMessage Inbound Webhook
 *
 * Receives action lifecycle events from RyMessage's Action Center.
 * Handles: action.created, action.updated, action.dismissed, action.handled, action.snoozed
 *
 * Authentication: None for now (LAN trust).
 * TODO: Add X-Webhook-Secret header validation when moving to production.
 */

type WebhookEvent = {
  event: string;
  action: RyMessageActionPayload;
  timestamp?: string;
  deviceId?: string;
};

type RyMessageActionPayload = {
  id: string;
  stableKey: string;
  chatGuid: string;
  messageGuid?: string;
  sourceKind?: string;
  actionType?: string;
  kind?: string;
  title: string;
  summary?: string;
  reason?: string;
  confidence?: string;
  confidenceScore?: number;
  detectionSource?: string;
  lifecycleState?: string;
  severity?: string;
  recommendation?: string;
  direction?: string;
  senderLabel?: string;
  chatLabel?: string;
  messageTextSnippet?: string;
  snoozedUntil?: number;
  taskLinkId?: string;
  taskProviderId?: string;
  taskProviderTaskId?: string;
  taskStatusCached?: string;
  createdAt?: string;
  updatedAt?: string;
};

const CONNECTOR_TYPE = 'rymessage';
// Use a fixed instance ID for webhook-pushed alerts (matches connector config)
const CONNECTOR_INSTANCE_ID = 'rymessage-webhook';

function mapSeverity(severity?: string): string {
  switch (severity) {
    case 'critical': return 'critical';
    case 'focus': return 'high';
    case 'safe': return 'low';
    default: return 'medium';
  }
}

function mapCategory(kind?: string): string {
  switch (kind) {
    case 'mfa_code': return 'security';
    case 'travel_departure':
    case 'travel_arrival':
    case 'travel_delay': return 'travel';
    case 'delivery_status':
    case 'delivery_address': return 'delivery';
    case 'scheduling_meeting':
    case 'scheduling_deadline':
    case 'appointment': return 'calendar';
    case 'direct_question':
    case 'commitment':
    case 'request_for_action':
    case 'approval_decision': return 'action-required';
    default: return 'message';
  }
}

function isActionable(recommendation?: string): boolean {
  return ['reply', 'create-task', 'review'].includes(recommendation || '');
}

function buildSourceId(action: RyMessageActionPayload): string {
  return `rymessage:${action.stableKey || action.id}`;
}

function buildAlertBody(action: RyMessageActionPayload): string | null {
  const parts: string[] = [];
  if (action.senderLabel) parts.push(`From: ${action.senderLabel}`);
  if (action.chatLabel) parts.push(`in ${action.chatLabel}`);
  if (action.messageTextSnippet) parts.push(`"${action.messageTextSnippet.slice(0, 120)}"`);
  if (action.summary) parts.push(action.summary);
  return parts.length > 0 ? parts.join(' — ') : null;
}

/**
 * Keyword indexing stays inline and immediate; the semantic side is only
 * published. This mirrors `indexNotificationSearch`/`removeNotificationSearch`
 * without importing the SQLite-bound search barrel from a neutral route.
 */
async function reindexNotification(notification: WebhookSearchableNotification) {
  await indexAlert(notification);
  await publishSemanticEntityUpsert('alert', notification.id);
}

async function removeNotificationFromSearch(notificationId: string) {
  await removeAlertFromIndex(notificationId);
  await publishSemanticEntityDelete('alert', notificationId);
}

export async function POST(request: Request) {
  try {
    // TODO: Add X-Webhook-Secret validation here when ready
    // const secret = request.headers.get('X-Webhook-Secret');
    // if (expectedSecret && secret !== expectedSecret) {
    //   return Response.json({ error: 'Unauthorized' }, { status: 401 });
    // }

    const body = await request.json() as WebhookEvent;
    const { event, action } = body;

    if (!event || !action?.id) {
      return Response.json({ error: 'Missing event type or action.id' }, { status: 400 });
    }

    const sourceId = buildSourceId(action);
    const now = new Date().toISOString();
    const ingest = (await getWorkerPersistenceRepositories()).webhookIntegrations.ingest;

    switch (event) {
      case 'action.created': {
        const { level, levelRank } = normalizeNotificationLevel(mapSeverity(action.severity));
        const id = crypto.randomUUID();

        // Idempotent: an existing notification for this source is updated in place.
        const result = await ingest.upsertNotificationBySource({
          match: { connectorType: CONNECTOR_TYPE, sourceId },
          insert: {
            id,
            sourceId,
            connectorType: CONNECTOR_TYPE,
            connectorInstanceId: CONNECTOR_INSTANCE_ID,
            title: action.title,
            body: buildAlertBody(action),
            level,
            levelRank,
            category: mapCategory(action.kind),
            state: 'unread',
            isActionable: isActionable(action.recommendation),
            receivedAt: action.createdAt || now,
            sortAt: now,
            expiresAt: null,
            relatedTaskId: action.taskLinkId || null,
            metadata: action as unknown as Record<string, unknown>,
            presentation: {},
          },
          update: {
            title: action.title,
            body: buildAlertBody(action),
            level,
            levelRank,
            category: mapCategory(action.kind),
            isActionable: isActionable(action.recommendation),
            sortAt: now,
            metadata: action as unknown as Record<string, unknown>,
          },
        });
        await reindexNotification(result.search);

        return result.created
          ? Response.json({ success: true, action: 'created', id: result.id }, { status: 201 })
          : Response.json({ success: true, action: 'updated', id: result.id });
      }

      case 'action.updated': {
        const { level, levelRank } = normalizeNotificationLevel(mapSeverity(action.severity));
        const id = crypto.randomUUID();

        const result = await ingest.upsertNotificationBySource({
          match: { connectorType: CONNECTOR_TYPE, sourceId },
          insert: {
            id,
            sourceId,
            connectorType: CONNECTOR_TYPE,
            connectorInstanceId: CONNECTOR_INSTANCE_ID,
            title: action.title,
            body: buildAlertBody(action),
            level,
            levelRank,
            category: mapCategory(action.kind),
            state: 'unread',
            isActionable: isActionable(action.recommendation),
            receivedAt: action.createdAt || now,
            sortAt: now,
            expiresAt: null,
            relatedTaskId: action.taskLinkId || null,
            metadata: action as unknown as Record<string, unknown>,
            presentation: {},
          },
          update: {
            title: action.title,
            body: buildAlertBody(action),
            level,
            levelRank,
            category: mapCategory(action.kind),
            isActionable: isActionable(action.recommendation),
            relatedTaskId: action.taskLinkId || null,
            sortAt: now,
            metadata: action as unknown as Record<string, unknown>,
          },
        });
        await reindexNotification(result.search);

        return result.created
          ? Response.json({ success: true, action: 'created', id: result.id }, { status: 201 })
          : Response.json({ success: true, action: 'updated', id: result.id });
      }

      case 'action.dismissed':
      case 'action.handled':
      case 'action.completed': {
        // Terminal states — remove the notification
        const deletedId = await ingest.deleteNotificationBySource({
          connectorType: CONNECTOR_TYPE,
          sourceId,
        });

        if (deletedId) {
          await removeNotificationFromSearch(deletedId);
          return Response.json({ success: true, action: 'deleted', id: deletedId });
        }

        return Response.json({ success: true, action: 'noop', reason: 'notification not found' });
      }

      case 'action.snoozed': {
        const snoozedUntil = action.snoozedUntil
          ? new Date(action.snoozedUntil).toISOString()
          : null;

        const snoozedId = await ingest.snoozeNotificationBySource({
          connectorType: CONNECTOR_TYPE,
          sourceId,
          snoozedUntil,
          metadata: {
            ...(action as unknown as Record<string, unknown>),
            snoozedUntil: action.snoozedUntil,
          },
        });

        if (snoozedId) {
          return Response.json({ success: true, action: 'snoozed', id: snoozedId });
        }

        return Response.json({ success: true, action: 'noop', reason: 'notification not found' });
      }

      default:
        return Response.json({ error: `Unsupported event: ${event}` }, { status: 400 });
    }
  } catch (error) {
    logger.error({ err: error }, 'RyMessage webhook request failed');
    return Response.json(
      { error: 'Failed to process webhook', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

/**
 * GET returns endpoint info and supported events (for discovery/health check)
 */
export async function GET() {
  return Response.json({
    name: 'RyMessage Action Center Webhook',
    status: 'active',
    supportedEvents: [
      'action.created',
      'action.updated',
      'action.dismissed',
      'action.handled',
      'action.completed',
      'action.snoozed',
    ],
    // TODO: authentication not yet required (LAN trust)
    authRequired: false,
  });
}
