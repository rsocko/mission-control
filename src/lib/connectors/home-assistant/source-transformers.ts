import type { InboundNotification, NotificationLevel } from '@/types';
import type {
  HomeAssistantConfigEntry,
  HomeAssistantPersistentNotification,
  HomeAssistantRepairIssue,
  HomeAssistantState,
} from './ha-client';
import { matchPattern } from './entity-transformer';

const UPDATE_SUPPORT_INSTALL = 1;
const UPDATE_SUPPORT_BACKUP = 8;
const UPDATE_SUPPORT_RELEASE_NOTES = 16;

export const INTEGRATION_HEALTH_FAILURE_STATES = new Set([
  'failed_unload',
  'migration_error',
  'setup_error',
  'setup_retry',
]);

export const INTEGRATION_HEALTH_KNOWN_STATES = new Set([
  ...INTEGRATION_HEALTH_FAILURE_STATES,
  'loaded',
  'not_loaded',
  'setup_in_progress',
  'unload_in_progress',
]);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on';
}

function finiteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeId(value: string): string {
  return encodeURIComponent(value);
}

function sourceUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function translationPlaceholders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => (
        entry[0].length <= 100 && typeof entry[1] === 'string'
      ))
      .slice(0, 20)
      .map(([key, placeholder]) => [key, placeholder.slice(0, 300)]),
  );
}

export function buildIntegrationHealthNotifications(input: {
  entries: HomeAssistantConfigEntry[];
  connectorType: string;
  connectorInstanceId: string;
  instanceName: string;
  baseUrl: string;
  immediateFailures: boolean;
  observedAt?: string;
}): InboundNotification[] {
  const observedAt = input.observedAt ?? new Date().toISOString();
  return input.entries.flatMap((entry): InboundNotification[] => {
    const entryId = text(entry.entry_id);
    const domain = text(entry.domain);
    const state = text(entry.state);
    if (
      !entryId
      || !domain
      || !state
      || entry.disabled_by != null
      || !INTEGRATION_HEALTH_FAILURE_STATES.has(state)
    ) {
      return [];
    }

    const title = (text(entry.title) ?? domain).slice(0, 200);
    const reason = text(entry.reason)?.slice(0, 1_000) ?? null;
    const retrying = state === 'setup_retry';
    const level: NotificationLevel = retrying ? 'heads_up' : 'action_needed';
    return [{
      id: `integration-health:${safeId(entryId)}`,
      sourceId: entryId,
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      title: retrying ? `${title} setup is retrying` : `${title} integration failed`,
      body: reason ?? (retrying
        ? 'Home Assistant could not set up this integration and will retry.'
        : `Home Assistant reported ${state.replace(/_/g, ' ')}.`),
      level,
      category: 'system',
      templateKey: retrying ? 'ha_integration_retry' : 'ha_integration_failed',
      isRead: false,
      isActionable: false,
      actionUrl: sourceUrl(input.baseUrl, `/config/integrations/integration/${encodeURIComponent(domain)}`),
      receivedAt: observedAt,
      sourceActivityKey: `${entryId}:${state}:${reason ?? ''}`,
      reopenPolicy: 'handled_and_dismissed',
      hubProjectIds: [],
      tags: [],
      metadata: {
        schemaVersion: 2,
        haSource: 'integration_health',
        instanceName: input.instanceName,
        configEntryId: entryId,
        integrationDomain: domain,
        integrationTitle: title,
        configEntryState: state,
        reason,
        errorReasonTranslationDomain: text(entry.error_reason_translation_domain),
        errorReasonTranslationKey: text(entry.error_reason_translation_key),
        errorReasonTranslationPlaceholders:
          translationPlaceholders(entry.error_reason_translation_placeholders),
        baseUrl: input.baseUrl,
        pushDelivery: !retrying && input.immediateFailures ? 'immediate' : 'default',
      },
    }];
  });
}

export function buildUpdateNotifications(input: {
  states: HomeAssistantState[];
  connectorType: string;
  connectorInstanceId: string;
  instanceName: string;
  baseUrl: string;
  actionsEnabled: boolean;
  criticalEntityPatterns: string[];
  updatePush: 'immediate' | 'daily_summary' | 'off';
  immediateCriticalUpdates: boolean;
}): InboundNotification[] {
  return input.states.flatMap((entity): InboundNotification[] => {
    if (!entity.entity_id.startsWith('update.')) return [];
    if (entity.state === 'unknown' || entity.state === 'unavailable') return [];
    const attributes = entity.attributes ?? {};
    const inProgress = bool(attributes.in_progress);
    if (entity.state !== 'on' && !inProgress) return [];

    const latestVersion = text(attributes.latest_version) ?? 'available';
    const installedVersion = text(attributes.installed_version) ?? 'unknown';
    const title = text(attributes.title) ?? text(attributes.friendly_name) ?? entity.entity_id;
    const supportedFeatures = finiteNumber(attributes.supported_features) ?? 0;
    const critical = input.criticalEntityPatterns.some(pattern => matchPattern(entity.entity_id, pattern));
    const progress = finiteNumber(attributes.update_percentage);
    const changedAt = entity.last_updated || entity.last_changed || new Date().toISOString();
    const supportsInstall = (supportedFeatures & UPDATE_SUPPORT_INSTALL) !== 0;
    const supportsBackup = (supportedFeatures & UPDATE_SUPPORT_BACKUP) !== 0;
    const entityPicture = text(attributes.entity_picture);
    const updateType = entityPicture?.startsWith('/api/hassio/addons/')
      ? 'app'
      : 'software';

    return [{
      id: `update:${safeId(entity.entity_id)}:${safeId(latestVersion)}`,
      sourceId: entity.entity_id,
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      title: inProgress ? `Installing ${title}` : `Update available: ${title}`,
      body: text(attributes.release_summary) ?? undefined,
      level: critical ? 'action_needed' : 'heads_up',
      category: 'system',
      templateKey: critical ? 'ha_update_critical' : 'ha_update_available',
      isRead: false,
      isActionable: input.actionsEnabled && supportsInstall && !inProgress,
      actionUrl: sourceUrl(input.baseUrl, '/config/updates'),
      receivedAt: changedAt,
      sourceActivityAt: changedAt,
      sourceActivityKey: `${entity.entity_id}:${latestVersion}:${inProgress}:${progress ?? ''}`,
      reopenPolicy: 'handled_and_dismissed',
      hubProjectIds: [],
      tags: [],
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        instanceName: input.instanceName,
        entityId: entity.entity_id,
        installedVersion,
        latestVersion,
        entityPicture,
        mdiIcon: text(attributes.icon),
        deviceClass: text(attributes.device_class),
        updateType,
        inProgress,
        updatePercentage: progress !== null ? Math.min(100, Math.max(0, progress)) : null,
        supportsInstall,
        supportsBackup,
        supportsReleaseNotes: (supportedFeatures & UPDATE_SUPPORT_RELEASE_NOTES) !== 0,
        canSkip: !bool(attributes.auto_update),
        releaseUrl: text(attributes.release_url),
        baseUrl: input.baseUrl,
        actionsEnabled: input.actionsEnabled,
        critical,
        pushDelivery: critical && input.immediateCriticalUpdates
          ? 'immediate'
          : input.updatePush,
      },
    }];
  });
}

export function buildPersistentNotifications(input: {
  items: HomeAssistantPersistentNotification[];
  connectorType: string;
  connectorInstanceId: string;
  instanceName: string;
  baseUrl: string;
  actionsEnabled: boolean;
  criticalNotificationPatterns: string[];
  immediateCritical: boolean;
}): InboundNotification[] {
  return input.items.flatMap((item): InboundNotification[] => {
    const notificationId = text(item.notification_id);
    if (!notificationId) return [];
    const critical = input.criticalNotificationPatterns.some(pattern => matchPattern(notificationId, pattern));
    const receivedAt = text(item.created_at) ?? new Date().toISOString();
    return [{
      id: `persistent:${safeId(notificationId)}`,
      sourceId: notificationId,
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      title: text(item.title) ?? 'Home Assistant notification',
      body: text(item.message) ?? undefined,
      level: critical ? 'action_needed' : 'heads_up',
      category: critical ? 'automation' : 'home',
      templateKey: critical ? 'ha_persistent_critical' : 'ha_persistent_notification',
      isRead: false,
      isActionable: input.actionsEnabled,
      // Home Assistant exposes persistent notifications only through its
      // notification drawer, which has no URL-addressable route.
      actionUrl: input.baseUrl,
      receivedAt,
      sourceActivityAt: receivedAt,
      sourceActivityKey: `${notificationId}:${receivedAt}`,
      reopenPolicy: 'handled_and_dismissed',
      hubProjectIds: [],
      tags: [],
      metadata: {
        schemaVersion: 2,
        haSource: 'persistent_notifications',
        instanceName: input.instanceName,
        notificationId,
        baseUrl: input.baseUrl,
        actionsEnabled: input.actionsEnabled,
        critical,
        pushDelivery: critical && input.immediateCritical ? 'immediate' : 'default',
      },
    }];
  });
}

function repairLevel(value: unknown): NotificationLevel {
  switch (value) {
    case 'critical': return 'urgent';
    case 'error': return 'action_needed';
    case 'warning': return 'heads_up';
    default: return 'heads_up';
  }
}

export function buildRepairNotifications(input: {
  issues: HomeAssistantRepairIssue[];
  connectorType: string;
  connectorInstanceId: string;
  instanceName: string;
  baseUrl: string;
  actionsEnabled: boolean;
  immediateActionNeeded: boolean;
}): InboundNotification[] {
  return input.issues.flatMap((issue): InboundNotification[] => {
    const domain = text(issue.domain);
    const issueId = text(issue.issue_id);
    if (!domain || !issueId || issue.ignored === true) return [];
    const level = repairLevel(issue.severity);
    const createdAt = text(issue.created) ?? new Date().toISOString();
    const title = text(issue.title) ?? `${domain}: ${issueId.replace(/[_-]+/g, ' ')}`;
    return [{
      id: `repair:${safeId(domain)}:${safeId(issueId)}`,
      sourceId: `${domain}:${issueId}`,
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      title,
      body: text(issue.description) ?? text(issue.translation_key) ?? undefined,
      level,
      category: 'system',
      templateKey: `ha_repair_${String(issue.severity || 'warning')}`,
      isRead: false,
      isActionable: input.actionsEnabled,
      actionUrl: sourceUrl(input.baseUrl, '/config/repairs'),
      receivedAt: createdAt,
      sourceActivityAt: createdAt,
      sourceActivityKey: `${domain}:${issueId}:${String(issue.severity || '')}`,
      reopenPolicy: 'handled_and_dismissed',
      hubProjectIds: [],
      tags: [],
      metadata: {
        schemaVersion: 2,
        haSource: 'repairs',
        instanceName: input.instanceName,
        domain,
        issueId,
        severity: String(issue.severity || 'warning'),
        isFixable: issue.is_fixable === true,
        isPersistent: issue.is_persistent === true,
        baseUrl: input.baseUrl,
        actionsEnabled: input.actionsEnabled,
        pushDelivery: input.immediateActionNeeded
          && (level === 'urgent' || level === 'action_needed')
          ? 'immediate'
          : 'default',
      },
    }];
  });
}
