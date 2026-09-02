import { randomUUID } from 'crypto';
import type { EventDeliveryRepositories } from '@/db/persistence/event-outbox';
import logger from '@/lib/logger';
import { deliverEvent } from './delivery';
import { wakeEventOutboxDispatcher } from './dispatcher-wake';
import { resolveEventDeliveryRepositories } from './repositories';

export { resolveEventDeliveryRepositories };

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

export interface EmitEventOptions {
  /**
   * Idempotency key for the durable outbox. Callers with a durable identity of
   * their own (for example a terminal sync job) supply a derived key so a retry
   * cannot enqueue the same event twice. Omitted keys get a unique key, which
   * preserves the previous "every call emits" semantics for ad-hoc callers.
   */
  stableKey?: string;
  repositories?: EventDeliveryRepositories;
}

/**
 * One-shot signed delivery to an explicit webhook, used by the "send test
 * event" endpoint. Regular event emission goes through {@link emitEvent} and
 * the durable outbox instead.
 */
export async function sendWebhookEvent(
  webhook: OutboundWebhookRecord,
  event: MCEvent,
  options: { repositories?: EventDeliveryRepositories } = {},
): Promise<{ ok: boolean; status: number | null }> {
  const repositories = await resolveEventDeliveryRepositories(options.repositories);
  const triggeredAt = new Date().toISOString();
  const outcome = await deliverEvent(
    { url: webhook.url, secret: webhook.secret },
    { eventType: event.type, payload: event.payload },
  );

  await repositories.subscriptions.recordDeliveryOutcome({
    webhookId: webhook.id,
    triggeredAt,
    status: outcome.status,
  });

  if (outcome.kind !== 'delivered') {
    logger.error(
      {
        webhookId: webhook.id,
        eventType: event.type,
        status: outcome.status,
        failureCode: outcome.code,
      },
      'Webhook delivery attempt did not succeed',
    );
  }

  return { ok: outcome.kind === 'delivered', status: outcome.status };
}

/**
 * Durably enqueues an event for every matching outbound webhook.
 *
 * Persistence failures propagate to the caller: an event that could not be
 * recorded has not been emitted, and silently returning would recreate exactly
 * the lost-notification class this outbox exists to remove.
 */
export async function emitEvent(event: MCEvent, options: EmitEventOptions = {}): Promise<void> {
  const repositories = await resolveEventDeliveryRepositories(options.repositories);
  const result = await repositories.outbox.enqueue({
    stableKey: options.stableKey ?? `${event.type}:${event.timestamp}:${randomUUID()}`,
    eventType: event.type,
    payload: event.payload,
    occurredAt: event.timestamp,
  });

  if (result.created && result.deliveryCount > 0) {
    wakeEventOutboxDispatcher();
  }
}
