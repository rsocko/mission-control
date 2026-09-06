import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  parseNotificationDeliveryPayload,
  type ApnsRegistrationRecord,
  type CreateNotificationInput,
  type CreateNotificationOptions,
  type CreateNotificationResult,
  type NotificationDeliveryEventRecord,
  type NotificationDeliveryRepository,
  type NotificationPushRule,
  type NotificationRecord,
  type NotificationSuppressionReason,
  type ResolveStoredNotificationPushPolicyInput,
  type WebPushSubscriptionRecord,
} from '@/db/persistence/notification-delivery';
import type { NotificationState, ConnectorConfig } from '@/types';
import {
  legacyStateFromLifecycle,
  legacyStatePatch,
  needsAttention,
  shouldReopenForSourceActivity,
} from '@/lib/notifications/lifecycle';
import { isQuietHour } from '@/lib/notifications/quiet-hours-window';
import { createPostgresNotificationWebRepository } from './notification-web-repository';
import { createPostgresNotificationPushRepository } from './notification-push-repository';
import {
  getNotificationLevelRank,
  isNotificationLevel,
  normalizeNotificationLevel,
} from '@/lib/notifications/levels';
import {
  normalizeInternalNavigationTarget,
  type MissionControlPushPayload,
  type NotificationDeliveryChannel,
} from '@/lib/notifications/push-payload';
import { getTimezone } from '@/lib/mode';
import { getApnsConfiguration, isApnsConfigured } from '@/lib/push/apns-config';
import {
  resolveNotificationPushPolicy,
  type NotificationPushRuleValues,
  type ResolvedNotificationPushPolicy,
} from '@/lib/notifications/push-policy/policy';
import {
  isPushPreview,
  NotificationCatalogValidationError,
  parseLocalNotificationTypeCatalog,
  type ConnectorNotificationTypeDefinition,
} from '@/lib/notifications/push-policy/catalog';
import {
  financeNotificationCatalogKey,
  HOMELAB_NOTIFICATION_TYPES,
  SYSTEM_NOTIFICATION_TYPES,
} from '@/lib/notifications/push-policy/catalogs';
import { MAX_NOTIFICATION_PUSHES_PER_HOUR } from '@/lib/notifications/push-policy/constants';
import { connectorRegistry } from '@/lib/connectors';
import logger, { connectorLogger } from '@/lib/logger';
import { reconcileNotificationEnrichmentMetadata } from '@/db/persistence/notification-enrichment';

interface RawClaim {
  id: string;
  notification_id: string;
  channel: string;
  dedupe_key: string;
  attempt_count: number;
  payload_snapshot: unknown;
  lease_expires_at: string;
  claim_token: string;
}

interface EligibilityRow {
  source_id: string;
  connector_type: string;
  connector_instance_id: string;
  disposition: string;
  source_state: string;
  read_state: string;
  snoozed_until: string | null;
  level: string;
  connector_enabled: boolean | null;
  connector_deleted_at: string | null;
  webhook_enabled: boolean | null;
  finance_delivery_enabled: boolean | null;
}

function parseBooleanSetting(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).enabled === true
  );
}

function parseKeys(value: unknown): WebPushSubscriptionRecord['keys'] {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>).p256dh !== 'string'
    || typeof (value as Record<string, unknown>).auth !== 'string'
  ) {
    throw new Error('Stored Web Push subscription keys are invalid');
  }
  return {
    p256dh: (value as Record<string, string>).p256dh,
    auth: (value as Record<string, string>).auth,
  };
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

const ACTIVE_RATE_LIMIT_STATUSES = ['pending', 'sending', 'sent', 'partial'] as const;
const DELIVERY_CHANNELS: readonly NotificationDeliveryChannel[] = ['web_push', 'apns'];
const DEFAULT_GLOBAL_PUSHES_PER_HOUR = 100;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapNotification(value: unknown): NotificationRecord {
  const row = asObject(value);
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    connectorType: String(row.connector_type),
    connectorInstanceId: String(row.connector_instance_id),
    title: String(row.title),
    body: row.body === null ? null : String(row.body),
    level: String(row.level),
    levelRank: Number(row.level_rank),
    category: String(row.category),
    templateKey: row.template_key === null ? null : String(row.template_key),
    state: String(row.state),
    readState: String(row.read_state),
    disposition: String(row.disposition),
    sourceState: String(row.source_state),
    syncState: String(row.sync_state),
    readAt: row.read_at === null ? null : String(row.read_at),
    handledAt: row.handled_at === null ? null : String(row.handled_at),
    dismissedAt: row.dismissed_at === null ? null : String(row.dismissed_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
    mutedAt: row.muted_at === null ? null : String(row.muted_at),
    snoozedUntil: row.snoozed_until === null ? null : String(row.snoozed_until),
    sourceResolvedAt: row.source_resolved_at === null ? null : String(row.source_resolved_at),
    lastSourceActivityAt: row.last_source_activity_at === null
      ? null
      : String(row.last_source_activity_at),
    lastSourceActivityKey: row.last_source_activity_key === null
      ? null
      : String(row.last_source_activity_key),
    handledSourceActivityAt: row.handled_source_activity_at === null
      ? null
      : String(row.handled_source_activity_at),
    handledSourceActivityKey: row.handled_source_activity_key === null
      ? null
      : String(row.handled_source_activity_key),
    lastSourceSyncedAt: row.last_source_synced_at === null
      ? null
      : String(row.last_source_synced_at),
    isActionable: Boolean(row.is_actionable),
    primaryActionId: row.primary_action_id === null ? null : String(row.primary_action_id),
    aiSuggestedActionId: row.ai_suggested_action_id === null
      ? null
      : String(row.ai_suggested_action_id),
    receivedAt: String(row.received_at),
    sortAt: String(row.sort_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    groupKey: row.group_key === null ? null : String(row.group_key),
    dedupeKey: row.dedupe_key === null ? null : String(row.dedupe_key),
    relatedTaskId: row.related_task_id === null ? null : String(row.related_task_id),
    relatedProjectId: row.related_project_id === null ? null : String(row.related_project_id),
    relatedEntityType: row.related_entity_type === null ? null : String(row.related_entity_type),
    relatedEntityId: row.related_entity_id === null ? null : String(row.related_entity_id),
    navigationTarget: row.navigation_target === null ? null : String(row.navigation_target),
    reconcileAttempts: Number(row.reconcile_attempts),
    lastReconciledAt: row.last_reconciled_at === null ? null : String(row.last_reconciled_at),
    staleSince: row.stale_since === null ? null : String(row.stale_since),
    autoResolveReason: row.auto_resolve_reason === null ? null : String(row.auto_resolve_reason),
    metadata: row.metadata,
    presentation: row.presentation,
    enrichmentRevision: row.enrichment_revision === null
      ? null
      : String(row.enrichment_revision),
    enrichmentGeneration: Number(row.enrichment_generation),
  };
}

function mapDeliveryEvent(value: unknown): NotificationDeliveryEventRecord {
  const row = asObject(value);
  return {
    id: String(row.id),
    notificationId: String(row.notification_id),
    channel: String(row.channel),
    dedupeKey: String(row.dedupe_key),
    status: String(row.status),
    suppressionReason: row.suppression_reason === null ? null : String(row.suppression_reason),
    policySnapshot: row.policy_snapshot,
    payloadSnapshot: row.payload_snapshot,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    claimToken: row.claim_token === null ? null : String(row.claim_token),
    subscriptionsAttempted: Number(row.subscriptions_attempted),
    subscriptionsSent: Number(row.subscriptions_sent),
    subscriptionsFailed: Number(row.subscriptions_failed),
    createdAt: String(row.created_at),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function redactNotificationPushText(value: string, maxLength: number): string {
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

function configuredGlobalLimit(override?: number): number {
  if (override !== undefined) return Math.max(1, Math.floor(override));
  const fromEnv = Number.parseInt(process.env.PUSH_GLOBAL_MAX_PER_HOUR ?? '', 10);
  return Number.isInteger(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_GLOBAL_PUSHES_PER_HOUR;
}

function getCurrentHour(now: Date, timezone: string): number {
  return Number.parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now), 10);
}

function isWebPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function toPolicyRule(rule: NotificationPushRule | undefined): NotificationPushRuleValues | null {
  if (!rule) return null;
  if (!isNotificationLevel(rule.minLevel) || !isPushPreview(rule.preview)) {
    throw new Error(`Stored notification push rule "${rule.id}" is invalid`);
  }
  if (
    rule.maxPerHour !== null
    && (
      !Number.isInteger(rule.maxPerHour)
      || rule.maxPerHour < 1
      || rule.maxPerHour > MAX_NOTIFICATION_PUSHES_PER_HOUR
    )
  ) {
    throw new Error(`Stored notification push rule "${rule.id}" has an invalid rate limit`);
  }
  return {
    templateKey: rule.templateKey,
    enabled: rule.enabled,
    minLevel: rule.minLevel,
    preview: rule.preview,
    maxPerHour: rule.maxPerHour,
  };
}

function safeCatalog(
  connectorInstanceId: string,
  load: () => readonly ConnectorNotificationTypeDefinition[],
): readonly ConnectorNotificationTypeDefinition[] {
  try {
    return load();
  } catch (error) {
    if (!(error instanceof NotificationCatalogValidationError)) throw error;
    connectorLogger.warn(
      { connectorInstanceId, err: error },
      'Ignoring invalid local notification catalog during push policy resolution',
    );
    return [];
  }
}

async function loadRules(
  database: Queryable,
  connectorInstanceId: string,
): Promise<NotificationPushRule[]> {
  const result = await database.query<NotificationPushRule>(`
    SELECT id, connector_instance_id AS "connectorInstanceId",
           template_key AS "templateKey", enabled, min_level AS "minLevel",
           preview, max_per_hour AS "maxPerHour",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM notification_push_rules
    WHERE connector_instance_id = $1
  `, [connectorInstanceId]);
  return result.rows;
}

async function resolvePostgresStoredNotificationPushPolicy(
  database: Queryable,
  input: ResolveStoredNotificationPushPolicyInput,
): Promise<ResolvedNotificationPushPolicy> {
  if (!input.templateKey?.trim()) {
    return resolveNotificationPushPolicy({ ...input, catalog: [] });
  }
  const rules = await loadRules(database, input.connectorInstanceId);
  const policyTemplateKey = financeNotificationCatalogKey(input.templateKey);
  const exactRule = toPolicyRule(rules.find(rule => (
    rule.templateKey === input.templateKey || rule.templateKey === policyTemplateKey
  )));
  const wildcardRule = toPolicyRule(rules.find(rule => rule.templateKey === '*'));

  if (input.connectorType === 'system' && input.connectorInstanceId === 'push-triggers') {
    const definition = SYSTEM_NOTIFICATION_TYPES.find(candidate => candidate.key === input.templateKey);
    const systemDefault = definition
      ? {
          templateKey: definition.key,
          enabled: true,
          minLevel: definition.defaultLevel,
          preview: definition.defaultPreview,
          maxPerHour: null,
        } satisfies NotificationPushRuleValues
      : null;
    const resolved = resolveNotificationPushPolicy({
      ...input,
      catalog: SYSTEM_NOTIFICATION_TYPES,
      exactRule: exactRule ?? (wildcardRule ? null : systemDefault),
      wildcardRule,
    });
    return exactRule || wildcardRule || !resolved.eligible
      ? resolved
      : { ...resolved, source: 'connector', sourceDetail: 'recommended' };
  }

  if (input.connectorType === 'homelab') {
    return resolveNotificationPushPolicy({
      ...input,
      catalog: HOMELAB_NOTIFICATION_TYPES,
      exactRule,
      wildcardRule,
    });
  }

  if (input.connectorType === 'inbound-webhook') {
    const result = await database.query<{
      enabled: boolean;
      fieldMappings: unknown;
    }>(`
      SELECT enabled, field_mappings AS "fieldMappings"
      FROM inbound_webhooks WHERE id = $1
    `, [input.connectorInstanceId]);
    const webhook = result.rows[0];
    const catalog = webhook
      ? safeCatalog(input.connectorInstanceId, () => (
          parseLocalNotificationTypeCatalog('inbound-webhook', webhook.fieldMappings)
        ))
      : [];
    return resolveNotificationPushPolicy({
      ...input,
      catalog,
      exactRule,
      wildcardRule,
      connectorDeleted: !webhook,
      connectorDisabled: webhook ? !webhook.enabled : false,
    });
  }

  const result = await database.query<{
    id: string;
    type: string;
    name: string;
    enabled: boolean;
    syncMode: string;
    pollIntervalMinutes: number | null;
    capabilities: unknown;
    credentials: unknown;
    settings: unknown;
    syncedLists: unknown;
    deletedAt: string | null;
  }>(`
    SELECT id, type, name, enabled, sync_mode AS "syncMode",
           poll_interval_minutes AS "pollIntervalMinutes", capabilities,
           credentials, settings, synced_lists AS "syncedLists",
           deleted_at AS "deletedAt"
    FROM connector_configs WHERE id = $1
  `, [input.connectorInstanceId]);
  const connector = result.rows[0];
  if (!connector) {
    return resolveNotificationPushPolicy({
      ...input,
      catalog: [],
      exactRule,
      wildcardRule,
      connectorDeleted: true,
    });
  }
  const config: ConnectorConfig = {
    id: connector.id,
    type: connector.type,
    name: connector.name,
    enabled: connector.enabled,
    syncMode: connector.syncMode as ConnectorConfig['syncMode'],
    pollIntervalMinutes: connector.pollIntervalMinutes ?? undefined,
    capabilities: asObject(connector.capabilities) as unknown as ConnectorConfig['capabilities'],
    credentials: asObject(connector.credentials) as Record<string, string>,
    settings: asObject(connector.settings),
    syncedLists: Array.isArray(connector.syncedLists)
      ? connector.syncedLists.filter((item): item is string => typeof item === 'string')
      : [],
  };
  const catalog = safeCatalog(input.connectorInstanceId, () => (
    connectorRegistry.getNotificationTypeCatalog(connector.type, config)
  ));
  return resolveNotificationPushPolicy({
    ...input,
    templateKey: policyTemplateKey,
    catalog,
    exactRule: exactRule ? { ...exactRule, templateKey: policyTemplateKey } : null,
    wildcardRule,
    connectorDeleted: connector.deletedAt !== null,
    connectorDisabled: !connector.enabled,
  });
}

interface PostgresCreationContext {
  now: Date;
  timezone: string;
  channelEnabled: boolean | null;
  webChannelConfigured: boolean;
  apnsConfigured: boolean;
  apnsEnvironment: string | null;
  apnsTopic: string | null;
  globalMaxPerHour: number;
}

function createPostgresCreationContext(options: CreateNotificationOptions): PostgresCreationContext {
  let apnsEnvironment: string | null = null;
  let apnsTopic: string | null = null;
  let detectedApnsConfiguration = false;
  try {
    const configuration = getApnsConfiguration();
    apnsEnvironment = configuration.environment;
    apnsTopic = configuration.topic;
    detectedApnsConfiguration = true;
  } catch {
    // Missing channel configuration is captured as a durable suppression.
  }
  return {
    now: options.now ?? new Date(),
    timezone: options.timezone ?? getTimezone(),
    channelEnabled: options.channelEnabled ?? null,
    webChannelConfigured: options.channelConfigured ?? isWebPushConfigured(),
    apnsConfigured: options.apnsConfigured ?? detectedApnsConfiguration,
    apnsEnvironment,
    apnsTopic,
    globalMaxPerHour: configuredGlobalLimit(options.globalMaxPerHour),
  };
}

function buildPayload(
  notification: NotificationRecord,
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
    title: redactNotificationPushText(notification.title, 160),
    tag: `mc:${notification.id}`,
    url: navigationTarget ?? fallbackUrl,
  };
  if (notification.templateKey === 'task_reminder') payload.kind = 'task_reminder';
  if (policy.preview === 'title_and_body' && notification.body) {
    payload.body = redactNotificationPushText(notification.body, 512);
  }
  return payload;
}

async function getNotificationBySourceId(
  client: PoolClient,
  sourceId: string,
): Promise<NotificationRecord | null> {
  const result = await client.query<{ row: unknown }>(
    'SELECT to_jsonb(notifications) AS row FROM notifications WHERE source_id = $1',
    [sourceId],
  );
  return result.rows[0] ? mapNotification(result.rows[0].row) : null;
}

async function insertDeliveryEvent(
  client: PoolClient,
  values: {
    id: string;
    notificationId: string;
    channel: NotificationDeliveryChannel;
    dedupeKey: string;
    status: string;
    suppressionReason: NotificationSuppressionReason | null;
    policySnapshot: unknown;
    payloadSnapshot: MissionControlPushPayload;
    nextAttemptAt: string | null;
    createdAt: string;
    lastError: string | null;
  },
): Promise<NotificationDeliveryEventRecord> {
  const inserted = await client.query<{ row: unknown }>(`
    INSERT INTO notification_delivery_events (
      id, notification_id, channel, dedupe_key, status, suppression_reason,
      policy_snapshot, payload_snapshot, attempt_count, next_attempt_at,
      lease_expires_at, subscriptions_attempted, subscriptions_sent,
      subscriptions_failed, created_at, sent_at, last_error
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 0, $9,
              NULL, 0, 0, 0, $10, NULL, $11)
    ON CONFLICT(dedupe_key) DO NOTHING
    RETURNING to_jsonb(notification_delivery_events) AS row
  `, [
    values.id,
    values.notificationId,
    values.channel,
    values.dedupeKey,
    values.status,
    values.suppressionReason,
    JSON.stringify(values.policySnapshot),
    JSON.stringify(values.payloadSnapshot),
    values.nextAttemptAt,
    values.createdAt,
    values.lastError,
  ]);
  if (inserted.rows[0]) return mapDeliveryEvent(inserted.rows[0].row);
  const existing = await client.query<{ row: unknown }>(
    `SELECT to_jsonb(notification_delivery_events) AS row
     FROM notification_delivery_events WHERE dedupe_key = $1`,
    [values.dedupeKey],
  );
  if (!existing.rows[0]) {
    throw new Error(`Delivery event "${values.dedupeKey}" was not persisted`);
  }
  return mapDeliveryEvent(existing.rows[0].row);
}

async function resolvePostgresCreationSuppression(
  client: PoolClient,
  notification: NotificationRecord,
  policy: ResolvedNotificationPushPolicy,
  context: PostgresCreationContext,
  channel: NotificationDeliveryChannel,
): Promise<{ reason: NotificationSuppressionReason | null; gates: Record<string, boolean> }> {
  let channelEnabled = context.channelEnabled;
  if (channelEnabled === null) {
    const setting = await client.query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'`,
    );
    channelEnabled = setting.rows[0] ? parseBooleanSetting(setting.rows[0].value) : true;
  }
  const preferences = await client.query<{
    doNotDisturb: boolean;
    quietStart: number | null;
    quietEnd: number | null;
  }>(`
    SELECT do_not_disturb AS "doNotDisturb", quiet_start AS "quietStart",
           quiet_end AS "quietEnd"
    FROM push_preferences WHERE id = 'default'
  `);
  const preference = preferences.rows[0];
  const dnd = preference?.doNotDisturb ?? false;
  const quietHours = preference
    ? isQuietHour(
        getCurrentHour(context.now, context.timezone),
        preference.quietStart,
        preference.quietEnd,
      )
    : false;
  const channelConfigured = channel === 'web_push'
    ? context.webChannelConfigured
    : context.apnsConfigured;
  const subscription = channel === 'web_push'
    ? await client.query(`SELECT id FROM push_subscriptions WHERE platform = 'web' LIMIT 1`)
    : await client.query(
        `SELECT id FROM apns_registrations
         WHERE invalidated_at IS NULL AND environment = $1 AND topic = $2 LIMIT 1`,
        [context.apnsEnvironment ?? '', context.apnsTopic ?? ''],
      );
  const hasSubscriptions = (subscription.rowCount ?? 0) > 0;
  const gates = { channelEnabled, channelConfigured, dnd, quietHours, hasSubscriptions };

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

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('notification-push-rate:global'))`,
  );
  if (policy.maxPerHour !== null) {
    const ruleScope = policy.sourceDetail === 'wildcard'
      ? '*'
      : notification.templateKey ?? '';
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `notification-push-rate:rule:${notification.connectorInstanceId}:${ruleScope}`,
    ]);
  }

  const since = new Date(context.now.getTime() - 60 * 60 * 1_000).toISOString();
  const globalCount = await client.query<{ count: string }>(`
    SELECT count(DISTINCT notification_id)::text AS count
    FROM notification_delivery_events
    WHERE created_at >= $1 AND status = ANY($2::text[])
  `, [since, ACTIVE_RATE_LIMIT_STATUSES]);
  if (Number(globalCount.rows[0]?.count ?? 0) >= context.globalMaxPerHour) {
    return { reason: 'rate_limited', gates };
  }
  if (policy.maxPerHour !== null) {
    const ruleCount = await client.query<{ count: string }>(`
      SELECT count(DISTINCT delivery.notification_id)::text AS count
      FROM notification_delivery_events delivery
      INNER JOIN notifications notification ON notification.id = delivery.notification_id
      WHERE delivery.created_at >= $1
        AND delivery.status = ANY($2::text[])
        AND notification.connector_instance_id = $3
        AND ($4::boolean OR notification.template_key = $5)
    `, [
      since,
      ACTIVE_RATE_LIMIT_STATUSES,
      notification.connectorInstanceId,
      policy.sourceDetail === 'wildcard',
      notification.templateKey ?? '',
    ]);
    if (Number(ruleCount.rows[0]?.count ?? 0) >= policy.maxPerHour) {
      return { reason: 'rate_limited', gates };
    }
  }
  return { reason: null, gates };
}

async function createOnePostgresNotification(
  client: PoolClient,
  input: CreateNotificationInput,
  context: PostgresCreationContext,
): Promise<CreateNotificationResult> {
  const sourceId = requireText(input.sourceId, 'sourceId');
  const connectorType = requireText(input.connectorType, 'connectorType');
  const connectorInstanceId = requireText(input.connectorInstanceId, 'connectorInstanceId');
  const title = requireText(input.title, 'title');
  const templateKey = input.templateKey?.trim() || null;
  let navigationTarget: string | null = null;
  try {
    navigationTarget = normalizeInternalNavigationTarget(input.navigationTarget);
  } catch (error) {
    logger.warn({ err: error, sourceId }, 'Ignored unsafe notification navigation target');
  }
  const normalizedLevel = normalizeNotificationLevel(input.level);
  const nowIso = context.now.toISOString();
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

  const inserted = await client.query<{ row: unknown }>(`
    INSERT INTO notifications (
      id, source_id, connector_type, connector_instance_id, title, body, level,
      level_rank, category, template_key, state, read_state, disposition,
      source_state, sync_state, read_at, handled_at, dismissed_at,
      source_resolved_at, last_source_activity_at, last_source_activity_key,
      handled_source_activity_at, handled_source_activity_key, last_source_synced_at,
      received_at, sort_at, expires_at, group_key, dedupe_key, related_task_id,
      related_project_id, related_entity_type, related_entity_id, navigation_target,
      metadata, presentation, enrichment_revision, enrichment_generation,
      is_actionable, primary_action_id, ai_suggested_action_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
      $30, $31, $32, $33, $34, $35::jsonb, $36::jsonb, $37, $38, $39, $40, $41
    )
    ON CONFLICT(source_id) DO NOTHING
    RETURNING to_jsonb(notifications) AS row
  `, [
    input.id ?? randomUUID(),
    sourceId,
    connectorType,
    connectorInstanceId,
    title,
    input.body ?? null,
    normalizedLevel.level,
    getNotificationLevelRank(normalizedLevel.level),
    input.category?.trim() || 'system',
    templateKey,
    state,
    readState,
    disposition,
    sourceState,
    syncState,
    readState === 'read' ? (legacyPatch?.readAt ?? nowIso) : null,
    disposition === 'handled' ? (legacyPatch?.handledAt ?? nowIso) : null,
    disposition === 'dismissed' ? (legacyPatch?.dismissedAt ?? nowIso) : null,
    sourceState === 'resolved' || sourceState === 'deleted'
      ? (legacyPatch?.sourceResolvedAt ?? nowIso)
      : null,
    sourceActivityAt,
    sourceActivityKey,
    disposition === 'handled' ? sourceActivityAt : null,
    disposition === 'handled' ? sourceActivityKey : null,
    nowIso,
    input.receivedAt ?? nowIso,
    input.sortAt ?? input.receivedAt ?? nowIso,
    input.expiresAt ?? null,
    input.groupKey ?? null,
    input.dedupeKey ?? null,
    input.relatedTaskId ?? null,
    input.relatedProjectId ?? null,
    input.relatedEntityType ?? null,
    input.relatedEntityId ?? null,
    navigationTarget,
    JSON.stringify(input.metadata ?? {}),
    JSON.stringify(input.presentation ?? {}),
    input.enrichmentRevision ?? null,
    input.enrichmentRevision === undefined ? 0 : 1,
    input.isActionable ?? false,
    input.primaryActionId ?? null,
    input.aiSuggestedActionId ?? null,
  ]);
  const created = Boolean(inserted.rows[0]);
  let notification = inserted.rows[0]
    ? mapNotification(inserted.rows[0].row)
    : await getNotificationBySourceId(client, sourceId);
  if (!notification) throw new Error(`Notification "${sourceId}" was not persisted`);
  if (
    notification.connectorInstanceId !== connectorInstanceId
    || notification.connectorType !== connectorType
  ) {
    throw new Error(
      `Notification source identity "${sourceId}" belongs to a different connector instance`,
    );
  }

  if (!created) {
    const reopen = shouldReopenForSourceActivity(
      notification as Parameters<typeof shouldReopenForSourceActivity>[0],
      { sourceState, sourceActivityAt: incomingSourceActivityAt, sourceActivityKey },
      input.reopenPolicy,
    );
    const nextDisposition = reopen ? 'inbox' : notification.disposition;
    const nextReadState = reopen ? readState : notification.readState;
    const nextState = legacyStateFromLifecycle({
      disposition: nextDisposition as typeof disposition,
      readState: nextReadState as typeof readState,
      sourceState,
    });
    const nextMetadata = reconcileNotificationEnrichmentMetadata(
      notification.metadata,
      input.metadata ?? {},
      notification.enrichmentRevision,
      input.enrichmentRevision,
    );
    const updated = await client.query<{ row: unknown }>(`
      UPDATE notifications SET
        title = $1, body = $2, level = $3, level_rank = $4, category = $5,
        template_key = $6, state = $7, read_state = $8, disposition = $9,
        source_state = $10, sync_state = $11, read_at = $12,
        source_resolved_at = $13, last_source_activity_at = $14,
        last_source_activity_key = $15, last_source_synced_at = $16,
        sort_at = $17, expires_at = $18, group_key = $19, dedupe_key = $20,
        related_task_id = $21, related_project_id = $22,
        related_entity_type = $23, related_entity_id = $24,
        navigation_target = $25, metadata = $26::jsonb, presentation = $27::jsonb,
        enrichment_revision = $28, enrichment_generation = $29,
        is_actionable = $30, primary_action_id = $31, ai_suggested_action_id = $32
      WHERE id = $33
      RETURNING to_jsonb(notifications) AS row
    `, [
      title,
      input.body ?? null,
      normalizedLevel.level,
      getNotificationLevelRank(normalizedLevel.level),
      input.category?.trim() || 'system',
      templateKey,
      nextState,
      nextReadState,
      nextDisposition,
      sourceState,
      input.syncState ?? notification.syncState,
      reopen && nextReadState === 'unread' ? null : notification.readAt,
      sourceState === 'resolved' || sourceState === 'deleted'
        ? (notification.sourceResolvedAt ?? nowIso)
        : null,
      incomingSourceActivityAt ?? notification.lastSourceActivityAt,
      input.sourceActivityKey === undefined
        ? notification.lastSourceActivityKey
        : sourceActivityKey,
      nowIso,
      reopen ? (incomingSourceActivityAt ?? nowIso) : notification.sortAt,
      input.expiresAt ?? null,
      input.groupKey ?? null,
      input.dedupeKey ?? null,
      input.relatedTaskId ?? null,
      input.relatedProjectId ?? null,
      input.relatedEntityType ?? null,
      input.relatedEntityId ?? null,
      navigationTarget,
      JSON.stringify(nextMetadata),
      JSON.stringify(input.presentation ?? {}),
      input.enrichmentRevision === undefined
        ? notification.enrichmentRevision
        : input.enrichmentRevision,
      input.enrichmentRevision === undefined
        ? notification.enrichmentGeneration
        : input.enrichmentRevision === notification.enrichmentRevision
          ? notification.enrichmentGeneration
          : notification.enrichmentGeneration + 1,
      input.isActionable ?? false,
      input.primaryActionId ?? null,
      input.aiSuggestedActionId ?? null,
      notification.id,
    ]);
    if (!updated.rows[0]) throw new Error(`Notification "${sourceId}" disappeared during update`);
    notification = mapNotification(updated.rows[0].row);
  }

  const occurrenceKey = input.occurrenceKey?.trim() || 'initial';
  const dedupeKeys = DELIVERY_CHANNELS.map(channel => (
    `${channel}:${notification!.id}:${occurrenceKey}`
  ));
  const priorResult = await client.query<{ row: unknown }>(`
    SELECT to_jsonb(notification_delivery_events) AS row
    FROM notification_delivery_events
    WHERE dedupe_key = ANY($1::text[])
    ORDER BY CASE channel WHEN 'web_push' THEN 0 ELSE 1 END
  `, [dedupeKeys]);
  const priorDeliveries = priorResult.rows.map(row => mapDeliveryEvent(row.row));
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
    policy = await resolvePostgresStoredNotificationPushPolicy(client, {
      connectorInstanceId: notification.connectorInstanceId,
      connectorType: notification.connectorType,
      templateKey: notification.templateKey,
      level: normalizeNotificationLevel(notification.level).level,
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
      failedEvents.push(await insertDeliveryEvent(client, {
        id: randomUUID(),
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
        nextAttemptAt: null,
        createdAt: nowIso,
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
  const suppressions = new Map<NotificationDeliveryChannel, Awaited<
    ReturnType<typeof resolvePostgresCreationSuppression>
  >>();
  for (const channel of DELIVERY_CHANNELS) {
    suppressions.set(
      channel,
      await resolvePostgresCreationSuppression(client, notification, policy, context, channel),
    );
  }
  const deliveryEvents = [...priorDeliveries];
  for (const channel of DELIVERY_CHANNELS) {
    if (deliveryEvents.some(event => event.channel === channel)) continue;
    const suppression = suppressions.get(channel)!;
    const status = suppression.reason ? 'suppressed' : 'pending';
    deliveryEvents.push(await insertDeliveryEvent(client, {
      id: randomUUID(),
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
      nextAttemptAt: status === 'pending' ? nowIso : null,
      createdAt: nowIso,
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

export async function createPostgresNotificationsInTransaction(
  client: PoolClient,
  inputs: readonly CreateNotificationInput[],
  options: CreateNotificationOptions = {},
): Promise<CreateNotificationResult[]> {
  const context = createPostgresCreationContext(options);
  const results: CreateNotificationResult[] = [];
  for (const input of inputs) {
    results.push(await createOnePostgresNotification(client, input, context));
  }
  return results;
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}

export function createPostgresNotificationDeliveryRepository(
  pool: Pool,
): NotificationDeliveryRepository {
  return {
    async claimNext(input) {
      const nowIso = input.now.toISOString();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
      for (let scanned = 0; scanned < 25; scanned += 1) {
        const client = await pool.connect();
        let row: RawClaim | undefined;
        try {
          await client.query('BEGIN');
          const exhausted = await client.query<{ id: string }>(
            `
              WITH candidate AS (
                SELECT id
                FROM notification_delivery_events
                WHERE channel IN ('web_push', 'apns')
                  AND attempt_count >= $1
                  AND (
                    (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $2))
                    OR
                    (status = 'sending' AND lease_expires_at IS NOT NULL
                      AND lease_expires_at <= $2)
                  )
                ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
              )
              UPDATE notification_delivery_events event
              SET status = 'failed',
                  claim_token = NULL,
                  lease_expires_at = NULL,
                  next_attempt_at = NULL,
                  last_error = 'retry_limit_exhausted'
              FROM candidate
              WHERE event.id = candidate.id
              RETURNING event.id
            `,
            [input.maxAttempts, nowIso],
          );
          if ((exhausted.rowCount ?? 0) > 0) {
            await client.query('COMMIT');
            continue;
          }

          const claimToken = randomUUID();
          const claimed = await client.query<RawClaim>(
            `
              WITH candidate AS (
                SELECT id
                FROM notification_delivery_events
                WHERE channel IN ('web_push', 'apns')
                  AND attempt_count < $1
                  AND (
                    (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $2))
                    OR
                    (status = 'sending' AND lease_expires_at IS NOT NULL
                      AND lease_expires_at <= $2)
                  )
                ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
              )
              UPDATE notification_delivery_events event
              SET status = 'sending',
                  attempt_count = event.attempt_count + 1,
                  lease_expires_at = $3,
                  claim_token = $4,
                  last_error = NULL
              FROM candidate
              WHERE event.id = candidate.id
              RETURNING event.id, event.notification_id, event.channel, event.dedupe_key,
                        event.attempt_count, event.payload_snapshot, event.lease_expires_at,
                        event.claim_token
            `,
            [input.maxAttempts, nowIso, leaseExpiresAt, claimToken],
          );
          row = claimed.rows[0];
          await client.query('COMMIT');
        } catch (error) {
          await rollback(client);
          throw error;
        } finally {
          client.release();
        }

        if (!row) return null;
        if (row.channel !== 'web_push' && row.channel !== 'apns') {
          await pool.query(
            `
              UPDATE notification_delivery_events
              SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
                  next_attempt_at = NULL, last_error = 'invalid_payload'
              WHERE id = $1 AND status = 'sending' AND claim_token = $2
            `,
            [row.id, row.claim_token],
          );
          continue;
        }
        try {
          return {
            id: row.id,
            notificationId: row.notification_id,
            channel: row.channel,
            dedupeKey: row.dedupe_key,
            attemptCount: row.attempt_count,
            payloadSnapshot: parseNotificationDeliveryPayload(row.payload_snapshot),
            leaseExpiresAt: row.lease_expires_at,
            claimToken: row.claim_token,
          };
        } catch {
          await pool.query(
            `
              UPDATE notification_delivery_events
              SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
                  next_attempt_at = NULL, last_error = 'invalid_payload'
              WHERE id = $1 AND status = 'sending' AND claim_token = $2
            `,
            [row.id, row.claim_token],
          );
        }
      }
      return null;
    },

    async resolveSuppression(claim, input) {
      if (!input.channelConfigured) return 'channel_unconfigured';
      const setting = await pool.query<{ value: unknown }>(
        `SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'`,
      );
      if (setting.rows[0] && !parseBooleanSetting(setting.rows[0].value)) {
        return 'channel_disabled';
      }
      const preferences = await pool.query<{
        do_not_disturb: boolean;
        quiet_start: number | null;
        quiet_end: number | null;
      }>(`
        SELECT do_not_disturb, quiet_start, quiet_end
        FROM push_preferences WHERE id = 'default'
      `);
      const preference = preferences.rows[0];
      if (preference?.do_not_disturb) return 'dnd';
      if (
        preference
        && isQuietHour(input.currentHour, preference.quiet_start, preference.quiet_end)
      ) {
        return 'quiet_hours';
      }

      const eligibility = await pool.query<EligibilityRow>(
        `
          SELECT n.source_id, n.connector_type, n.connector_instance_id,
                 n.disposition, n.source_state, n.read_state, n.snoozed_until, n.level,
                 c.enabled AS connector_enabled, c.deleted_at AS connector_deleted_at,
                 w.enabled AS webhook_enabled,
                 f.delivery_enabled AS finance_delivery_enabled
          FROM notifications n
          LEFT JOIN connector_configs c ON c.id = n.connector_instance_id
          LEFT JOIN inbound_webhooks w ON w.id = n.connector_instance_id
          LEFT JOIN finance_insight_cutovers f ON f.connector_id = n.connector_instance_id
          WHERE n.id = $1
        `,
        [claim.notificationId],
      );
      const row = eligibility.rows[0];
      if (!row) return 'not_attention_eligible';
      if (
        row.connector_type === 'finance-manager'
        && (
          row.source_id.startsWith('finance-insight:')
          || row.source_id.startsWith('finance-insight-digest:')
        )
        && row.finance_delivery_enabled !== true
      ) {
        return 'connector_disabled';
      }
      if (!needsAttention({
        disposition: row.disposition,
        sourceState: row.source_state,
        readState: row.read_state,
        snoozedUntil: row.snoozed_until,
        level: row.level,
      }, input.now)) {
        return 'not_attention_eligible';
      }
      if (row.connector_type === 'system') return null;
      if (row.connector_type === 'inbound-webhook') {
        if (row.webhook_enabled === null) return 'connector_deleted';
        return row.webhook_enabled ? null : 'connector_disabled';
      }
      if (row.connector_enabled === null || row.connector_deleted_at !== null) {
        return 'connector_deleted';
      }
      return row.connector_enabled ? null : 'connector_disabled';
    },

    async finalize(claim, values) {
      const result = await pool.query(
        `
          UPDATE notification_delivery_events
          SET status = $1,
              suppression_reason = $2,
              next_attempt_at = NULL,
              lease_expires_at = NULL,
              claim_token = NULL,
              subscriptions_attempted = $3,
              subscriptions_sent = $4,
              subscriptions_failed = $5,
              sent_at = $6,
              last_error = $7
          WHERE id = $8 AND status = 'sending' AND claim_token = $9
        `,
        [
          values.status,
          values.suppressionReason ?? null,
          values.counters?.attempted ?? 0,
          values.counters?.sent ?? 0,
          values.counters?.failed ?? 0,
          values.sentAt ?? null,
          values.lastError ?? null,
          claim.id,
          claim.claimToken,
        ],
      );
      return result.rowCount === 1;
    },

    async scheduleRetry(claim, input) {
      const result = await pool.query(
        `
          UPDATE notification_delivery_events
          SET status = 'pending',
              next_attempt_at = $1,
              lease_expires_at = NULL,
              claim_token = NULL,
              subscriptions_attempted = $2,
              subscriptions_sent = $3,
              subscriptions_failed = $4,
              last_error = $5
          WHERE id = $6 AND status = 'sending' AND claim_token = $7
        `,
        [
          input.nextAttemptAt,
          input.counters?.attempted ?? 0,
          input.counters?.sent ?? 0,
          input.counters?.failed ?? 0,
          input.lastError,
          claim.id,
          claim.claimToken,
        ],
      );
      return result.rowCount === 1;
    },

    async getNextWakeAt() {
      const result = await pool.query<{ due_at: string | null }>(`
        SELECT MIN(
          CASE
            WHEN status = 'pending' THEN COALESCE(next_attempt_at, created_at)
            WHEN status = 'sending' THEN lease_expires_at
          END
        ) AS due_at
        FROM notification_delivery_events
        WHERE channel IN ('web_push', 'apns') AND status IN ('pending', 'sending')
      `);
      return result.rows[0]?.due_at ?? null;
    },

    async listWebPushSubscriptions() {
      const result = await pool.query<{ id: string; endpoint: string; keys: unknown }>(`
        SELECT id, endpoint, keys FROM push_subscriptions WHERE platform = 'web'
      `);
      return result.rows.map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        keys: parseKeys(row.keys),
      }));
    },

    async retireWebPushSubscription(id) {
      const result = await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
      return result.rowCount === 1;
    },

    async listApnsRegistrations(input) {
      const result = await pool.query<ApnsRegistrationRecord>(
        `
          SELECT id, token_ciphertext AS "tokenCiphertext", environment, topic
          FROM apns_registrations
          WHERE environment = $1 AND topic = $2 AND invalidated_at IS NULL
        `,
        [input.environment, input.topic],
      );
      return result.rows;
    },

    async invalidateApnsRegistration(input) {
      const result = await pool.query(
        `
          UPDATE apns_registrations
          SET invalidated_at = $1, invalidation_reason = $2, updated_at = $1
          WHERE id = $3 AND invalidated_at IS NULL
        `,
        [input.invalidatedAt, input.reason, input.id],
      );
      return result.rowCount === 1;
    },

    push: createPostgresNotificationPushRepository(pool),
    web: createPostgresNotificationWebRepository(pool),
    creation: {
      async createNotifications(inputs, options = {}) {
        if (inputs.length === 0) return [];
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const results = await createPostgresNotificationsInTransaction(
            client,
            inputs,
            options,
          );
          await client.query('COMMIT');
          return results;
        } catch (error) {
          await rollback(client);
          throw error;
        } finally {
          client.release();
        }
      },

      async resolveCurrentGlobalPushSuppression(now, channel) {
        const enabled = await pool.query<{ value: unknown }>(
          `SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'`,
        );
        if (enabled.rows[0] && !parseBooleanSetting(enabled.rows[0].value)) {
          return 'channel_disabled';
        }
        if (channel === 'web_push' ? !isWebPushConfigured() : !isApnsConfigured()) {
          return 'channel_unconfigured';
        }
        const preferences = await pool.query<{
          doNotDisturb: boolean;
          quietStart: number | null;
          quietEnd: number | null;
        }>(`
          SELECT do_not_disturb AS "doNotDisturb", quiet_start AS "quietStart",
                 quiet_end AS "quietEnd"
          FROM push_preferences WHERE id = 'default'
        `);
        const preference = preferences.rows[0];
        if (preference?.doNotDisturb) return 'dnd';
        if (
          preference
          && isQuietHour(
            getCurrentHour(now, getTimezone()),
            preference.quietStart,
            preference.quietEnd,
          )
        ) {
          return 'quiet_hours';
        }
        return null;
      },

      async countPendingDeliveries() {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM notification_delivery_events WHERE status = 'pending'`,
        );
        return Number(result.rows[0]?.count ?? 0);
      },
    },
    pushRules: {
      async save(input) {
        const now = new Date().toISOString();
        const result = await pool.query<NotificationPushRule>(`
          INSERT INTO notification_push_rules (
            id, connector_instance_id, template_key, enabled, min_level,
            preview, max_per_hour, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
          ON CONFLICT(connector_instance_id, template_key) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            min_level = EXCLUDED.min_level,
            preview = EXCLUDED.preview,
            max_per_hour = EXCLUDED.max_per_hour,
            updated_at = EXCLUDED.updated_at
          RETURNING id, connector_instance_id AS "connectorInstanceId",
                    template_key AS "templateKey", enabled, min_level AS "minLevel",
                    preview, max_per_hour AS "maxPerHour",
                    created_at AS "createdAt", updated_at AS "updatedAt"
        `, [
          input.id ?? randomUUID(),
          input.connectorInstanceId,
          input.templateKey,
          input.enabled,
          input.minLevel,
          input.preview,
          input.maxPerHour ?? null,
          now,
        ]);
        const saved = result.rows[0];
        if (!saved) throw new Error('Notification push rule was not persisted');
        return saved;
      },

      async listOverrides(connectorInstanceId, templateKey) {
        const result = await pool.query<NotificationPushRule>(`
          SELECT id, connector_instance_id AS "connectorInstanceId",
                 template_key AS "templateKey", enabled, min_level AS "minLevel",
                 preview, max_per_hour AS "maxPerHour",
                 created_at AS "createdAt", updated_at AS "updatedAt"
          FROM notification_push_rules
          WHERE connector_instance_id = $1
            AND ($2::text IS NULL OR template_key IN ($2, '*'))
        `, [connectorInstanceId, templateKey ?? null]);
        return result.rows;
      },

      async reset(connectorInstanceId, templateKey) {
        await pool.query(`
          DELETE FROM notification_push_rules
          WHERE connector_instance_id = $1 AND template_key = $2
        `, [connectorInstanceId, templateKey]);
      },
    },
    policy: {
      async resolve(input) {
        return resolvePostgresStoredNotificationPushPolicy(pool, input);
      },
    },
    scheduledTriggers: {
      async getMorningSnapshot(localDate) {
        const result = await pool.query<{ plannedCount: string; overdueCount: string }>(`
          SELECT
            (
              SELECT count(*)::text FROM tasks
              WHERE id IN (
                SELECT task_id FROM my_day_items WHERE date = $1 LIMIT 50
              )
                AND status NOT IN ('done', 'cancelled')
            ) AS "plannedCount",
            (
              SELECT count(*)::text FROM (
                SELECT id FROM tasks
                WHERE due_date < $1 AND status NOT IN ('done', 'cancelled')
                LIMIT 100
              ) overdue
            ) AS "overdueCount"
        `, [localDate]);
        return {
          plannedCount: Number(result.rows[0]?.plannedCount ?? 0),
          overdueCount: Number(result.rows[0]?.overdueCount ?? 0),
        };
      },

      async getTriageSnapshot(localDate) {
        const count = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM triage_items WHERE status = 'pending'`,
        );
        const sourcePrefix = `push:triage_nudge:${localDate}:`;
        const prior = await pool.query<{ sourceId: string; metadata: unknown }>(`
          SELECT source_id AS "sourceId", metadata
          FROM notifications
          WHERE connector_type = 'system'
            AND connector_instance_id = 'push-triggers'
            AND template_key = 'triage_nudge'
            AND source_id LIKE $1
        `, [`${sourcePrefix.replace(/[%_\\]/g, '\\$&')}%`]);
        let highWater: number | null = null;
        for (const row of prior.rows) {
          const metadata = asObject(row.metadata);
          const metadataCount = metadata.queueSize;
          const value = typeof metadataCount === 'number'
            && Number.isInteger(metadataCount)
            && metadataCount >= 0
            ? metadataCount
            : Number(row.sourceId.slice(sourcePrefix.length));
          if (
            Number.isInteger(value)
            && value >= 0
            && (highWater === null || value > highWater)
          ) {
            highWater = value;
          }
        }
        return { pendingCount: Number(count.rows[0]?.count ?? 0), highWater };
      },

      async getCarryForwardSnapshot(localDate) {
        const result = await pool.query<{ title: string }>(`
          SELECT title
          FROM tasks
          WHERE id IN (
            SELECT task_id FROM my_day_items WHERE date = $1 LIMIT 50
          )
            AND status NOT IN ('done', 'cancelled')
        `, [localDate]);
        return { incompleteTaskTitles: result.rows.map(row => row.title) };
      },
    },
  };
}
