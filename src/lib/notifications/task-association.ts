import type { NotificationItem } from '@/types';

export type NotificationTaskAvailability = 'available' | 'unavailable';

const TASK_MUTATION_ACTIONS = new Set([
  'complete_task',
  'dismiss_reminder',
  'remind_later',
]);

type TaskAssociationNotification = Pick<
  NotificationItem,
  'navigationTarget' | 'relatedTaskId' | 'relatedTaskAvailability'
>;

interface TaskAssociationAction {
  actionType: string;
  payload: unknown;
}

function targetReferencesTask(target: string, taskId: string): boolean {
  try {
    const url = new URL(target, 'http://mission-control.local');
    if (
      url.searchParams.get('taskId') === taskId
      || url.searchParams.get('selected') === taskId
    ) return true;
    return url.pathname.split('/').some((segment, index, segments) => (
      segments[index - 1] === 'tasks' && decodeURIComponent(segment) === taskId
    ));
  } catch {
    return false;
  }
}

export function isTaskDependentNotificationAction(
  notification: TaskAssociationNotification,
  action: TaskAssociationAction,
): boolean {
  if (TASK_MUTATION_ACTIONS.has(action.actionType)) return true;
  const taskId = notification.relatedTaskId;
  if (action.actionType !== 'navigate' || !taskId) return false;

  const payload = action.payload !== null
    && typeof action.payload === 'object'
    && !Array.isArray(action.payload)
    ? action.payload as Record<string, unknown>
    : {};
  const payloadTarget = typeof payload.target === 'string'
    ? payload.target
    : null;
  const target = payloadTarget || notification.navigationTarget;
  return !target || targetReferencesTask(target, taskId);
}

export function isUnavailableTaskAction(
  notification: TaskAssociationNotification,
  action: TaskAssociationAction,
): boolean {
  return notification.relatedTaskAvailability === 'unavailable'
    && isTaskDependentNotificationAction(notification, action);
}
