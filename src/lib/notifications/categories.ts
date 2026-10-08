import type { NotificationCategory } from '@/types';
import { NOTIFICATION_SOURCE_LABELS } from '@/types/dashboard';

const CATEGORY_LABELS = {
  system: 'System',
  tasks: 'Tasks',
  development: 'Development',
  finance: 'Finance',
  home: 'Home',
  social: 'Social',
  ai_insights: 'AI Insights',
  packages: 'Packages',
  infrastructure: 'Infrastructure',
  backup: 'Backup',
  automation: 'Automation',
  security: 'Security',
} satisfies Record<NotificationCategory, string>;

export function formatNotificationCategoryLabel(category: string): string {
  if (Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category)) {
    return CATEGORY_LABELS[category as NotificationCategory];
  }

  return formatIdentifier(category);
}

export function formatNotificationSourceLabel(source: string): string {
  return NOTIFICATION_SOURCE_LABELS[source] ?? formatIdentifier(source);
}

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  'rymessage.companion-action': 'Action Center',
  home_assistant_entity_alert: 'Device alert',
  ha_integration_retry: 'Integration setup retry',
  ha_integration_failed: 'Integration failure',
  ha_update_available: 'Update available',
  ha_update_critical: 'Critical update available',
  ha_persistent_notification: 'Persistent notification',
  ha_persistent_critical: 'Critical persistent notification',
  ha_repair_warning: 'Repair warning',
  ha_repair_error: 'Repair error',
  ha_repair_critical: 'Critical repair issue',
};

export function formatNotificationTypeLabel(notificationType: string): string {
  const configuredLabel = NOTIFICATION_TYPE_LABELS[notificationType];
  if (configuredLabel) return configuredLabel;
  if (notificationType.startsWith('rymessage.')) {
    return formatIdentifier(notificationType.slice('rymessage.'.length));
  }
  return formatIdentifier(notificationType);
}

function formatIdentifier(value: string): string {
  return value
    .split(/[-_]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
