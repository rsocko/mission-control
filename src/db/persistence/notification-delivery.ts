import {
  normalizeInternalNavigationTarget,
  type MissionControlPushPayload,
  type NotificationDeliveryChannel,
} from '@/lib/notifications/push-payload';
import { decodeStrictJsonObject } from './value-codecs';
import type { NotificationWebPersistence } from './notification-web';

export type NotificationDeliverySuppressionReason =
  | 'channel_disabled'
  | 'channel_unconfigured'
  | 'dnd'
  | 'quiet_hours'
  | 'connector_deleted'
  | 'connector_disabled'
  | 'not_attention_eligible';

export interface ClaimedNotificationDelivery {
  id: string;
  notificationId: string;
  channel: NotificationDeliveryChannel;
  dedupeKey: string;
  attemptCount: number;
  payloadSnapshot: MissionControlPushPayload;
  leaseExpiresAt: string;
  claimToken: string;
}

export interface NotificationDeliveryCounters {
  attempted: number;
  sent: number;
  failed: number;
}

export interface NotificationDeliveryFinalization {
  status: 'sent' | 'partial' | 'failed' | 'suppressed';
  suppressionReason?: NotificationDeliverySuppressionReason | 'no_subscription' | null;
  counters?: NotificationDeliveryCounters;
  sentAt?: string | null;
  lastError?: string | null;
}

export interface NotificationDeliveryEligibilityInput {
  now: Date;
  currentHour: number;
  channelConfigured: boolean;
}

export interface WebPushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}
export interface ApnsRegistrationRecord {
  id: string;
  tokenCiphertext: string;
  environment: string;
  topic: string;
}

export interface NotificationDeliveryRepository {
  claimNext(input: {
    now: Date;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedNotificationDelivery | null>;
  resolveSuppression(
    claim: ClaimedNotificationDelivery,
    input: NotificationDeliveryEligibilityInput,
  ): Promise<NotificationDeliverySuppressionReason | null>;
  finalize(
    claim: ClaimedNotificationDelivery,
    values: NotificationDeliveryFinalization,
  ): Promise<boolean>;
  scheduleRetry(
    claim: ClaimedNotificationDelivery,
    input: {
      nextAttemptAt: string;
      counters?: NotificationDeliveryCounters;
      lastError: string;
    },
  ): Promise<boolean>;
  getNextWakeAt(): Promise<string | null>;
  listWebPushSubscriptions(): Promise<WebPushSubscriptionRecord[]>;
  retireWebPushSubscription(id: string): Promise<boolean>;
  listApnsRegistrations(input: {
    environment: string;
    topic: string;
  }): Promise<ApnsRegistrationRecord[]>;
  invalidateApnsRegistration(input: {
    id: string;
    invalidatedAt: string;
    reason: string;
  }): Promise<boolean>;
  web: NotificationWebPersistence;
}

export function parseNotificationDeliveryPayload(value: unknown): MissionControlPushPayload {
  const payload = decodeStrictJsonObject(value, {
    invalidJson: 'Stored push payload is not valid JSON',
    notAnObject: 'Stored push payload must be an object',
  });
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
    || (payload.kind !== undefined && payload.kind !== 'task_reminder')
  ) {
    throw new Error('Stored push payload is invalid');
  }
  return {
    notificationId: payload.notificationId,
    title: payload.title,
    ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
    tag: payload.tag,
    url: payload.url,
    ...(payload.kind === 'task_reminder' ? { kind: payload.kind } : {}),
  };
}
