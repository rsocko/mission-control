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

function formatIdentifier(value: string): string {
  return value
    .split(/[-_]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
