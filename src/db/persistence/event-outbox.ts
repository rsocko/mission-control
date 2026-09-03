/**
 * Layer 2 durable event outbox — backend-neutral persistence contracts.
 *
 * Outbound webhook delivery used to be fire-and-forget: `emitEvent` selected
 * matching subscriptions and dropped a floating `Promise.allSettled` on the
 * floor. Terminal sync transitions therefore lost their `sync.completed` /
 * `sync.failed` notification whenever the process exited, the network blipped,
 * or the receiver was briefly unavailable.
 *
 * These contracts replace that with a durable outbox:
 *
 * - `enqueue` writes one `event_outbox` row keyed by a caller-supplied
 *   `stableKey` plus one `event_outbox_deliveries` row per matching webhook.
 *   Re-enqueueing the same `stableKey` is a no-op, so sync-job retries and
 *   worker restarts cannot duplicate a delivery.
 * - The dispatcher claims deliveries under an owner/token fenced lease, so a
 *   partitioned or stalled worker can never finalize work that has since been
 *   recovered by another owner.
 * - Delivery is at-least-once with deterministic per-webhook ordering: only the
 *   lowest-sequence non-terminal delivery for a webhook is claimable.
 */

import { decodeStrictJsonObject } from './value-codecs';

export type EventOutboxDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'dead_letter';

/** A subscription that is eligible to receive a given event type. */
export interface EventSubscriptionRecord {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  eventTypes: unknown;
  enabled: boolean;
}

/** A single durable event awaiting (or past) fan-out. */
export interface EventOutboxRecord {
  sequence: number;
  stableKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

/** Input for a durable enqueue. `stableKey` is the idempotency key. */
export interface EventOutboxEnqueueRequest {
  stableKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  /** Deterministic delivery identifiers, one per matching webhook. */
  deliveryIdFactory?: () => string;
}

export interface EventOutboxEnqueueResult {
  /** False when `stableKey` already existed — the enqueue was deduplicated. */
  created: boolean;
  sequence: number;
  deliveryCount: number;
}

/**
 * A leased delivery. `leaseToken` fences every subsequent write: a claim that
 * has been recovered by another owner can no longer finalize, retry or extend.
 */
export interface ClaimedEventDelivery {
  id: string;
  eventSequence: number;
  eventType: string;
  stableKey: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  attemptCount: number;
  webhook: EventSubscriptionRecord;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface EventDeliveryClaimInput {
  now: Date;
  leaseMs: number;
  owner: string;
}

export interface EventDeliveryRetryInput {
  nextAttemptAt: string;
  lastError: string;
  lastStatus?: number | null;
}

export interface EventDeliveryFailureInput {
  lastError: string;
  lastStatus?: number | null;
}

/**
 * Webhook subscription reads and delivery-status writes, routed through the
 * selected backend rather than a direct `db` handle.
 */
export interface EventSubscriptionPersistence {
  /** Enabled subscriptions whose `eventTypes` include `eventType`. */
  listMatching(eventType: string): Promise<EventSubscriptionRecord[]>;
  /** Records the outcome of an attempt against the subscription record. */
  recordDeliveryOutcome(input: {
    webhookId: string;
    triggeredAt: string;
    status: number | null;
  }): Promise<void>;
}

export interface EventOutboxPersistence {
  enqueue(request: EventOutboxEnqueueRequest): Promise<EventOutboxEnqueueResult>;
  claimNext(input: EventDeliveryClaimInput): Promise<ClaimedEventDelivery | null>;
  /** Extends a held lease. Returns false when the claim has been fenced out. */
  heartbeat(claim: ClaimedEventDelivery, leaseExpiresAt: string): Promise<boolean>;
  markDelivered(
    claim: ClaimedEventDelivery,
    input: { deliveredAt: string; lastStatus: number | null },
  ): Promise<boolean>;
  scheduleRetry(claim: ClaimedEventDelivery, input: EventDeliveryRetryInput): Promise<boolean>;
  deadLetter(claim: ClaimedEventDelivery, input: EventDeliveryFailureInput): Promise<boolean>;
  /** Returns expired `delivering` rows to `pending`. Returns the row count. */
  recoverStaleLeases(input: { now: Date }): Promise<number>;
  /** ISO timestamp of the earliest claimable delivery, or null when idle. */
  getNextWakeAt(): Promise<string | null>;
}

export interface EventDeliveryRepositories {
  subscriptions: EventSubscriptionPersistence;
  outbox: EventOutboxPersistence;
}

/**
 * Shared subscription matching so both backends (and the transaction-scoped
 * enqueue helpers) agree on which webhooks receive an event.
 */
export function eventSubscriptionMatches(
  subscription: Pick<EventSubscriptionRecord, 'enabled' | 'eventTypes'>,
  eventType: string,
): boolean {
  if (!subscription.enabled) {
    return false;
  }
  const eventTypes = parseEventTypes(subscription.eventTypes);
  return eventTypes.includes(eventType);
}

export function parseEventTypes(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Parses a stored outbox payload. Corrupt rows surface loudly instead of being
 * silently delivered as `{}`.
 */
export function parseEventOutboxPayload(value: unknown): Record<string, unknown> {
  return decodeStrictJsonObject(value, {
    invalidJson: 'Stored event outbox payload is not valid JSON',
    notAnObject: 'Stored event outbox payload must be an object',
  });
}

export function isTerminalEventDeliveryStatus(status: string): boolean {
  return status === 'delivered' || status === 'dead_letter';
}
