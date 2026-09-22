import { listNotificationsForClassification } from './notification-queries';
import { classifyNotificationItems } from './notification-classifier';
import type { AIRouteOutcome } from '../types';
import type { NotificationRecommendation } from './normalization';

export {
  mapNotificationLevelToRecommendation,
  normalizeNotificationClassifications,
} from './normalization';

export async function classifyNotifications(): Promise<{
  actions: Array<{
    notificationId: string;
    title: string;
    recommendation: NotificationRecommendation;
    reason: string;
  }>;
  routing?: AIRouteOutcome;
}> {
  const unread = await listNotificationsForClassification();
  return classifyNotificationItems(unread);
}

/** @deprecated Use classifyNotifications. */
export const triageNotifications = classifyNotifications;

/** @deprecated Use classifyNotifications. */
export const triageAlerts = classifyNotifications;
