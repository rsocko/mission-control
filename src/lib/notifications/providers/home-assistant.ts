import type {
  NotificationActionDraft,
  NotificationSourceProvider,
} from './types';
import {
  getHomeAssistantBrandImagePath,
  getHomeAssistantMdiIcon,
} from '@/lib/connectors/home-assistant/notification-icons';
import { normalizeNotificationUrl } from './registry';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function humanizeIdentifier(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

function openAction(url: string | undefined): NotificationActionDraft[] {
  return url ? [{
    actionType: 'open_url',
    label: 'Open in Home Assistant',
    icon: 'external-link',
    variant: 'secondary',
    payload: { url },
    opensExternal: true,
    createdBy: 'connector',
  }] : [];
}

function sourceUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export function resolveHomeAssistantOpenUrl(
  metadata: Record<string, unknown>,
  storedUrl?: string,
): string | undefined {
  const baseUrl = text(metadata.baseUrl);
  if (!baseUrl) return storedUrl;

  switch (text(metadata.haSource)) {
    case 'updates':
      return sourceUrl(baseUrl, '/config/updates');
    case 'repairs':
      return sourceUrl(baseUrl, '/config/repairs');
    case 'entity_alerts': {
      const entityId = text(metadata.entityId);
      const domain = entityId?.split('.', 1)[0];
      return domain
        ? sourceUrl(baseUrl, `/config/entities?domain=${encodeURIComponent(domain)}`)
        : sourceUrl(baseUrl, '/config/entities');
    }
    case 'persistent_notifications':
      return baseUrl;
    default:
      return storedUrl ?? baseUrl;
  }
}

export const homeAssistantNotificationProvider: NotificationSourceProvider = {
  sourceType: 'home-assistant',
  displayName: 'Home Assistant',
  signatures: [{
    key: 'home-assistant-v2',
    matches(notification) {
      return record(notification.metadata).schemaVersion === 2;
    },
    present(notification) {
      const metadata = record(notification.metadata);
      const source = text(metadata.haSource);
      const actionUrl = resolveHomeAssistantOpenUrl(
        metadata,
        text(notification.actionUrl),
      );
      const actions: NotificationActionDraft[] = [];

      if (
        source === 'updates'
        && metadata.actionsEnabled === true
        && metadata.inProgress !== true
      ) {
        if (metadata.supportsInstall === true) {
          actions.push({
            actionType: 'install_update',
            label: 'Install',
            icon: 'download',
            variant: 'primary',
            isPrimary: true,
            requiresConfirmation: true,
            createdBy: 'connector',
          });
        }
        if (metadata.canSkip === true && metadata.supportsInstall === true) {
          actions.push({
            actionType: 'skip_update',
            label: 'Skip',
            icon: 'skip-forward',
            variant: 'secondary',
            requiresConfirmation: true,
            createdBy: 'connector',
          });
        }
      } else if (source === 'persistent_notifications' && metadata.actionsEnabled === true) {
        actions.push({
          actionType: 'dismiss_persistent_notification',
          label: 'Dismiss at source',
          icon: 'x',
          variant: 'secondary',
          requiresConfirmation: true,
          createdBy: 'connector',
        });
      } else if (source === 'repairs') {
        if (metadata.actionsEnabled === true && metadata.requiresRestart === true) {
          actions.push({
            actionType: 'restart_home_assistant',
            label: 'Restart Home Assistant',
            icon: 'refresh-cw',
            variant: 'primary',
            isPrimary: true,
            requiresConfirmation: true,
            createdBy: 'connector',
          });
        }
        actions.push(...openAction(actionUrl));
        if (metadata.actionsEnabled === true) {
          actions.push({
            actionType: 'ignore_repair',
            label: 'Ignore repair',
            icon: 'eye-off',
            variant: 'secondary',
            requiresConfirmation: true,
            createdBy: 'connector',
          });
        }
      }
      if (source !== 'repairs') {
        actions.push(...openAction(actionUrl));
      }
      actions.push({
        actionType: 'create_task',
        label: 'Create task',
        icon: 'check-square',
        variant: 'ghost',
        createdBy: 'connector',
      });

      const installedVersion = text(metadata.installedVersion);
      const latestVersion = text(metadata.latestVersion);
      const releaseUrl = normalizeNotificationUrl(metadata.releaseUrl);
      const progress = typeof metadata.updatePercentage === 'number'
        ? Math.max(0, Math.min(100, metadata.updatePercentage))
        : undefined;
      const subjectIconUrl = getHomeAssistantBrandImagePath(metadata)
        ? `/api/notifications/${encodeURIComponent(notification.id)}/subject-icon`
        : undefined;
      const subjectIcon = getHomeAssistantMdiIcon(metadata) ?? undefined;
      const attributes = record(metadata.attributes);
      const metadataChips: Array<{ label: string; value: string }> = [];
      if (source === 'entity_alerts') {
        for (const [label, value] of [
          ['Entity', text(metadata.entityId)],
          ['HA state', text(metadata.state)],
          ['Device class', text(attributes.device_class)],
          ['Rule', text(metadata.ruleId)],
        ] as const) {
          if (value) metadataChips.push({ label, value });
        }
      } else if (source === 'repairs') {
        const affectedDomain = text(metadata.affectedDomain);
        const repairDomain = text(metadata.domain);
        if (affectedDomain) {
          metadataChips.push({ label: 'Affected integration', value: affectedDomain });
        }
        if (repairDomain && affectedDomain && repairDomain !== affectedDomain) {
          metadataChips.push({
            label: 'Requested by',
            value: humanizeIdentifier(repairDomain),
          });
        }
        const breaksInVersion = text(metadata.breaksInHomeAssistantVersion);
        if (breaksInVersion) {
          metadataChips.push({
            label: 'Breaks in Home Assistant',
            value: breaksInVersion,
          });
        }
      }
      const learnMoreUrl = source === 'repairs'
        ? normalizeNotificationUrl(metadata.learnMoreUrl)
        : undefined;

      return {
        presentation: {
          sourceName: text(metadata.instanceName) || 'Home Assistant',
          subjectIconUrl,
          subjectIcon,
          subtitle: source === 'updates'
            ? notification.templateKey === 'ha_update_critical'
              ? 'Critical software update'
              : text(metadata.updateType) === 'app'
                ? 'App update'
                : 'Software update'
            : source === 'repairs'
              ? 'Repair issue'
              : source === 'persistent_notifications'
                ? 'Persistent notification'
                : 'Device alert',
          providerSignature: 'home-assistant-v2',
          ...(metadataChips.length ? { metadataChips } : {}),
          richContent: {
            ...(installedVersion || latestVersion ? {
              stats: [
                ...(installedVersion ? [{ label: 'Installed', value: installedVersion }] : []),
                ...(latestVersion ? [{ label: 'Available', value: latestVersion, tone: 'info' as const }] : []),
              ],
            } : {}),
            ...(progress !== undefined ? {
              progress: {
                value: progress,
                max: 100,
                label: `${progress}% installed`,
                tone: 'info' as const,
              },
            } : {}),
            ...(releaseUrl ? {
              links: [{
                label: 'Read release announcement',
                url: releaseUrl,
              }],
            } : {}),
            ...(learnMoreUrl ? {
              links: [{
                label: 'Learn more',
                url: learnMoreUrl,
              }],
            } : {}),
            footerText: notification.templateKey === 'ha_update_critical'
              ? 'Action Needed because this update matches a configured critical update pattern.'
              : text(metadata.instanceName),
          },
        },
        metadata,
        isActionable: actions.length > 0,
        actions,
      };
    },
  }],
};
