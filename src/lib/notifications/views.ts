import { parseNotificationQuery, serializeNotificationQuery, type NotificationQuery } from './query';

export interface NotificationView {
  id: string;
  name: string;
  query: NotificationQuery;
  builtIn: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

function builtIn(id: string, name: string, values: Record<string, string | boolean>): NotificationView {
  return {
    id,
    name,
    query: parseNotificationQuery(values),
    builtIn: true,
    createdAt: null,
    updatedAt: null,
  };
}

export const DEFAULT_GITHUB_NOTIFICATION_VIEWS: NotificationView[] = [
  builtIn('github-review-requests', 'Review requests', { source: 'github-issues', reason: 'review_requested' }),
  builtIn('github-mentions', 'Mentions', { source: 'github-issues', reason: 'mention' }),
  builtIn('github-assignments', 'Assignments', { source: 'github-issues', reason: 'assign' }),
  builtIn('github-ci-activity', 'CI activity', { source: 'github-issues', reason: 'ci_activity' }),
  builtIn('github-security', 'Security', { source: 'github-issues', reason: 'security_alert' }),
  builtIn('github-participating', 'Participating', { source: 'github-issues', participating: true }),
  builtIn('github-all', 'All GitHub', { source: 'github-issues' }),
];

export const DEFAULT_HOMELAB_NOTIFICATION_VIEWS: NotificationView[] = [
  builtIn('homelab-all', 'Homelab', { source: 'homelab' }),
];

export const BUILT_IN_NOTIFICATION_VIEWS: NotificationView[] = [
  ...DEFAULT_GITHUB_NOTIFICATION_VIEWS,
  ...DEFAULT_HOMELAB_NOTIFICATION_VIEWS,
];

export function notificationViewHref(view: NotificationView): string {
  const params = serializeNotificationQuery(view.query);
  params.set('view', view.id);
  return `/notifications?${params.toString()}`;
}
