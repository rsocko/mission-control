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

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function actionTypeLabel(value: string): string {
  const normalized = value.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return normalized
    ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
    : value;
}

function taskMaterializations(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
        item !== null && typeof item === 'object' && !Array.isArray(item)
      )).slice(0, 16)
    : [];
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
      const terminal = ['dismissed', 'handled', 'completed'].includes(lifecycle);
      const linkedCount = typeof metadata.linkedTaskCount === 'number'
        ? metadata.linkedTaskCount
        : 0;
      const activeLinkedCount = typeof metadata.activeLinkedTaskCount === 'number'
        ? metadata.activeLinkedTaskCount
        : linkedCount;
      const linkedRelationIds = Array.isArray(metadata.linkedRelationIds)
        ? metadata.linkedRelationIds.filter((value): value is string => typeof value === 'string')
        : [];
      const sender = text(metadata.senderDisplayName);
      const conversation = text(metadata.conversationTitle);
      const excerpt = text(metadata.messageExcerpt);
      const details = text(metadata.details);
      const recommendation = text(metadata.recommendation);
      const reason = text(metadata.classificationReason);
      const actionType = text(metadata.actionType);
      const sourceUrl = text(metadata.sourceUrl);
      const materializations = taskMaterializations(metadata.taskMaterializations);
      const confidenceScore = typeof metadata.confidenceScore === 'number'
        && Number.isFinite(metadata.confidenceScore)
        ? Math.round(metadata.confidenceScore * 100)
        : null;
      const classificationMethod = text(metadata.derivationMethod);
      const classificationModel = text(metadata.classificationModel);
      const derivationVersion = text(metadata.derivationVersion);
      const subtitle = [sender, conversation].filter(Boolean).join(' · ')
        || (actionType ? actionTypeLabel(actionType) : null)
        || (linkedCount > 0
          ? `${linkedCount} linked task${linkedCount === 1 ? '' : 's'}`
          : 'Action Center');
      const primaryText = details && details !== notification.body
        ? details
        : excerpt && excerpt !== notification.body
          ? excerpt
          : undefined;
      const lifecycleTimestamp = text(metadata.handledAt)
        ?? text(metadata.dismissedAt)
        ?? text(metadata.snoozedUntil);
      const footerParts = [
        reason,
        classificationMethod
          ? `Classified by ${humanize(classificationMethod)}${
              classificationModel ? ` (${classificationModel}${
                derivationVersion ? ` ${derivationVersion}` : ''
              })` : ''
            }`
          : null,
        lifecycleTimestamp ? `${humanize(lifecycle)} ${lifecycleTimestamp}` : null,
      ].filter((value): value is string => Boolean(value));
      const stats = [
        actionType ? { label: 'Action', value: humanize(actionType), tone: 'info' as const } : null,
        confidenceScore !== null
          ? {
              label: 'Confidence',
              value: `${confidenceScore}%`,
              tone: confidenceScore >= 80
                ? 'success' as const
                : confidenceScore >= 50
                  ? 'warning' as const
                  : 'danger' as const,
            }
          : text(metadata.confidenceClass)
            ? {
                label: 'Confidence',
                value: humanize(String(metadata.confidenceClass)),
                tone: 'neutral' as const,
              }
            : null,
        {
          label: 'Lifecycle',
          value: humanize(lifecycle),
          tone: terminal ? 'neutral' as const : 'info' as const,
        },
        linkedCount > 0
          ? {
              label: 'Tasks',
              value: activeLinkedCount === linkedCount
                ? `${linkedCount} linked`
                : `${activeLinkedCount} active · ${linkedCount} total`,
              tone: activeLinkedCount > 0 ? 'success' as const : 'neutral' as const,
            }
          : null,
      ].filter((value): value is NonNullable<typeof value> => value !== null);
      const links = [
        ...(sourceUrl ? [{ label: 'Open conversation', url: sourceUrl }] : []),
        ...materializations.flatMap(task => {
          const url = text(task.openUrl);
          if (!url) return [];
          return [{
            label: `Open ${text(task.title) ?? text(task.providerLabel) ?? 'linked task'}`,
            url,
          }];
        }),
      ];
      return {
        title: notification.title,
        body: notification.body ?? null,
        level: notification.level,
        category: notification.category,
        templateKey: 'rymessage.companion-action',
        metadata,
        isActionable: !terminal,
        presentation: {
          sourceName: 'RyMessage Action Center',
          subjectIcon: 'message-circle',
          subtitle,
          metadataChips: [
            ...(actionType ? [{ label: 'Action', value: humanize(actionType) }] : []),
            ...(text(metadata.category)
              ? [{ label: 'Category', value: humanize(String(metadata.category)) }]
              : []),
            ...(text(metadata.direction)
              ? [{ label: 'Direction', value: humanize(String(metadata.direction)) }]
              : []),
            { label: 'State', value: humanize(lifecycle) },
          ],
          richContent: {
            primaryText,
            secondaryText: recommendation
              ? `Recommendation: ${humanize(recommendation)}`
              : undefined,
            stats,
            footerText: footerParts.join(' · ') || (
              lifecycle === 'link-broken' ? 'A linked task needs attention.' : undefined
            ),
            links,
          },
        },
        actions: terminal
          ? []
          : [{
              actionType: 'rymessage_promote',
              label: linkedCount > 0 ? 'Create another linked task' : 'Create linked task',
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
            }, {
              actionType: 'rymessage_dismiss',
              label: 'Dismiss',
              icon: 'x',
              variant: 'ghost',
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
    if (context.action.actionType === 'rymessage_dismiss') {
      return {
        state: 'dismissed',
        result: { type: 'rymessage_dismiss', queued: true },
      };
    }
    if (context.action.actionType !== 'rymessage_mark_handled') return null;
    return {
      state: 'resolved',
      result: { type: 'rymessage_mark_handled', queued: true },
    };
  },
};
