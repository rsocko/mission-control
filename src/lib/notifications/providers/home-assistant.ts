import type {
  NotificationActionDraft,
  NotificationSourceProvider,
} from './types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
      const baseUrl = text(metadata.baseUrl);
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
      } else if (source === 'repairs' && metadata.actionsEnabled === true) {
        actions.push({
          actionType: 'ignore_repair',
          label: 'Ignore repair',
          icon: 'eye-off',
          variant: 'secondary',
          requiresConfirmation: true,
          createdBy: 'connector',
        });
      }
      actions.push(...openAction(baseUrl));
      actions.push({
        actionType: 'create_task',
        label: 'Create task',
        icon: 'check-square',
        variant: 'ghost',
        createdBy: 'connector',
      });

      const installedVersion = text(metadata.installedVersion);
      const latestVersion = text(metadata.latestVersion);
      const progress = typeof metadata.progress === 'number'
        ? Math.max(0, Math.min(100, metadata.progress))
        : undefined;

      return {
        presentation: {
          sourceName: text(metadata.instanceName) || 'Home Assistant',
          subtitle: source === 'updates'
            ? 'Software update'
            : source === 'repairs'
              ? 'Repair issue'
              : source === 'persistent_notifications'
                ? 'Persistent notification'
                : 'Device alert',
          providerSignature: 'home-assistant-v2',
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
            footerText: text(metadata.instanceName),
          },
        },
        metadata,
        isActionable: actions.length > 0,
        actions,
      };
    },
  }],
};
