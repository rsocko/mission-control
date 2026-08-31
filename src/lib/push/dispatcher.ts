import 'server-only';

import type {
  ClaimedNotificationDelivery,
  NotificationDeliveryRepository,
} from '@/db/persistence/notification-delivery';
import { getTimezone } from '@/lib/mode';
import type { MissionControlPushPayload } from '@/lib/notifications/push-payload';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import logger from '@/lib/logger';
import { isApnsConfigured } from './apns-config';
import { sendApnsPayload } from './apns-sender';
import { sendWebPushPayload, type PushSendResult } from './web-push-sender';

export const DEFAULT_PUSH_LEASE_MS = 60_000;
export const DEFAULT_MAX_PUSH_ATTEMPTS = 5;
export const DEFAULT_PUSH_RETRY_BASE_MS = 30_000;
export const MAX_PUSH_RETRY_DELAY_MS = 60 * 60 * 1_000;
export const DEFAULT_DISPATCH_BATCH_SIZE = 25;

export type { ClaimedNotificationDelivery };

export interface DispatchNotificationDeliveriesOptions {
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  batchSize?: number;
  scheduleWakeups?: boolean;
  sender?: (payload: MissionControlPushPayload) => Promise<PushSendResult>;
  apnsSender?: (payload: MissionControlPushPayload) => Promise<PushSendResult>;
  repository?: NotificationDeliveryRepository;
}

function getCurrentHour(now: Date, timezone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now);
  return Number.parseInt(formatted, 10);
}

function isWebPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function calculateRetryDelayMs(
  attemptCount: number,
  baseMs = DEFAULT_PUSH_RETRY_BASE_MS,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(baseMs * (2 ** exponent), MAX_PUSH_RETRY_DELAY_MS);
}

async function resolveRepository(
  repository?: NotificationDeliveryRepository,
): Promise<NotificationDeliveryRepository> {
  return repository ?? (await getWorkerPersistenceRepositories()).notificationDelivery;
}

export async function claimNotificationDelivery(
  now = new Date(),
  leaseMs = DEFAULT_PUSH_LEASE_MS,
  maxAttempts = DEFAULT_MAX_PUSH_ATTEMPTS,
  repository?: NotificationDeliveryRepository,
): Promise<ClaimedNotificationDelivery | null> {
  return (await resolveRepository(repository)).claimNext({ now, leaseMs, maxAttempts });
}

async function persistFinalization(
  repository: NotificationDeliveryRepository,
  claim: ClaimedNotificationDelivery,
  values: Parameters<NotificationDeliveryRepository['finalize']>[1],
): Promise<void> {
  if (!await repository.finalize(claim, values)) {
    logger.warn(
      { deliveryEventId: claim.id, channel: claim.channel },
      'Push delivery finalization rejected after claim ownership changed',
    );
  }
}

async function scheduleRetry(
  repository: NotificationDeliveryRepository,
  claim: ClaimedNotificationDelivery,
  now: Date,
  result: PushSendResult | null,
  retryBaseMs: number,
): Promise<void> {
  const nextAttemptAt = new Date(
    now.getTime() + calculateRetryDelayMs(claim.attemptCount, retryBaseMs),
  ).toISOString();
  if (!await repository.scheduleRetry(claim, {
    nextAttemptAt,
    counters: result ?? undefined,
    lastError: 'transient_delivery_failure',
  })) {
    logger.warn(
      { deliveryEventId: claim.id, channel: claim.channel },
      'Push delivery retry rejected after claim ownership changed',
    );
  }
}

async function dispatchClaim(
  repository: NotificationDeliveryRepository,
  claim: ClaimedNotificationDelivery,
  now: Date,
  options: Required<Pick<
    DispatchNotificationDeliveriesOptions,
    'maxAttempts' | 'retryBaseMs'
  >>,
  sender: (payload: MissionControlPushPayload) => Promise<PushSendResult>,
): Promise<void> {
  const suppressionReason = await repository.resolveSuppression(claim, {
    now,
    currentHour: getCurrentHour(now, getTimezone()),
    channelConfigured: claim.channel === 'web_push'
      ? isWebPushConfigured()
      : isApnsConfigured(),
  });
  if (suppressionReason) {
    await persistFinalization(repository, claim, {
      status: 'suppressed',
      suppressionReason,
    });
    return;
  }

  let result: PushSendResult;
  try {
    result = await sender(claim.payloadSnapshot);
  } catch (error) {
    logger.error(
      { err: error, deliveryEventId: claim.id, channel: claim.channel },
      'Push channel sender failed',
    );
    if (claim.attemptCount < options.maxAttempts) {
      await scheduleRetry(repository, claim, now, null, options.retryBaseMs);
    } else {
      await persistFinalization(repository, claim, {
        status: 'failed',
        lastError: 'retry_limit_exhausted',
      });
    }
    return;
  }

  if (result.classification === 'no_subscription') {
    await persistFinalization(repository, claim, {
      status: 'suppressed',
      suppressionReason: 'no_subscription',
      counters: result,
    });
    return;
  }
  if (result.classification === 'channel_unconfigured') {
    await persistFinalization(repository, claim, {
      status: 'suppressed',
      suppressionReason: 'channel_unconfigured',
      counters: result,
    });
    return;
  }
  if (result.sent > 0 && result.failed === 0) {
    await persistFinalization(repository, claim, {
      status: 'sent',
      counters: result,
      sentAt: now.toISOString(),
    });
    return;
  }
  if (result.sent > 0) {
    await persistFinalization(repository, claim, {
      status: 'partial',
      counters: result,
      sentAt: now.toISOString(),
      lastError: 'partial_delivery_failure',
    });
    return;
  }
  if (result.transientFailures > 0 && claim.attemptCount < options.maxAttempts) {
    await scheduleRetry(repository, claim, now, result, options.retryBaseMs);
    return;
  }
  await persistFinalization(repository, claim, {
    status: 'failed',
    counters: result,
    lastError: result.transientFailures > 0
      ? 'retry_limit_exhausted'
      : 'permanent_delivery_failure',
  });
}

let dispatcherWakeTimer: ReturnType<typeof setTimeout> | null = null;

async function scheduleNextDispatcherWake(
  repository: NotificationDeliveryRepository,
): Promise<void> {
  const dueAt = await repository.getNextWakeAt();
  if (!dueAt) return;
  const delay = Math.max(0, new Date(dueAt).getTime() - Date.now());
  dispatcherWakeTimer = setTimeout(() => {
    dispatcherWakeTimer = null;
    void import('@/lib/notifications/dispatcher-wake')
      .then(({ wakeNotificationDeliveryDispatcher }) => {
        wakeNotificationDeliveryDispatcher();
      })
      .catch(error => {
        logger.error({ err: error }, 'Scheduled push delivery dispatch failed');
      });
  }, Math.min(delay, 2_147_483_647));
  dispatcherWakeTimer.unref?.();
}

export async function dispatchNotificationDeliveries(
  options: DispatchNotificationDeliveriesOptions = {},
): Promise<number> {
  const repository = await resolveRepository(options.repository);
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DEFAULT_PUSH_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_PUSH_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_PUSH_RETRY_BASE_MS;
  const batchSize = options.batchSize ?? DEFAULT_DISPATCH_BATCH_SIZE;
  const sender = options.sender
    ?? ((payload) => sendWebPushPayload(payload, { repository }));
  const apnsSender = options.apnsSender
    ?? ((payload) => sendApnsPayload(payload, { repository }));
  const scheduleWakeups = options.scheduleWakeups
    ?? (
      options.now === undefined
      && options.sender === undefined
      && options.apnsSender === undefined
      && options.repository === undefined
    );
  if (scheduleWakeups && dispatcherWakeTimer) {
    clearTimeout(dispatcherWakeTimer);
    dispatcherWakeTimer = null;
  }
  let processed = 0;

  while (processed < batchSize) {
    const claimedAt = now();
    let claim: ClaimedNotificationDelivery | null;
    try {
      claim = await repository.claimNext({
        now: claimedAt,
        leaseMs,
        maxAttempts,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to claim push delivery event');
      break;
    }
    if (!claim) break;
    await dispatchClaim(
      repository,
      claim,
      claimedAt,
      { maxAttempts, retryBaseMs },
      claim.channel === 'apns' ? apnsSender : sender,
    );
    processed += 1;
  }

  if (scheduleWakeups) await scheduleNextDispatcherWake(repository);
  return processed;
}
