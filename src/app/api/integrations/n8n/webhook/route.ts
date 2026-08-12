import db from '@/db';
import { notifications, notificationActions, tasks } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getN8nConfig, parseN8NSettings } from '@/lib/integrations/n8n';
import { ApiErrors } from '@/lib/api-error';
import { normalizeNotificationLevel } from '@/lib/notifications/levels';
import { indexNotificationSearch } from '@/lib/search';

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

async function syncOpenUrlAction(notificationId: string, actionUrl?: string | null, label = 'Open') {
  await db.delete(notificationActions).where(and(
    eq(notificationActions.notificationId, notificationId),
    eq(notificationActions.actionType, 'open_url'),
  ));

  if (!actionUrl) {
    return;
  }

  await db.insert(notificationActions).values({
    id: crypto.randomUUID(),
    notificationId,
    actionType: 'open_url',
    label,
    variant: 'primary',
    isPrimary: true,
    sortOrder: 0,
    payload: { url: actionUrl },
    opensExternal: true,
    createdBy: 'connector',
  });
}

async function reindexNotification(id: string) {
  const [notification] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  if (notification) await indexNotificationSearch(notification);
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

    switch (type) {
      case 'task.create': {
        const id = crypto.randomUUID();
        const sourceId = asString(payload.sourceId, `n8n:${id}`);

        await db.insert(tasks).values({
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
          depth: 0,
          isChecklistItem: false,
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

        await db.insert(notifications).values({
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
        });

        await syncOpenUrlAction(id, actionUrl);
        await reindexNotification(id);

        return Response.json({ success: true, created: 'alert', id }, { status: 201 });
      }

      case 'shipment.update': {
        const sourceId = asString(payload.sourceId, asString(payload.shipmentId, `shipment:${crypto.randomUUID()}`));
        const [existing] = await db
          .select()
          .from(notifications)
          .where(and(eq(notifications.connectorType, 'n8n'), eq(notifications.sourceId, sourceId)))
          .limit(1);

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

        if (existing) {
          await db.update(notifications).set(values).where(eq(notifications.id, existing.id));
          await syncOpenUrlAction(existing.id, actionUrl);
          await reindexNotification(existing.id);
          return Response.json({ success: true, updated: 'shipment', id: existing.id });
        }

        const id = crypto.randomUUID();
        await db.insert(notifications).values({ id, ...values, presentation: {} });
        await syncOpenUrlAction(id, actionUrl);
        await reindexNotification(id);
        return Response.json({ success: true, created: 'shipment', id }, { status: 201 });
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

        await db.insert(notifications).values({
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
        });

        await syncOpenUrlAction(id, actionUrl);
        await reindexNotification(id);

        return Response.json({ success: true, created: category, id }, { status: 201 });
      }

      default:
        return Response.json({ error: `Unsupported webhook type: ${type}` }, { status: 400 });
    }
  } catch (error) {
    return ApiErrors.internal('Failed to process n8n webhook', error);
  }
}
