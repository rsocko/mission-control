import 'server-only';

import { and, eq } from 'drizzle-orm';
import db, { sqlite } from '@/db';
import {
  connectorConfigs,
  inboundWebhooks,
  notificationDeliveryEvents,
  notifications,
} from '@/db/schema';
import {
  normalizeInternalNavigationTarget,
  resolveCurrentGlobalPushSuppression,
  type NotificationDeliveryChannel,
  type MissionControlPushPayload,
} from '@/lib/notifications/service';
import logger from '@/lib/logger';
import { needsAttention } from '@/lib/notifications/lifecycle';
import { sendApnsPayload } from './apns-sender';
import { sendWebPushPayload, type PushSendResult } from './web-push-sender';

export const DEFAULT_PUSH_LEASE_MS = 60_000;
export const DEFAULT_MAX_PUSH_ATTEMPTS = 5;
export const DEFAULT_PUSH_RETRY_BASE_MS = 30_000;
export const MAX_PUSH_RETRY_DELAY_MS = 60 * 60 * 1_000;
export const DEFAULT_DISPATCH_BATCH_SIZE = 25;

export interface ClaimedNotificationDelivery {
  id: string;
  notificationId: string;
  channel: NotificationDeliveryChannel;
  dedupeKey: string;
  attemptCount: number;
  payloadSnapshot: MissionControlPushPayload;
  leaseExpiresAt: string;
}

export interface DispatchNotificationDeliveriesOptions {
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  batchSize?: number;
  scheduleWakeups?: boolean;
  sender?: (payload: MissionControlPushPayload) => Promise<PushSendResult>;
  apnsSender?: (payload: MissionControlPushPayload) => Promise<PushSendResult>;
}

interface RawClaimedDelivery {
  id: string;
  notification_id: string;
  channel: string;
  dedupe_key: string;
  attempt_count: number;
  payload_snapshot: string;
  lease_expires_at: string;
}

function parsePayload(value: string): MissionControlPushPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Stored push payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored push payload must be an object');
  }
  const payload = parsed as Record<string, unknown>;
  if (
    typeof payload.notificationId !== 'string'
    || !payload.notificationId
    || typeof payload.title !== 'string'
    || !payload.title
    || typeof payload.tag !== 'string'
    || !payload.tag
    || typeof payload.url !== 'string'
    || !normalizeInternalNavigationTarget(payload.url)
    || (payload.body !== undefined && typeof payload.body !== 'string')
  ) {
    throw new Error('Stored push payload is invalid');
  }
  return {
    notificationId: payload.notificationId,
    title: payload.title,
    ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
    tag: payload.tag,
    url: payload.url,
  };
}

export function calculateRetryDelayMs(
  attemptCount: number,
  baseMs = DEFAULT_PUSH_RETRY_BASE_MS,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(baseMs * (2 ** exponent), MAX_PUSH_RETRY_DELAY_MS);
}

export function claimNotificationDelivery(
  now = new Date(),
  leaseMs = DEFAULT_PUSH_LEASE_MS,
  maxAttempts = DEFAULT_MAX_PUSH_ATTEMPTS,
): ClaimedNotificationDelivery | null {
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  sqlite.prepare(`
    UPDATE notification_delivery_events
    SET status = 'failed', lease_expires_at = NULL, next_attempt_at = NULL,
        last_error = 'retry_limit_exhausted'
    WHERE channel IN ('web_push', 'apns')
      AND attempt_count >= ?
      AND (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR
        (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
  `).run(maxAttempts, nowIso, nowIso);
  const claimStatement = sqlite.prepare(`
    UPDATE notification_delivery_events
    SET
      status = 'sending',
      attempt_count = attempt_count + 1,
      lease_expires_at = ?,
      last_error = NULL
    WHERE id = (
      SELECT id
      FROM notification_delivery_events
      WHERE channel IN ('web_push', 'apns')
        AND attempt_count < ?
        AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR
          (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
      ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
      LIMIT 1
    )
      AND (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR
        (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
    RETURNING id, notification_id, channel, dedupe_key, attempt_count, payload_snapshot, lease_expires_at
  `);

  while (true) {
    const row = claimStatement.get(
      leaseExpiresAt,
      maxAttempts,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
    ) as RawClaimedDelivery | undefined;
    if (!row) return null;

    try {
      return {
        id: row.id,
        notificationId: row.notification_id,
        channel: row.channel as NotificationDeliveryChannel,
        dedupeKey: row.dedupe_key,
        attemptCount: row.attempt_count,
        payloadSnapshot: parsePayload(row.payload_snapshot),
        leaseExpiresAt: row.lease_expires_at,
      };
    } catch (error) {
      sqlite.prepare(`
        UPDATE notification_delivery_events
        SET status = 'failed', lease_expires_at = NULL, next_attempt_at = NULL,
            last_error = 'invalid_payload'
        WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
      `).run(row.id, row.lease_expires_at);
      logger.error(
        { err: error, deliveryEventId: row.id },
        'Rejected invalid stored push payload',
      );
    }
  }
}

function finalizeDelivery(
  claim: ClaimedNotificationDelivery,
  values: {
    status: 'sent' | 'partial' | 'failed' | 'suppressed';
    suppressionReason?: string | null;
    result?: PushSendResult;
    sentAt?: string | null;
    lastError?: string | null;
  },
): void {
  db.update(notificationDeliveryEvents).set({
    status: values.status,
    suppressionReason: values.suppressionReason ?? null,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    subscriptionsAttempted: values.result?.attempted ?? 0,
    subscriptionsSent: values.result?.sent ?? 0,
    subscriptionsFailed: values.result?.failed ?? 0,
    sentAt: values.sentAt ?? null,
    lastError: values.lastError ?? null,
  }).where(and(
    eq(notificationDeliveryEvents.id, claim.id),
    eq(notificationDeliveryEvents.status, 'sending'),
    eq(notificationDeliveryEvents.leaseExpiresAt, claim.leaseExpiresAt),
  )).run();
}

function getConnectorSuppression(
  claim: ClaimedNotificationDelivery,
  now: Date,
): 'connector_deleted' | 'connector_disabled' | 'not_attention_eligible' | null {
  const notification = db.select({
    sourceId: notifications.sourceId,
    connectorType: notifications.connectorType,
    connectorInstanceId: notifications.connectorInstanceId,
    disposition: notifications.disposition,
    sourceState: notifications.sourceState,
    readState: notifications.readState,
    snoozedUntil: notifications.snoozedUntil,
    level: notifications.level,
  }).from(notifications).where(eq(notifications.id, claim.notificationId)).get();
  if (!notification) return 'not_attention_eligible';
  if (
    notification.connectorType === 'finance-manager'
    && (
      notification.sourceId.startsWith('finance-insight:')
      || notification.sourceId.startsWith('finance-insight-digest:')
    )
  ) {
    const cutover = sqlite.prepare(`
      SELECT delivery_enabled AS deliveryEnabled
      FROM finance_insight_cutovers
      WHERE connector_id = ?
    `).get(notification.connectorInstanceId) as { deliveryEnabled: number } | undefined;
    if (cutover?.deliveryEnabled !== 1) return 'connector_disabled';
  }
  if (!needsAttention(notification, now)) return 'not_attention_eligible';
  if (notification.connectorType === 'system') return null;

  if (notification.connectorType === 'inbound-webhook') {
    const webhook = db.select({ enabled: inboundWebhooks.enabled })
      .from(inboundWebhooks)
      .where(eq(inboundWebhooks.id, notification.connectorInstanceId))
      .get();
    if (!webhook) return 'connector_deleted';
    return webhook.enabled ? null : 'connector_disabled';
  }

  const connector = db.select({
    enabled: connectorConfigs.enabled,
    deletedAt: connectorConfigs.deletedAt,
  }).from(connectorConfigs).where(
    eq(connectorConfigs.id, notification.connectorInstanceId),
  ).get();
  if (!connector || connector.deletedAt !== null) return 'connector_deleted';
  return connector.enabled ? null : 'connector_disabled';
}

function scheduleRetry(
  claim: ClaimedNotificationDelivery,
  now: Date,
  result: PushSendResult | null,
  retryBaseMs: number,
): void {
  const nextAttemptAt = new Date(
    now.getTime() + calculateRetryDelayMs(claim.attemptCount, retryBaseMs),
  ).toISOString();
  db.update(notificationDeliveryEvents).set({
    status: 'pending',
    nextAttemptAt,
    leaseExpiresAt: null,
    subscriptionsAttempted: result?.attempted ?? 0,
    subscriptionsSent: result?.sent ?? 0,
    subscriptionsFailed: result?.failed ?? 0,
    lastError: 'transient_delivery_failure',
  }).where(and(
    eq(notificationDeliveryEvents.id, claim.id),
    eq(notificationDeliveryEvents.status, 'sending'),
    eq(notificationDeliveryEvents.leaseExpiresAt, claim.leaseExpiresAt),
  )).run();
}

async function dispatchClaim(
  claim: ClaimedNotificationDelivery,
  now: Date,
  options: Required<Pick<
    DispatchNotificationDeliveriesOptions,
    'maxAttempts' | 'retryBaseMs'
  >>,
  sender: (payload: MissionControlPushPayload) => Promise<PushSendResult>,
): Promise<void> {
  const globalSuppression = resolveCurrentGlobalPushSuppression(now, claim.channel);
  if (globalSuppression) {
    finalizeDelivery(claim, {
      status: 'suppressed',
      suppressionReason: globalSuppression,
    });
    return;
  }

  const connectorSuppression = getConnectorSuppression(claim, now);
  if (connectorSuppression) {
    finalizeDelivery(claim, {
      status: 'suppressed',
      suppressionReason: connectorSuppression,
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
      scheduleRetry(claim, now, null, options.retryBaseMs);
    } else {
      finalizeDelivery(claim, {
        status: 'failed',
        lastError: 'retry_limit_exhausted',
      });
    }

    return;
  }

  if (result.classification === 'no_subscription') {
    finalizeDelivery(claim, {
      status: 'suppressed',
      suppressionReason: 'no_subscription',
      result,
    });
    return;
  }
  if (result.classification === 'channel_unconfigured') {
    finalizeDelivery(claim, {
      status: 'suppressed',
      suppressionReason: 'channel_unconfigured',
      result,
    });
    return;
  }

  if (result.sent > 0 && result.failed === 0) {
    finalizeDelivery(claim, {
      status: 'sent',
      result,
      sentAt: now.toISOString(),
    });
    return;
  }
  if (result.sent > 0) {
    finalizeDelivery(claim, {
      status: 'partial',
      result,
      sentAt: now.toISOString(),
      lastError: 'partial_delivery_failure',
    });
    return;
  }
  if (result.transientFailures > 0 && claim.attemptCount < options.maxAttempts) {
    scheduleRetry(claim, now, result, options.retryBaseMs);
    return;
  }

  finalizeDelivery(claim, {
    status: 'failed',
    result,
    lastError: result.transientFailures > 0
      ? 'retry_limit_exhausted'
      : 'permanent_delivery_failure',
  });
}

let dispatcherWakeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNextDispatcherWake(): void {
  const row = sqlite.prepare(`
    SELECT MIN(
      CASE
        WHEN status = 'pending' THEN COALESCE(next_attempt_at, created_at)
        WHEN status = 'sending' THEN lease_expires_at
      END
    ) AS due_at
    FROM notification_delivery_events
    WHERE channel IN ('web_push', 'apns') AND status IN ('pending', 'sending')
  `).get() as { due_at: string | null };
  if (!row.due_at) return;

  const delay = Math.max(0, new Date(row.due_at).getTime() - Date.now());
  dispatcherWakeTimer = setTimeout(() => {
    dispatcherWakeTimer = null;
    void dispatchNotificationDeliveries().catch(error => {
      logger.error({ err: error }, 'Scheduled push delivery dispatch failed');
    });
  }, Math.min(delay, 2_147_483_647));
  dispatcherWakeTimer.unref?.();
}

export async function dispatchNotificationDeliveries(
  options: DispatchNotificationDeliveriesOptions = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DEFAULT_PUSH_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_PUSH_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_PUSH_RETRY_BASE_MS;
  const batchSize = options.batchSize ?? DEFAULT_DISPATCH_BATCH_SIZE;
  const sender = options.sender ?? sendWebPushPayload;
  const apnsSender = options.apnsSender ?? sendApnsPayload;
  const scheduleWakeups = options.scheduleWakeups
    ?? (
      options.now === undefined
      && options.sender === undefined
      && options.apnsSender === undefined
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
      claim = claimNotificationDelivery(claimedAt, leaseMs, maxAttempts);
    } catch (error) {
      logger.error({ err: error }, 'Failed to claim push delivery event');
      break;
    }
    if (!claim) break;
    await dispatchClaim(
      claim,
      claimedAt,
      { maxAttempts, retryBaseMs },
      claim.channel === 'apns' ? apnsSender : sender,
    );
    processed += 1;
  }

  if (scheduleWakeups) scheduleNextDispatcherWake();
  return processed;
}
