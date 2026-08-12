import { createHmac } from 'crypto';
import db from '@/db';
import { outboundWebhooks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';

export type MCEventType =
  | 'task.created'
  | 'task.completed'
  | 'task.overdue'
  | 'task.updated'
  | 'alert.received'
  | 'alert.dismissed'
  | 'sync.completed'
  | 'sync.failed'
  | 'finance.notification'
  | 'finance.threshold_exceeded'
  | 'project.status_changed';

export interface MCEvent {
  type: MCEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface OutboundWebhookRecord {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  eventTypes: string[] | unknown;
  enabled: boolean;
}

function matchesEventType(webhook: OutboundWebhookRecord, eventType: MCEventType) {
  const eventTypes = Array.isArray(webhook.eventTypes) ? webhook.eventTypes : [];
  return webhook.enabled && eventTypes.includes(eventType);
}

function buildSignature(payload: string, secret?: string | null) {
  const signingSecret = secret || process.env.MC_EVENT_SECRET || '';
  if (!signingSecret) {
    return '';
  }

  return `sha256=${createHmac('sha256', signingSecret).update(payload).digest('hex')}`;
}

export async function sendWebhookEvent(
  webhook: OutboundWebhookRecord,
  event: MCEvent,
): Promise<{ ok: boolean; status: number | null }> {
  const payload = JSON.stringify(event.payload);
  const triggeredAt = new Date().toISOString();

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MC-Event': event.type,
        'X-MC-Signature': buildSignature(payload, webhook.secret),
      },
      body: payload,
    });

    await db
      .update(outboundWebhooks)
      .set({
        lastTriggeredAt: triggeredAt,
        lastStatus: response.status,
      })
      .where(eq(outboundWebhooks.id, webhook.id));

    if (!response.ok) {
      logger.error({ webhookName: webhook.name, status: response.status }, 'Webhook delivery returned a non-OK status');
    }

    return { ok: response.ok, status: response.status };
  } catch (error) {
    await db
      .update(outboundWebhooks)
      .set({
        lastTriggeredAt: triggeredAt,
        lastStatus: null,
      })
      .where(eq(outboundWebhooks.id, webhook.id))
      .catch((err: unknown) => { logger.error({ err, webhookName: webhook.name }, 'Failed to update webhook status'); });

    logger.error({ err: error, webhookName: webhook.name }, 'Webhook delivery failed');
    return { ok: false, status: null };
  }
}

export async function emitEvent(event: MCEvent): Promise<void> {
  let subscriptions;
  try {
    subscriptions = await db.select().from(outboundWebhooks);
  } catch {
    // Table may not exist yet; skip silently
    return;
  }
  const matchingWebhooks = subscriptions.filter((webhook) =>
    matchesEventType(webhook as OutboundWebhookRecord, event.type),
  ) as OutboundWebhookRecord[];

  if (!matchingWebhooks.length) {
    return;
  }

  void Promise.allSettled(
    matchingWebhooks.map((webhook) => sendWebhookEvent(webhook, event)),
  );
}
