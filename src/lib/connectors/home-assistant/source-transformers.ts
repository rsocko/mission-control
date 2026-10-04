import type { InboundNotification, NotificationLevel } from '@/types';
import type { HomeAssistantState, HomeAssistantPersistentNotification, HomeAssistantRepairIssue } from './ha-client';
import { matchPattern } from './entity-transformer';

const UPDATE_SUPPORT_INSTALL = 1;
const UPDATE_SUPPORT_BACKUP = 8;
const UPDATE_SUPPORT_RELEASE_NOTES = 16;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on';
}

function finiteNumber(value: unknown): number | null {
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
  ) {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeId(value: string): string {
  return encodeURIComponent(value);
}

function humanizeIdentifier(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

function sourceUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
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

function isHomeAssistantRestartRepair(issue: HomeAssistantRepairIssue): boolean {
  const domain = text(issue.domain)?.toLowerCase();
  if (!['homeassistant', 'hassio', 'hacs', 'marketplace'].includes(domain ?? '')) {
    return false;
  }

  return [issue.translation_key, issue.issue_id, issue.title].some((value) => {
    const marker = text(value)?.toLowerCase().replace(/[\s-]+/g, '_');
    return marker === 'restart_required' || marker?.startsWith('restart_required_');
  });
}

function restartRepairTitle(issue: HomeAssistantRepairIssue): string | null {
  if (!isHomeAssistantRestartRepair(issue)) return null;

  const affectedName = text(issue.translation_placeholders?.name)
    ?? (text(issue.issue_domain) ? humanizeIdentifier(String(issue.issue_domain)) : null);
  if (!affectedName) return null;

  return text(issue.translation_key)?.toLowerCase() === 'restart_required_uninstall'
    ? `Restart to finish uninstalling ${affectedName}`
    : `Restart to finish installing or updating ${affectedName}`;
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
    const repairName = text(issue.translation_key) ?? issueId;
    const title = restartRepairTitle(issue)
      ?? text(issue.title)
      ?? `${humanizeIdentifier(domain)}: ${humanizeIdentifier(repairName)}`;
    const affectedDomain = text(issue.issue_domain);
    const affectedName = text(issue.translation_placeholders?.name);
    return [{
      id: `repair:${safeId(domain)}:${safeId(issueId)}`,
      sourceId: `${domain}:${issueId}`,
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      title,
      body: text(issue.description) ?? undefined,
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
        requiresRestart: isHomeAssistantRestartRepair(issue),
        affectedDomain,
        affectedName,
        breaksInHomeAssistantVersion: text(issue.breaks_in_ha_version),
        learnMoreUrl: text(issue.learn_more_url),
        translationKey: text(issue.translation_key),
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
