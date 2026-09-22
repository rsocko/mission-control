import type { NotificationLevel } from '@/types';

export type NotificationRecommendation = 'act_now' | 'schedule' | 'dismiss' | 'delegate';

export function normalizeSmartPriorityRankings(
  text: string,
  openTasks: Array<{
    id: string;
    title: string;
    priority: string;
    dueDate: string | null;
  }>,
  today: string,
) {
  try {
    const parsed = JSON.parse(text) as {
      rankings?: Array<{ index: number; score: number; reason: string }>;
    };
    return (parsed.rankings || []).map(ranking => ({
      taskId: openTasks[ranking.index - 1]?.id || '',
      title: openTasks[ranking.index - 1]?.title || '',
      score: ranking.score,
      reason: ranking.reason,
    })).filter(ranking => ranking.taskId);
  } catch {
    return openTasks.slice(0, 10).map(task => ({
      taskId: task.id,
      title: task.title,
      score: task.priority === 'critical' ? 95 : task.priority === 'high' ? 75 : task.priority === 'medium' ? 50 : 25,
      reason: `${task.priority} priority${task.dueDate && task.dueDate < today ? ', OVERDUE' : ''}`,
    }));
  }
}

export function mapNotificationLevelToRecommendation(
  level: string,
): NotificationRecommendation {
  switch (level as NotificationLevel) {
    case 'urgent':
      return 'act_now';
    case 'action_needed':
    case 'heads_up':
      return 'schedule';
    case 'fyi':
    case 'digest':
    default:
      return 'dismiss';
  }
}

export function normalizeNotificationClassifications(
  text: string,
  notifications: Array<{ id: string; title: string; level: string }>,
) {
  try {
    const parsed = JSON.parse(text) as {
      actions?: Array<{ index: number; recommendation: string; reason: string }>;
    };
    return (parsed.actions || []).map(action => ({
      notificationId: notifications[action.index - 1]?.id || '',
      title: notifications[action.index - 1]?.title || '',
      recommendation: mapNotificationLevelToRecommendation(action.recommendation),
      reason: action.reason,
    })).filter(action => action.notificationId);
  } catch {
    return notifications.map(notification => ({
      notificationId: notification.id,
      title: notification.title,
      recommendation: mapNotificationLevelToRecommendation(notification.level),
      reason: `${notification.level} level notification`,
    }));
  }
}

export function normalizeEnergyTagSuggestions(
  text: string,
  targetTasks: Array<{ id: string; title: string }>,
) {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      taskId: string;
      energyLevel: 'high' | 'medium' | 'low';
      confidence: number;
      reason: string;
    }>;
    return parsed
      .filter(suggestion => (
        suggestion.confidence >= 0.5
        && ['high', 'medium', 'low'].includes(suggestion.energyLevel)
      ))
      .map(suggestion => ({
        ...suggestion,
        title: targetTasks.find(task => task.id === suggestion.taskId)?.title || '',
      }));
  } catch {
    return [];
  }
}

export function normalizeMicroStatusSuggestions(
  text: string,
  openTasks: Array<{ id: string; title: string }>,
) {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      taskId: string;
      suggestedStatus: string;
      confidence: number;
      reason: string;
    }>;
    return parsed
      .filter(suggestion => suggestion.confidence >= 0.5)
      .map(suggestion => ({
        ...suggestion,
        title: openTasks.find(task => task.id === suggestion.taskId)?.title || '',
      }));
  } catch {
    return [];
  }
}
