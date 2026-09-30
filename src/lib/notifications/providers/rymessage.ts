import type { InboundNotification } from '@/types';
import type {
  NotificationProviderActionResult,
  NotificationSourceProvider,
} from './types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function matchesRyMessageAction(notification: InboundNotification): boolean {
  const contract = record(notification.metadata).contract;
  return notification.connectorType === 'rymessage'
    && (contract === 'companion-action-v1' || contract === 'companion-action-v2');
}

export const rymessageNotificationProvider: NotificationSourceProvider = {
  sourceType: 'rymessage',
  displayName: 'RyMessage',
  signatures: [{
    key: 'companion-action-v1',
    matches: matchesRyMessageAction,
    present(notification) {
      const metadata = record(notification.metadata);
      const lifecycle = typeof metadata.lifecycle === 'string'
        ? metadata.lifecycle
        : 'visible';
      const linkedCount = typeof metadata.linkedTaskCount === 'number'
        ? metadata.linkedTaskCount
        : 0;
      const linkedRelationIds = Array.isArray(metadata.linkedRelationIds)
        ? metadata.linkedRelationIds.filter((value): value is string => typeof value === 'string')
        : [];
      return {
        title: notification.title,
        body: notification.body ?? null,
        level: notification.level,
        category: notification.category,
        templateKey: 'rymessage.companion-action',
        metadata,
        isActionable: lifecycle !== 'completed',
        presentation: {
          sourceName: 'RyMessage Action Center',
          subjectIcon: 'message-circle',
          subtitle: linkedCount > 0
            ? `${linkedCount} linked task${linkedCount === 1 ? '' : 's'}`
            : 'Companion action',
          richContent: {
            footerText: lifecycle === 'link-broken'
              ? 'A linked task needs attention.'
              : undefined,
          },
        },
        actions: lifecycle === 'completed'
          ? []
          : [{
              actionType: 'rymessage_promote',
              label: linkedCount > 0 ? 'Create another task' : 'Create task',
              icon: 'plus',
              variant: 'primary',
              isPrimary: true,
              payload: {
                actionId: metadata.actionId,
                connectorId: notification.connectorInstanceId,
                taskTitle: notification.title,
                taskBody: notification.body,
                priority: metadata.priority,
              },
              createdBy: 'connector',
            }, ...linkedRelationIds.map((relationId, index) => ({
              actionType: 'rymessage_unlink',
              label: linkedRelationIds.length === 1 ? 'Unlink task' : `Unlink task ${index + 1}`,
              icon: 'unlink',
              variant: 'secondary' as const,
              isPrimary: false,
              payload: {
                actionId: metadata.actionId,
                connectorId: notification.connectorInstanceId,
                revision: metadata.revision,
                relationId,
              },
              createdBy: 'connector' as const,
            })), {
              actionType: 'rymessage_mark_handled',
              label: 'Mark handled',
              icon: 'check',
              variant: 'secondary',
              isPrimary: false,
              payload: {
                actionId: metadata.actionId,
                connectorId: notification.connectorInstanceId,
                revision: metadata.revision,
                lifecycleRevision: metadata.lifecycleRevision,
              },
              createdBy: 'connector',
            }],
      };
    },
  }],
  async executeAction(context): Promise<NotificationProviderActionResult | null> {
    if (context.action.actionType === 'rymessage_promote') {
      return {
        result: {
          type: 'rymessage_promote',
          taskData: {
            title: context.payload.taskTitle || context.notification.title,
            body: context.payload.taskBody || context.notification.body,
            priority: context.payload.priority || 'none',
            actionId: context.payload.actionId,
            connectorId: context.payload.connectorId,
            sourceNotificationId: context.notification.id,
          },
        },
      };
    }
    if (context.action.actionType === 'rymessage_unlink') {
      return {
        result: { type: 'rymessage_unlink', queued: true },
      };
    }
    if (context.action.actionType !== 'rymessage_mark_handled') return null;
    return {
      state: 'resolved',
      result: { type: 'rymessage_mark_handled', queued: true },
    };
  },
};
