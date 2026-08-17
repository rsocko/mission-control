export const NAV_BADGE_KEYS = [
  'myDay',
  'notifications',
  'triage',
  'quickSort',
  'reconciliation',
] as const;

export type NavBadgeKey = (typeof NAV_BADGE_KEYS)[number];
export type NavBadgeTone = 'red' | 'amber' | 'blue';
export const NAVIGATION_COUNTS_REFRESH_EVENT = 'mission-control:navigation-counts-refresh';

export function notifyNavigationCountsChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
  }
}

export const NAV_BADGE_OPTIONS: Array<{
  key: NavBadgeKey;
  label: string;
  description: string;
}> = [
  { key: 'myDay', label: 'My Day', description: 'Incomplete tasks assigned to today' },
  { key: 'notifications', label: 'Notifications', description: 'Notifications that need attention' },
  { key: 'triage', label: 'Triage', description: 'Pending triage items' },
  { key: 'quickSort', label: 'Quick Sort', description: 'Open tasks without a priority' },
  { key: 'reconciliation', label: 'Reconciliation', description: 'Pending reconciliation suggestions' },
];

export interface NavigationCounts {
  myDay: number;
  notifications: number;
  triage: number;
  quickSort: number;
  reconciliation: number;
  overdue: number;
  unreadNotifications: number;
  notificationTone: NavBadgeTone;
}

export const EMPTY_NAVIGATION_COUNTS: NavigationCounts = {
  myDay: 0,
  notifications: 0,
  triage: 0,
  quickSort: 0,
  reconciliation: 0,
  overdue: 0,
  unreadNotifications: 0,
  notificationTone: 'blue',
};

export function getNotificationBadgeTone(urgent: number, actionNeeded: number): NavBadgeTone {
  if (urgent > 0) return 'red';
  if (actionNeeded > 0) return 'amber';
  return 'blue';
}

export function getNotificationBadgeState({
  attention,
  urgent,
  actionNeeded,
  headsUp,
  fyi,
}: {
  attention: number;
  urgent: number;
  actionNeeded: number;
  headsUp: number;
  fyi: number;
}): { count: number; tone: NavBadgeTone } {
  if (urgent > 0) return { count: urgent, tone: 'red' };
  if (actionNeeded > 0) return { count: actionNeeded, tone: 'amber' };
  if (headsUp > 0) return { count: headsUp, tone: 'blue' };
  if (fyi > 0) return { count: fyi, tone: 'blue' };
  return { count: attention, tone: 'blue' };
}
