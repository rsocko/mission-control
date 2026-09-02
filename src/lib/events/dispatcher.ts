import 'server-only';

import { randomUUID } from 'node:crypto';
import type {
  ClaimedEventDelivery,
  EventDeliveryRepositories,
} from '@/db/persistence/event-outbox';
import logger from '@/lib/logger';
import {
  deliverEvent,
  DEFAULT_EVENT_DELIVERY_TIMEOUT_MS,
  type EventDeliveryOutcome,
} from './delivery';
import { resolveEventDeliveryRepositories } from './repositories';

export const DEFAULT_EVENT_LEASE_MS = 60_000;
export const DEFAULT_MAX_EVENT_ATTEMPTS = 6;
export const DEFAULT_EVENT_RETRY_BASE_MS = 15_000;
export const MAX_EVENT_RETRY_DELAY_MS = 60 * 60 * 1_000;
export const DEFAULT_EVENT_DISPATCH_BATCH_SIZE = 25;
export const DEFAULT_STALE_LEASE_SWEEP_MS = 60_000;

export interface DispatchEventDeliveriesOptions {
  now?: () => Date;
  owner?: string;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  batchSize?: number;
  deliveryTimeoutMs?: number;
  scheduleWakeups?: boolean;
  repositories?: EventDeliveryRepositories;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export function calculateEventRetryDelayMs(
  attemptCount: number,
  baseMs = DEFAULT_EVENT_RETRY_BASE_MS,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(baseMs * (2 ** exponent), MAX_EVENT_RETRY_DELAY_MS);
}

/**
 * Safe log/persist context. Deliberately excludes the webhook URL, its secret
 * and the event payload — only opaque identifiers, the event type and stable
 * failure codes ever leave this module.
 */
function describeClaim(claim: ClaimedEventDelivery) {
  return {
    deliveryId: claim.id,
    eventSequence: claim.eventSequence,
    eventType: claim.eventType,
    webhookId: claim.webhook.id,
    attemptCount: claim.attemptCount,
  };
}

interface HeartbeatHandle {
  signal: AbortSignal;
  stop: () => void;
}

/**
 * Keeps the lease alive for the duration of an in-flight delivery and aborts
 * the request the moment the claim is fenced out, so a dispatcher that lost
 * ownership stops talking to the receiver instead of racing the new owner.
 */
function startHeartbeat(
  repositories: EventDeliveryRepositories,
  claim: ClaimedEventDelivery,
  leaseMs: number,
): HeartbeatHandle {
  const controller = new AbortController();
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void (async () => {
      try {
        const extended = await repositories.outbox.heartbeat(
          claim,
          new Date(Date.now() + leaseMs).toISOString(),
        );
        if (!extended) {
          logger.warn(describeClaim(claim), 'Event delivery lease was fenced out mid-flight');
          controller.abort(new Error('event_delivery_lease_lost'));
        }
      } catch (error) {
        logger.error({ err: error, ...describeClaim(claim) }, 'Event delivery heartbeat failed');
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}

async function finalizeClaim(
  repositories: EventDeliveryRepositories,
  claim: ClaimedEventDelivery,
  outcome: EventDeliveryOutcome,
  now: Date,
  options: { maxAttempts: number; retryBaseMs: number },
): Promise<void> {
  await repositories.subscriptions.recordDeliveryOutcome({
    webhookId: claim.webhook.id,
    triggeredAt: now.toISOString(),
    status: outcome.status,
  });

  if (outcome.kind === 'delivered') {
    if (!await repositories.outbox.markDelivered(claim, {
      deliveredAt: now.toISOString(),
      lastStatus: outcome.status,
    })) {
      logger.warn(describeClaim(claim), 'Event delivery completion rejected by lease fencing');
    }
    return;
  }

  const signingConfigurationMissing = outcome.code === 'signing_secret_missing';
  const exhausted = outcome.kind === 'permanent' || claim.attemptCount >= options.maxAttempts;
  if (exhausted) {
    const lastError = outcome.kind === 'permanent'
      ? (outcome.code ?? 'permanent_delivery_failure')
      : 'retry_limit_exhausted';
    if (!await repositories.outbox.deadLetter(claim, {
      lastError,
      lastStatus: outcome.status,
    })) {
      logger.warn(describeClaim(claim), 'Event delivery dead-letter rejected by lease fencing');
      return;
    }
    logger.error(
      { ...describeClaim(claim), status: outcome.status, failureCode: lastError },
      'Event delivery moved to dead letter',
    );
    return;
  }

  const nextAttemptAt = new Date(
    now.getTime() + calculateEventRetryDelayMs(claim.attemptCount, options.retryBaseMs),
  ).toISOString();
  if (signingConfigurationMissing) {
    logger.error(
      { ...describeClaim(claim), failureCode: outcome.code },
      'Event delivery is waiting for signing configuration',
    );
  }
  if (!await repositories.outbox.scheduleRetry(claim, {
    nextAttemptAt,
    lastError: outcome.code ?? 'transient_delivery_failure',
    lastStatus: outcome.status,
  })) {
    logger.warn(describeClaim(claim), 'Event delivery retry rejected by lease fencing');
  }
}

let dispatcherWakeTimer: ReturnType<typeof setTimeout> | null = null;

async function scheduleNextDispatcherWake(
  repositories: EventDeliveryRepositories,
): Promise<void> {
  const dueAt = await repositories.outbox.getNextWakeAt();
  if (!dueAt) return;
  const delay = Math.max(0, new Date(dueAt).getTime() - Date.now());
  dispatcherWakeTimer = setTimeout(() => {
    dispatcherWakeTimer = null;
    void import('./dispatcher-wake')
      .then(({ wakeEventOutboxDispatcher }) => wakeEventOutboxDispatcher())
      .catch((error) => {
        logger.error({ err: error }, 'Scheduled event outbox dispatch failed');
      });
  }, Math.min(delay, 2_147_483_647));
  dispatcherWakeTimer.unref?.();
}

export function clearEventDispatcherWakeTimer(): void {
  if (dispatcherWakeTimer) {
    clearTimeout(dispatcherWakeTimer);
    dispatcherWakeTimer = null;
  }
}

/**
 * Drains up to `batchSize` claimable deliveries. At-least-once: a delivery is
 * only marked delivered after the receiver returned a 2xx, so a crash between
 * the HTTP call and the status write results in a retry, not a loss.
 */
export async function dispatchEventDeliveries(
  options: DispatchEventDeliveriesOptions = {},
): Promise<number> {
  const repositories = await resolveEventDeliveryRepositories(options.repositories);
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? defaultDispatcherOwner();
  const leaseMs = options.leaseMs ?? DEFAULT_EVENT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_EVENT_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_EVENT_RETRY_BASE_MS;
  const batchSize = options.batchSize ?? DEFAULT_EVENT_DISPATCH_BATCH_SIZE;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_EVENT_DELIVERY_TIMEOUT_MS;
  const scheduleWakeups = options.scheduleWakeups
    ?? (options.now === undefined && options.repositories === undefined);
  if (scheduleWakeups) clearEventDispatcherWakeTimer();

  let processed = 0;
  while (processed < batchSize) {
    if (options.signal?.aborted) break;
    const claimedAt = now();
    let claim: ClaimedEventDelivery | null;
    try {
      claim = await repositories.outbox.claimNext({ now: claimedAt, leaseMs, owner });
    } catch (error) {
      logger.error({ err: error }, 'Failed to claim an event outbox delivery');
      break;
    }
    if (!claim) break;

    const heartbeat = startHeartbeat(repositories, claim, leaseMs);
    let outcome: EventDeliveryOutcome;
    try {
      outcome = await deliverEvent(
        { url: claim.webhook.url, secret: claim.webhook.secret },
        { eventType: claim.eventType, payload: claim.payload },
        {
          timeoutMs: deliveryTimeoutMs,
          signal: heartbeat.signal,
          fetchImpl: options.fetchImpl,
        },
      );
    } finally {
      heartbeat.stop();
    }

    await finalizeClaim(repositories, claim, outcome, now(), { maxAttempts, retryBaseMs });
    processed += 1;
  }

  if (scheduleWakeups && !options.signal?.aborted) {
    await scheduleNextDispatcherWake(repositories);
  }
  return processed;
}

let cachedOwner: string | null = null;
function defaultDispatcherOwner(): string {
  cachedOwner ??= `${process.env.MC_PROCESS_ROLE ?? 'web'}:${process.pid}:${randomUUID()}`;
  return cachedOwner;
}

export async function recoverStaleEventDeliveryLeases(
  options: { repositories?: EventDeliveryRepositories; now?: Date } = {},
): Promise<number> {
  const repositories = await resolveEventDeliveryRepositories(options.repositories);
  const recovered = await repositories.outbox.recoverStaleLeases({
    now: options.now ?? new Date(),
  });
  if (recovered > 0) {
    logger.warn({ recovered }, 'Recovered stale event outbox delivery leases');
  }
  return recovered;
}

export interface EventOutboxDispatcherOptions extends DispatchEventDeliveriesOptions {
  staleLeaseSweepMs?: number;
}

/**
 * Long-lived dispatcher owned by the sync worker runtime: recovers stale leases
 * at startup and on a periodic sweep, then drains the outbox on every wake.
 * `stop()` waits for the in-flight drain so shutdown never abandons a lease it
 * could have released.
 */
export class EventOutboxDispatcher {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private stopped = false;
  private abortController = new AbortController();
  private readonly owner: string;

  constructor(private readonly options: EventOutboxDispatcherOptions = {}) {
    this.owner = options.owner ?? defaultDispatcherOwner();
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    const { registerEventOutboxDrain } = await import('./dispatcher-wake');
    registerEventOutboxDrain(() => this.drain());
    await this.sweep();
    const sweepMs = this.options.staleLeaseSweepMs ?? DEFAULT_STALE_LEASE_SWEEP_MS;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, sweepMs);
    this.sweepTimer.unref?.();
    void this.drain();
  }

  private async sweep(): Promise<void> {
    if (this.stopped) return;
    try {
      await recoverStaleEventDeliveryLeases({ repositories: this.options.repositories });
      await this.drain();
    } catch (error) {
      logger.error({ err: error }, 'Event outbox stale lease sweep failed');
    }
  }

  async drain(): Promise<number> {
    if (this.stopped) return 0;
    if (this.running) {
      await this.running;
      return this.stopped ? 0 : this.drain();
    }
    const run = dispatchEventDeliveries({
        ...this.options,
        owner: this.owner,
        signal: this.abortController.signal,
      })
      .catch((error) => {
        logger.error({ err: error }, 'Event outbox dispatch failed');
        return 0;
      })
      .finally(() => {
        if (this.running === run) this.running = null;
      });
    this.running = run;
    return run;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const { registerEventOutboxDrain, clearEventOutboxWakeRetry } = await import(
      './dispatcher-wake'
    );
    registerEventOutboxDrain(null);
    clearEventOutboxWakeRetry();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.abortController.abort();
    await this.running;
    this.running = null;
    clearEventDispatcherWakeTimer();
  }
}
