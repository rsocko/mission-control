import 'server-only';

import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import db, { runTransaction } from '@/db';
import * as schema from '@/db/schema';
import {
  appSettings,
  apnsRegistrations,
  notificationDeliveryEvents,
  notifications,
  pushPreferences,
  pushSubscriptions,
} from '@/db/schema';
import type {
  NotificationDisposition,
  NotificationLevel,
  NotificationReadState,
  NotificationReopenPolicy,
  NotificationSourceState,
  NotificationState,
  NotificationSyncState,
} from '@/types';
import { getTimezone } from '@/lib/mode';
import logger from '@/lib/logger';
import { wakeNotificationDeliveryDispatcher } from './dispatcher-wake';
import { getNotificationLevelRank, normalizeNotificationLevel } from './levels';
import { isQuietHour } from './quiet-hours';
import { getApnsConfiguration, isApnsConfigured } from '@/lib/push/apns-config';
import {
  type ResolvedNotificationPushPolicy,
} from './push-policy';
import { createStoredNotificationPushPolicyResolver } from './push-policy/resolver';
import {
  legacyStateFromLifecycle,
  legacyStatePatch,
  needsAttention,
  shouldReopenForSourceActivity,
} from './lifecycle';

export { wakeNotificationDeliveryDispatcher } from './dispatcher-wake';

export const PUSH_DELIVERY_SETTING_KEY = 'push_delivery_enabled';
export const DEFAULT_GLOBAL_PUSHES_PER_HOUR = 100;

const ACTIVE_RATE_LIMIT_STATUSES = ['pending', 'sending', 'sent', 'partial'] as const;
const INTERNAL_ORIGIN = 'https://mission-control.invalid';

type NotificationDatabase = BetterSQLite3Database<typeof schema>;
type NotificationRow = typeof notifications.$inferSelect;
type DeliveryEventRow = typeof notificationDeliveryEvents.$inferSelect;
type DeliveryEventInsert = typeof notificationDeliveryEvents.$inferInsert;

export type NotificationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'suppressed';

export type NotificationDeliveryChannel = 'web_push' | 'apns';

export type NotificationSuppressionReason =
  | 'channel_disabled'
  | 'channel_unconfigured'
  | 'no_subscription'
  | 'dnd'
  | 'quiet_hours'
  | 'rule_disabled'
  | 'below_minimum_level'
  | 'rate_limited'
  | 'connector_deleted'
  | 'connector_disabled'
  | 'not_attention_eligible';

export interface MissionControlPushPayload {
  notificationId: string;
  title: string;
  body?: string;
  tag: string;
  url: string;
  kind?: 'task_reminder';
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
  notification: NotificationRow;
  created: boolean;
  deliveryEvent: DeliveryEventRow | null;
  deliveryEvents: DeliveryEventRow[];
}

interface CreationContext {
  now: Date;
  timezone: string;
  channelEnabled: boolean | null;
  webChannelConfigured: boolean;
  apnsConfigured: boolean;
  apnsEnvironment: string | null;
  apnsTopic: string | null;
  globalMaxPerHour: number;
  policyResolver: ReturnType<typeof createStoredNotificationPushPolicyResolver>;
}

const DELIVERY_CHANNELS: readonly NotificationDeliveryChannel[] = ['web_push', 'apns'];

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

export function normalizeInternalNavigationTarget(target: string | null | undefined): string | null {
  if (target === null || target === undefined || !target.trim()) return null;
  const value = target.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new Error('navigationTarget must be an internal application path');
  }
  const url = new URL(value, INTERNAL_ORIGIN);
  if (url.origin !== INTERNAL_ORIGIN || !url.pathname.startsWith('/')) {
    throw new Error('navigationTarget must be an internal application path');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function redactPushText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi,
      'Authorization: [redacted]',
    )
    .replace(
      /["']?\b(access[_-]?token|api[_-]?key|password|secret|token|credential|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1=[redacted]',
    );
  return redacted.slice(0, maxLength);
}

function buildPayload(
  notification: NotificationRow,
  policy: ResolvedNotificationPushPolicy,
): MissionControlPushPayload {
  const fallbackUrl = `/notifications?id=${encodeURIComponent(notification.id)}`;
  let navigationTarget: string | null = null;
  try {
    navigationTarget = normalizeInternalNavigationTarget(notification.navigationTarget);
  } catch (error) {
    logger.warn(
      { err: error, notificationId: notification.id },
      'Ignored unsafe stored notification navigation target',
    );
  }
  const payload: MissionControlPushPayload = {
    notificationId: notification.id,
    title: redactPushText(notification.title, 160),
    tag: `mc:${notification.id}`,
    url: navigationTarget ?? fallbackUrl,
  };
  if (notification.templateKey === 'task_reminder') {
    payload.kind = 'task_reminder';
  }
  if (policy.preview === 'title_and_body' && notification.body) {
    payload.body = redactPushText(notification.body, 512);
  }
  return payload;
}

function parseBooleanSetting(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).enabled === true;
}

function getCurrentHour(now: Date, timezone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now);
  return Number.parseInt(formatted, 10);
}

function configuredGlobalLimit(override?: number): number {
  if (override !== undefined) return Math.max(1, Math.floor(override));
  const fromEnv = Number.parseInt(process.env.PUSH_GLOBAL_MAX_PER_HOUR ?? '', 10);
  return Number.isInteger(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_GLOBAL_PUSHES_PER_HOUR;
}

function isWebPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function resolveCurrentGlobalPushSuppression(
  now = new Date(),
  channel: NotificationDeliveryChannel = 'web_push',
): 'channel_disabled' | 'channel_unconfigured' | 'dnd' | 'quiet_hours' | null {
  if (!resolveChannelEnabled(db)) return 'channel_disabled';
  if (channel === 'web_push' ? !isWebPushConfigured() : !isApnsConfigured()) {
    return 'channel_unconfigured';
  }
  const preferences = db.select().from(pushPreferences).where(
    eq(pushPreferences.id, 'default'),
  ).get();
  if (preferences?.doNotDisturb) return 'dnd';
  if (
    preferences
    && isQuietHour(
      getCurrentHour(now, getTimezone()),
      preferences.quietStart,
      preferences.quietEnd,
    )
  ) {
    return 'quiet_hours';
  }
  return null;
}

function resolveChannelEnabled(database: NotificationDatabase): boolean {
  const row = database.select({ value: appSettings.value }).from(appSettings).where(
    eq(appSettings.key, PUSH_DELIVERY_SETTING_KEY),
  ).get();
  return row ? parseBooleanSetting(row.value) : true;
}

function resolveSuppression(
  database: NotificationDatabase,
  notification: NotificationRow,
  policy: ResolvedNotificationPushPolicy,
  context: CreationContext,
  channel: NotificationDeliveryChannel,
): {
  reason: NotificationSuppressionReason | null;
  gates: Record<string, boolean>;
} {
  const channelEnabled = context.channelEnabled ?? resolveChannelEnabled(database);
  const preferences = database.select().from(pushPreferences).where(
    eq(pushPreferences.id, 'default'),
  ).get();
  const dnd = preferences?.doNotDisturb ?? false;
  const quietHours = preferences
    ? isQuietHour(
        getCurrentHour(context.now, context.timezone),
        preferences.quietStart,
        preferences.quietEnd,
      )
    : false;
  const channelConfigured = channel === 'web_push'
    ? context.webChannelConfigured
    : context.apnsConfigured;
  const hasSubscriptions = channel === 'web_push'
    ? Boolean(database.select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.platform, 'web'))
        .limit(1)
        .get())
    : Boolean(database.select({ id: apnsRegistrations.id })
        .from(apnsRegistrations)
        .where(and(
          isNull(apnsRegistrations.invalidatedAt),
          eq(apnsRegistrations.environment, context.apnsEnvironment ?? ''),
          eq(apnsRegistrations.topic, context.apnsTopic ?? ''),
        ))
        .limit(1)
        .get());
  const gates = {
    channelEnabled,
    channelConfigured,
    dnd,
    quietHours,
    hasSubscriptions,
  };

  if (!needsAttention(notification, context.now)) {
    return { reason: 'not_attention_eligible', gates };
  }
  if (!channelEnabled) return { reason: 'channel_disabled', gates };
  if (!channelConfigured) return { reason: 'channel_unconfigured', gates };
  if (dnd) return { reason: 'dnd', gates };
  if (quietHours) return { reason: 'quiet_hours', gates };
  if (!policy.enabled) return { reason: 'rule_disabled', gates };
  if (!policy.shouldPush) return { reason: 'below_minimum_level', gates };
  if (!hasSubscriptions) return { reason: 'no_subscription', gates };

  const since = new Date(context.now.getTime() - 60 * 60 * 1_000).toISOString();
  const globalCount = database.select({
    count: sql<number>`count(distinct ${notificationDeliveryEvents.notificationId})`,
  })
    .from(notificationDeliveryEvents)
    .where(and(
      gte(notificationDeliveryEvents.createdAt, since),
      inArray(notificationDeliveryEvents.status, ACTIVE_RATE_LIMIT_STATUSES),
    ))
    .get()?.count ?? 0;
  if (Number(globalCount) >= context.globalMaxPerHour) {
    return { reason: 'rate_limited', gates };
  }

  if (policy.maxPerHour !== null) {
    const ruleConditions = [
      gte(notificationDeliveryEvents.createdAt, since),
      inArray(notificationDeliveryEvents.status, ACTIVE_RATE_LIMIT_STATUSES),
      eq(notifications.connectorInstanceId, notification.connectorInstanceId),
    ];
    if (policy.sourceDetail !== 'wildcard') {
      ruleConditions.push(eq(notifications.templateKey, notification.templateKey ?? ''));
    }
    const ruleCount = database.select({
      count: sql<number>`count(distinct ${notificationDeliveryEvents.notificationId})`,
    })
      .from(notificationDeliveryEvents)
      .innerJoin(
        notifications,
        eq(notificationDeliveryEvents.notificationId, notifications.id),
      )
      .where(and(...ruleConditions))
      .get()?.count ?? 0;
    if (Number(ruleCount) >= policy.maxPerHour) {
      return { reason: 'rate_limited', gates };
    }
  }

  return { reason: null, gates };
}

function createContext(
  database: NotificationDatabase,
  options: CreateNotificationOptions,
): CreationContext {
  const now = options.now ?? new Date();
  let apnsEnvironment: string | null = null;
  let apnsTopic: string | null = null;
  let detectedApnsConfiguration = false;
  try {
    const configuration = getApnsConfiguration();
    apnsEnvironment = configuration.environment;
    apnsTopic = configuration.topic;
    detectedApnsConfiguration = true;
  } catch {
    // The channel-specific suppression records missing configuration durably.
  }
  return {
    now,
    timezone: options.timezone ?? getTimezone(),
    channelEnabled: options.channelEnabled ?? null,
    webChannelConfigured: options.channelConfigured ?? isWebPushConfigured(),
    apnsConfigured: options.apnsConfigured ?? detectedApnsConfiguration,
    apnsEnvironment,
    apnsTopic,
    globalMaxPerHour: configuredGlobalLimit(options.globalMaxPerHour),
    policyResolver: createStoredNotificationPushPolicyResolver(database),
  };
}

function insertDeliveryEvent(
  database: NotificationDatabase,
  values: DeliveryEventInsert,
): DeliveryEventRow {
  const inserted = database.insert(notificationDeliveryEvents)
    .values(values)
    .onConflictDoNothing({ target: notificationDeliveryEvents.dedupeKey })
    .returning()
    .get();
  if (inserted) return inserted;

  const existing = database.select().from(notificationDeliveryEvents).where(
    eq(notificationDeliveryEvents.dedupeKey, values.dedupeKey),
  ).get();
  if (!existing) {
    throw new Error(`Delivery event "${values.dedupeKey}" was not persisted`);
  }
  return existing;
}

function createOneInTransaction(
  database: NotificationDatabase,
  input: CreateNotificationInput,
  context: CreationContext,
): CreateNotificationResult {
  const sourceId = requireText(input.sourceId, 'sourceId');
  const connectorType = requireText(input.connectorType, 'connectorType');
  const connectorInstanceId = requireText(input.connectorInstanceId, 'connectorInstanceId');
  const title = requireText(input.title, 'title');
  const templateKey = input.templateKey?.trim() || null;
  let navigationTarget: string | null = null;
  try {
    navigationTarget = normalizeInternalNavigationTarget(input.navigationTarget);
  } catch (error) {
    logger.warn(
      { err: error, sourceId },
      'Ignored unsafe notification navigation target',
    );
  }
  const normalizedLevel = normalizeNotificationLevel(input.level);
  const nowIso = context.now.toISOString();
  const id = input.id ?? crypto.randomUUID();
  const legacyPatch = input.state
    ? legacyStatePatch(input.state as NotificationState, nowIso)
    : null;
  const readState = input.readState ?? legacyPatch?.readState ?? 'unread';
  const disposition = input.disposition ?? legacyPatch?.disposition ?? 'inbox';
  const sourceState = input.sourceState ?? legacyPatch?.sourceState ?? 'active';
  const syncState = input.syncState ?? 'synced';
  const incomingSourceActivityAt = input.sourceActivityAt ?? null;
  const sourceActivityAt = incomingSourceActivityAt ?? input.sortAt ?? input.receivedAt ?? nowIso;
  const sourceActivityKey = input.sourceActivityKey ?? null;
  const state = legacyStateFromLifecycle({ readState, disposition, sourceState });

  const insertedNotification = database.insert(notifications).values({
      id,
      sourceId,
      connectorType,
      connectorInstanceId,
      title,
      body: input.body ?? null,
      level: normalizedLevel.level,
      levelRank: getNotificationLevelRank(normalizedLevel.level),
      category: input.category?.trim() || 'system',
      templateKey,
      state,
      readState,
      disposition,
      sourceState,
      syncState,
      readAt: readState === 'read' ? (legacyPatch?.readAt ?? nowIso) : null,
      handledAt: disposition === 'handled' ? (legacyPatch?.handledAt ?? nowIso) : null,
      dismissedAt: disposition === 'dismissed' ? (legacyPatch?.dismissedAt ?? nowIso) : null,
      sourceResolvedAt: sourceState === 'resolved' || sourceState === 'deleted'
        ? (legacyPatch?.sourceResolvedAt ?? nowIso)
        : null,
      lastSourceActivityAt: sourceActivityAt,
      lastSourceActivityKey: sourceActivityKey,
      handledSourceActivityAt: disposition === 'handled' ? sourceActivityAt : null,
      handledSourceActivityKey: disposition === 'handled' ? sourceActivityKey : null,
      lastSourceSyncedAt: nowIso,
      receivedAt: input.receivedAt ?? nowIso,
      sortAt: input.sortAt ?? input.receivedAt ?? nowIso,
      expiresAt: input.expiresAt ?? null,
      groupKey: input.groupKey ?? null,
      dedupeKey: input.dedupeKey ?? null,
      relatedTaskId: input.relatedTaskId ?? null,
      relatedProjectId: input.relatedProjectId ?? null,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      navigationTarget,
      metadata: input.metadata ?? {},
      presentation: input.presentation ?? {},
      isActionable: input.isActionable ?? false,
      primaryActionId: input.primaryActionId ?? null,
      aiSuggestedActionId: input.aiSuggestedActionId ?? null,
    })
    .onConflictDoNothing({ target: notifications.sourceId })
    .returning()
    .get();
  const created = Boolean(insertedNotification);
  let notification = insertedNotification ?? database.select().from(notifications).where(
    eq(notifications.sourceId, sourceId),
  ).get();
  if (!notification) {
    throw new Error(`Notification "${sourceId}" was not persisted`);
  }
  if (
    notification.connectorInstanceId !== connectorInstanceId
    || notification.connectorType !== connectorType
  ) {
    throw new Error(
      `Notification source identity "${sourceId}" belongs to a different connector instance`,
    );
  }
  if (!insertedNotification) {
    const reopen = shouldReopenForSourceActivity(
      notification,
      {
        sourceState,
        sourceActivityAt: incomingSourceActivityAt,
        sourceActivityKey,
      },
      input.reopenPolicy,
    );
    const nextDisposition = reopen ? 'inbox' : notification.disposition;
    const nextReadState = reopen ? readState : notification.readState;
    const nextState = legacyStateFromLifecycle({
      disposition: nextDisposition as NotificationDisposition,
      readState: nextReadState as NotificationReadState,
      sourceState,
    });
    database.update(notifications).set({
      title,
      body: input.body ?? null,
      level: normalizedLevel.level,
      levelRank: getNotificationLevelRank(normalizedLevel.level),
      category: input.category?.trim() || 'system',
      templateKey,
      state: nextState,
      readState: nextReadState,
      disposition: nextDisposition,
      sourceState,
      syncState: input.syncState ?? notification.syncState,
      readAt: reopen && nextReadState === 'unread' ? null : notification.readAt,
      sourceResolvedAt: sourceState === 'resolved' || sourceState === 'deleted'
        ? (notification.sourceResolvedAt ?? nowIso)
        : null,
      lastSourceActivityAt: incomingSourceActivityAt ?? notification.lastSourceActivityAt,
      lastSourceActivityKey: input.sourceActivityKey === undefined
        ? notification.lastSourceActivityKey
        : sourceActivityKey,
      lastSourceSyncedAt: nowIso,
      sortAt: reopen ? (incomingSourceActivityAt ?? nowIso) : notification.sortAt,
      expiresAt: input.expiresAt ?? null,
      groupKey: input.groupKey ?? null,
      dedupeKey: input.dedupeKey ?? null,
      relatedTaskId: input.relatedTaskId ?? null,
      relatedProjectId: input.relatedProjectId ?? null,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      navigationTarget,
      metadata: input.metadata ?? {},
      presentation: input.presentation ?? {},
      isActionable: input.isActionable ?? false,
      primaryActionId: input.primaryActionId ?? null,
      aiSuggestedActionId: input.aiSuggestedActionId ?? null,
    }).where(eq(notifications.id, notification.id)).run();
    const refreshedNotification = database.select().from(notifications).where(
      eq(notifications.id, notification.id),
    ).get();
    if (!refreshedNotification) {
      throw new Error(`Notification "${sourceId}" disappeared during update`);
    }
    notification = refreshedNotification;
  }

  const level = normalizeNotificationLevel(notification.level).level;
  const occurrenceKey = input.occurrenceKey?.trim() || 'initial';
  const priorDeliveries = DELIVERY_CHANNELS.flatMap(channel => {
    const prior = database.select().from(notificationDeliveryEvents).where(
      eq(notificationDeliveryEvents.dedupeKey, `${channel}:${notification.id}:${occurrenceKey}`),
    ).get();
    return prior ? [prior] : [];
  });
  if (priorDeliveries.length === DELIVERY_CHANNELS.length) {
    return {
      notification,
      created,
      deliveryEvent: priorDeliveries.find(event => event.channel === 'web_push') ?? null,
      deliveryEvents: priorDeliveries,
    };
  }

  let policy: ResolvedNotificationPushPolicy;
  try {
    policy = context.policyResolver.resolve({
      connectorInstanceId: notification.connectorInstanceId,
      connectorType: notification.connectorType,
      templateKey: notification.templateKey,
      level,
    });
  } catch (error) {
    logger.error(
      { err: error, notificationId: notification.id },
      'Notification push policy resolution failed',
    );
    const fallbackPolicy: ResolvedNotificationPushPolicy = {
      eligible: true,
      enabled: false,
      shouldPush: false,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerHour: null,
      source: 'system',
      sourceDetail: 'system_off',
      ineligibilityReason: null,
      definition: null,
    };
    const failedEvents = [...priorDeliveries];
    for (const channel of DELIVERY_CHANNELS) {
      if (failedEvents.some(event => event.channel === channel)) continue;
      failedEvents.push(insertDeliveryEvent(database, {
        id: crypto.randomUUID(),
        notificationId: notification.id,
        channel,
        dedupeKey: `${channel}:${notification.id}:${occurrenceKey}`,
        status: 'failed',
        suppressionReason: null,
        policySnapshot: {
          version: 1,
          channel,
          connectorType: notification.connectorType,
          connectorInstanceId: notification.connectorInstanceId,
          templateKey: notification.templateKey,
          decision: 'failed',
          error: 'policy_resolution_failed',
        },
        payloadSnapshot: buildPayload(notification, fallbackPolicy),
        attemptCount: 0,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        subscriptionsAttempted: 0,
        subscriptionsSent: 0,
        subscriptionsFailed: 0,
        createdAt: nowIso,
        sentAt: null,
        lastError: 'policy_resolution_failed',
      }));
    }
    return {
      notification,
      created,
      deliveryEvent: failedEvents.find(event => event.channel === 'web_push') ?? null,
      deliveryEvents: failedEvents,
    };
  }
  if (!policy.eligible) {
    return { notification, created, deliveryEvent: null, deliveryEvents: [] };
  }

  const payload = buildPayload(notification, policy);
  const suppressions = new Map(DELIVERY_CHANNELS.map(channel => [
    channel,
    resolveSuppression(database, notification, policy, context, channel),
  ]));
  const deliveryEvents = [...priorDeliveries];
  for (const channel of DELIVERY_CHANNELS) {
    if (deliveryEvents.some(event => event.channel === channel)) continue;
    const suppression = suppressions.get(channel)!;
    const status: NotificationDeliveryStatus = suppression.reason ? 'suppressed' : 'pending';
    deliveryEvents.push(insertDeliveryEvent(database, {
      id: crypto.randomUUID(),
      notificationId: notification.id,
      channel,
      dedupeKey: `${channel}:${notification.id}:${occurrenceKey}`,
      status,
      suppressionReason: suppression.reason,
      policySnapshot: {
        version: 1,
        channel,
        connectorType: notification.connectorType,
        connectorInstanceId: notification.connectorInstanceId,
        templateKey: notification.templateKey,
        source: policy.source,
        sourceDetail: policy.sourceDetail,
        minLevel: policy.minLevel,
        preview: policy.preview,
        maxPerHour: policy.maxPerHour,
        gates: suppression.gates,
        decision: status,
        suppressionReason: suppression.reason,
      },
      payloadSnapshot: payload,
      attemptCount: 0,
      nextAttemptAt: status === 'pending' ? nowIso : null,
      leaseExpiresAt: null,
      subscriptionsAttempted: 0,
      subscriptionsSent: 0,
      subscriptionsFailed: 0,
      createdAt: nowIso,
      sentAt: null,
      lastError: null,
    }));
  }

  return {
    notification,
    created,
    deliveryEvent: deliveryEvents.find(event => event.channel === 'web_push') ?? null,
    deliveryEvents,
  };
}

export function createNotificationsInTransaction(
  transaction: NotificationDatabase,
  inputs: readonly CreateNotificationInput[],
  options: CreateNotificationOptions = {},
): CreateNotificationResult[] {
  const context = createContext(transaction, options);
  return inputs.map(input => createOneInTransaction(transaction, input, context));
}

export async function createNotifications(
  inputs: readonly CreateNotificationInput[],
  options: CreateNotificationOptions = {},
): Promise<CreateNotificationResult[]> {
  if (inputs.length === 0) return [];
  const results = runTransaction(transaction => (
    createNotificationsInTransaction(transaction, inputs, options)
  ));
  if (
    options.wakeDispatcher !== false
    && results.some(result => result.deliveryEvents.some(event => event.status === 'pending'))
  ) {
    wakeNotificationDeliveryDispatcher();
  }
  return results;
}

export async function createNotification(
  input: CreateNotificationInput,
  options: CreateNotificationOptions = {},
): Promise<CreateNotificationResult> {
  const [result] = await createNotifications([input], options);
  return result;
}

export function countPendingNotificationDeliveries(): number {
  return Number(db.select({ count: sql<number>`count(*)` })
    .from(notificationDeliveryEvents)
    .where(eq(notificationDeliveryEvents.status, 'pending'))
    .get()?.count ?? 0);
}
