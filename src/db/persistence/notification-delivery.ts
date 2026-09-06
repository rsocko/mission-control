import {
  normalizeInternalNavigationTarget,
  type MissionControlPushPayload,
  type NotificationDeliveryChannel,
} from '@/lib/notifications/push-payload';
import type {
  NotificationDisposition,
  NotificationLevel,
  NotificationReadState,
  NotificationReopenPolicy,
  NotificationSourceState,
  NotificationSyncState,
} from '@/types';
import type {
  ConnectorNotificationTypeDefinition,
  PushPreview,
} from '@/lib/notifications/push-policy/catalog';
import type {
  ResolvedNotificationPushPolicy,
} from '@/lib/notifications/push-policy/policy';
import { decodeStrictJsonObject } from './value-codecs';
import type { NotificationWebPersistence } from './notification-web';
import type { NotificationPushPersistence } from './notification-push';

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

export interface NotificationRecord {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  levelRank: number;
  category: string;
  templateKey: string | null;
  state: string;
  readState: string;
  disposition: string;
  sourceState: string;
  syncState: string;
  readAt: string | null;
  handledAt: string | null;
  dismissedAt: string | null;
  resolvedAt: string | null;
  archivedAt: string | null;
  mutedAt: string | null;
  snoozedUntil: string | null;
  sourceResolvedAt: string | null;
  lastSourceActivityAt: string | null;
  lastSourceActivityKey: string | null;
  handledSourceActivityAt: string | null;
  handledSourceActivityKey: string | null;
  lastSourceSyncedAt: string | null;
  isActionable: boolean;
  primaryActionId: string | null;
  aiSuggestedActionId: string | null;
  receivedAt: string;
  sortAt: string;
  expiresAt: string | null;
  groupKey: string | null;
  dedupeKey: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  navigationTarget: string | null;
  reconcileAttempts: number;
  lastReconciledAt: string | null;
  staleSince: string | null;
  autoResolveReason: string | null;
  metadata: unknown;
  presentation: unknown;
  enrichmentRevision: string | null;
  enrichmentGeneration: number;
}

export type NotificationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'suppressed';

export type NotificationSuppressionReason =
  | NotificationDeliverySuppressionReason
  | 'no_subscription'
  | 'rule_disabled'
  | 'below_minimum_level'
  | 'rate_limited';

export interface NotificationDeliveryEventRecord {
  id: string;
  notificationId: string;
  channel: string;
  dedupeKey: string;
  status: string;
  suppressionReason: string | null;
  policySnapshot: unknown;
  payloadSnapshot: unknown;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  claimToken: string | null;
  subscriptionsAttempted: number;
  subscriptionsSent: number;
  subscriptionsFailed: number;
  createdAt: string;
  sentAt: string | null;
  lastError: string | null;
}

export interface CreateNotificationInput {
  id?: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body?: string | null;
  level?: NotificationLevel | string;
  category?: string;
  templateKey?: string | null;
  state?: string;
  readState?: NotificationReadState;
  disposition?: NotificationDisposition;
  sourceState?: NotificationSourceState;
  syncState?: NotificationSyncState;
  sourceActivityAt?: string | null;
  sourceActivityKey?: string | null;
  reopenPolicy?: NotificationReopenPolicy;
  receivedAt?: string;
  sortAt?: string;
  expiresAt?: string | null;
  groupKey?: string | null;
  dedupeKey?: string | null;
  relatedTaskId?: string | null;
  relatedProjectId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  navigationTarget?: string | null;
  metadata?: Record<string, unknown>;
  presentation?: Record<string, unknown>;
  enrichmentRevision?: string | null;
  isActionable?: boolean;
  primaryActionId?: string | null;
  aiSuggestedActionId?: string | null;
  occurrenceKey?: string;
}

export interface CreateNotificationOptions {
  now?: Date;
  timezone?: string;
  channelEnabled?: boolean;
  channelConfigured?: boolean;
  apnsConfigured?: boolean;
  globalMaxPerHour?: number;
  wakeDispatcher?: boolean;
}

export interface CreateNotificationResult {
  notification: NotificationRecord;
  created: boolean;
  deliveryEvent: NotificationDeliveryEventRecord | null;
  deliveryEvents: NotificationDeliveryEventRecord[];
}

export interface NotificationCreationPersistence {
  createNotifications(
    inputs: readonly CreateNotificationInput[],
    options?: CreateNotificationOptions,
  ): Promise<CreateNotificationResult[]>;
  resolveCurrentGlobalPushSuppression(
    now: Date,
    channel: NotificationDeliveryChannel,
  ): Promise<'channel_disabled' | 'channel_unconfigured' | 'dnd' | 'quiet_hours' | null>;
  countPendingDeliveries(): Promise<number>;
}

export const NOTIFICATION_CREATION_TRANSACTION = Symbol.for(
  'mission-control.notification-creation-transaction.v1',
);

export type NotificationCreationTransactionCapability = (
  inputs: readonly CreateNotificationInput[],
  options?: CreateNotificationOptions,
) => CreateNotificationResult[];

export interface NotificationPushRule {
  id: string;
  connectorInstanceId: string;
  templateKey: string;
  enabled: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveNotificationPushRuleInput {
  id?: string;
  connectorInstanceId: string;
  templateKey: string;
  enabled: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour?: number | null;
}

export interface NotificationPushRulePersistence {
  save(
    input: SaveNotificationPushRuleInput,
    definition?: ConnectorNotificationTypeDefinition,
  ): Promise<NotificationPushRule>;
  listOverrides(
    connectorInstanceId: string,
    templateKey?: string,
  ): Promise<NotificationPushRule[]>;
  reset(connectorInstanceId: string, templateKey: string): Promise<void>;
}

export interface ResolveStoredNotificationPushPolicyInput {
  connectorInstanceId: string;
  connectorType: string;
  templateKey?: string | null;
  level: NotificationLevel;
}

export interface NotificationPushPolicyPersistence {
  resolve(
    input: ResolveStoredNotificationPushPolicyInput,
  ): Promise<ResolvedNotificationPushPolicy>;
}

export interface MorningTriggerSnapshot {
  plannedCount: number;
  overdueCount: number;
}

export interface TriageTriggerSnapshot {
  pendingCount: number;
  highWater: number | null;
}

export interface CarryForwardTriggerSnapshot {
  incompleteTaskTitles: string[];
}

export interface ScheduledNotificationTriggerPersistence {
  getMorningSnapshot(localDate: string): Promise<MorningTriggerSnapshot>;
  getTriageSnapshot(localDate: string): Promise<TriageTriggerSnapshot>;
  getCarryForwardSnapshot(localDate: string): Promise<CarryForwardTriggerSnapshot>;
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
  push: NotificationPushPersistence;
  web: NotificationWebPersistence;
  creation: NotificationCreationPersistence;
  pushRules: NotificationPushRulePersistence;
  policy: NotificationPushPolicyPersistence;
  scheduledTriggers: ScheduledNotificationTriggerPersistence;
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
