import { getN8nConfig, parseN8NSettings } from '@/lib/integrations/n8n';
import { ApiErrors } from '@/lib/api-error';
import { normalizeNotificationLevel } from '@/lib/notifications/levels';
import { indexAlert } from '@/lib/search/fts';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication-service';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  WebhookIngestRepository,
  WebhookSearchableNotification,
} from '@/db/persistence/webhook-integrations';

type N8NWebhookBody = {
  type?: string;
  payload?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Keyword indexing stays inline and immediate; the semantic side is only
 * published. This mirrors `indexNotificationSearch` without importing the
 * SQLite-bound search barrel from a backend-neutral route.
 */
async function reindexNotification(notification: WebhookSearchableNotification) {
  await indexAlert(notification);
  await publishSemanticEntityUpsert('alert', notification.id);
}

export async function POST(request: Request) {
  try {
    const config = await getN8nConfig();
    const settings = parseN8NSettings(config?.settings);
    const incomingSecret = request.headers.get('X-N8N-Secret');

    if (settings.webhookSecret && incomingSecret !== settings.webhookSecret) {
      return Response.json({ error: 'Invalid n8n secret' }, { status: 401 });
    }

    const body = await request.json() as N8NWebhookBody;
    const type = body.type;
    const payload = asRecord(body.payload);
    const now = new Date().toISOString();
    const connectorInstanceId = config?.id || 'n8n';

    if (!type) {
      return Response.json({ error: 'Webhook type is required' }, { status: 400 });
    }

    const ingest: WebhookIngestRepository = (await getWorkerPersistenceRepositories())
      .webhookIntegrations.ingest;

    switch (type) {
      case 'task.create': {
        const id = crypto.randomUUID();
        const sourceId = asString(payload.sourceId, `n8n:${id}`);

        await ingest.createTask({
          id,
          sourceId,
          connectorType: 'n8n',
          connectorInstanceId,
          title: asString(payload.title, 'New task'),
          description: asString(payload.description) || null,
          status: asString(payload.status, 'todo'),
          priority: asString(payload.priority, 'none'),
          dueDate: asString(payload.dueDate) || null,
          createdAt: now,
          updatedAt: now,
          completedAt: asString(payload.status) === 'done' ? now : null,
          sourceListId: asString(payload.sourceListId) || null,
          sourceListName: asString(payload.sourceListName) || null,
          assignee: asString(payload.assignee) || null,
          metadata: payload,
          syncStatus: 'synced',
          lastSyncedAt: now,
        });

        return Response.json({ success: true, created: 'task', id }, { status: 201 });
      }

      case 'alert.create': {
        const id = crypto.randomUUID();
        const actionUrl = asString(payload.actionUrl) || null;
        const { level, levelRank } = normalizeNotificationLevel(payload.severity);
        const isActionable = asBoolean(payload.isActionable, Boolean(actionUrl)) && Boolean(actionUrl);

        const search = await ingest.createNotification({
          notification: {
            id,
            sourceId: asString(payload.sourceId, `n8n:${id}`),
            connectorType: 'n8n',
            connectorInstanceId,
            title: asString(payload.title, 'New alert'),
            body: asString(payload.body) || null,
            level,
            levelRank,
            category: asString(payload.category, 'n8n'),
            state: 'unread',
            isActionable,
            receivedAt: now,
            sortAt: now,
            expiresAt: asString(payload.expiresAt) || null,
            relatedTaskId: asString(payload.relatedTaskId) || null,
            metadata: payload,
            presentation: {},
          },
          openUrlAction: { url: actionUrl, label: 'Open' },
        });

        await reindexNotification(search);

        return Response.json({ success: true, created: 'alert', id }, { status: 201 });
      }

      case 'shipment.update': {
        const sourceId = asString(payload.sourceId, asString(payload.shipmentId, `shipment:${crypto.randomUUID()}`));
        const actionUrl = asString(payload.actionUrl) || null;
        const { level, levelRank } = normalizeNotificationLevel(payload.severity);
        const isActionable = asBoolean(payload.isActionable, Boolean(actionUrl)) && Boolean(actionUrl);

        const values = {
          sourceId,
          connectorType: 'n8n',
          connectorInstanceId,
          title: asString(payload.title, 'Shipment update'),
          body: asString(payload.body, asString(payload.status, 'Shipment status updated')) || null,
          level,
          levelRank,
          category: 'shipment',
          state: 'unread' as const,
          isActionable,
          receivedAt: now,
          sortAt: now,
          expiresAt: asString(payload.expiresAt) || null,
          metadata: payload,
        };

        const id = crypto.randomUUID();
        const result = await ingest.upsertNotificationBySource({
          match: { connectorType: 'n8n', sourceId },
          insert: { id, ...values, presentation: {} },
          update: values,
          openUrlAction: { url: actionUrl, label: 'Open' },
        });

        await reindexNotification(result.search);

        return result.created
          ? Response.json({ success: true, created: 'shipment', id: result.id }, { status: 201 })
          : Response.json({ success: true, updated: 'shipment', id: result.id });
      }

      case 'reminder':
      case 'custom': {
        const id = crypto.randomUUID();
        const category = type === 'reminder'
          ? 'reminder'
          : asString(payload.category, 'custom');
        const actionUrl = asString(payload.actionUrl) || null;
        const { level, levelRank } = normalizeNotificationLevel(payload.severity);
        const isActionable = asBoolean(payload.isActionable, Boolean(actionUrl)) && Boolean(actionUrl);

        const search = await ingest.createNotification({
          notification: {
            id,
            sourceId: asString(payload.sourceId, `n8n:${id}`),
            connectorType: 'n8n',
            connectorInstanceId,
            title: asString(payload.title, type === 'reminder' ? 'Reminder' : 'Custom alert'),
            body: asString(payload.body) || null,
            level,
            levelRank,
            category,
            state: 'unread',
            isActionable,
            receivedAt: now,
            sortAt: now,
            expiresAt: asString(payload.expiresAt) || null,
            relatedTaskId: asString(payload.relatedTaskId) || null,
            metadata: payload,
            presentation: {},
          },
          openUrlAction: { url: actionUrl, label: 'Open' },
        });

        await reindexNotification(search);

        return Response.json({ success: true, created: category, id }, { status: 201 });
      }

      default:
        return Response.json({ error: `Unsupported webhook type: ${type}` }, { status: 400 });
    }
  } catch (error) {
    return ApiErrors.internal('Failed to process n8n webhook', error);
  }
}
