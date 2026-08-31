export type NotificationDeliveryChannel = 'web_push' | 'apns';

export interface MissionControlPushPayload {
  notificationId: string;
  title: string;
  body?: string;
  tag: string;
  url: string;
  kind?: 'task_reminder';
}

const INTERNAL_ORIGIN = 'https://mission-control.invalid';

export function normalizeInternalNavigationTarget(
  target: string | null | undefined,
): string | null {
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
