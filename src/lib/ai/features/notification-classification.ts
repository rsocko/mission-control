import { generateText } from 'ai';
import { getAIModel, getAIRouteOutcome } from '../provider-factory';
import type { AIRouteOutcome } from '../types';
import { listNotificationsForClassification } from './notification-queries';
import {
  normalizeNotificationClassifications,
  type NotificationRecommendation,
} from './normalization';

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
  if (unread.length === 0) return { actions: [] };

  const route = getAIModel('notification-triage', {
    sources: unread.map(notification => notification.connectorType),
  });
  const notificationList = unread.map((notification, index) => (
    `${index + 1}. [${notification.level}] "${notification.title}" | category: ${notification.category} | actionable: ${notification.isActionable} | from: ${notification.connectorType} | received: ${notification.receivedAt}`
  )).join('\n');
  const result = await generateText({
    model: route.model,
    system: 'You triage notifications for a busy professional. For each notification, recommend one of: urgent, action_needed, heads_up, or fyi. Use urgent for immediate attention, action_needed for things that should be handled soon, heads_up for items worth scheduling, and fyi for low-value informational items. Respond ONLY in JSON: {"actions": [{"index": 1, "recommendation": "urgent", "reason": "security alert needs immediate review"}]}',
    messages: [{ role: 'user', content: `Triage these notifications:\n\n${notificationList}` }],
  });

  return {
    actions: normalizeNotificationClassifications(result.text, unread),
    routing: getAIRouteOutcome(route.context, result.response),
  };
}

/** @deprecated Use classifyNotifications. */
export const triageNotifications = classifyNotifications;

/** @deprecated Use classifyNotifications. */
export const triageAlerts = classifyNotifications;
