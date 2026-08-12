import type { InboundNotification } from '@/types';
import { normalizeNotificationUrl } from './registry';
import type {
  NotificationActionDraft,
  NotificationRichContent,
  NotificationSourceProvider,
} from './types';

function metadataOf(notification: InboundNotification): Record<string, unknown> {
  return notification.metadata || {};
}

function buildLinkActions(metadata: Record<string, unknown>): NotificationActionDraft[] {
  const actions: NotificationActionDraft[] = [];
  const previewUrl = normalizeNotificationUrl(metadata.previewUrl);
  const docHubUrl = normalizeNotificationUrl(metadata.docHubUrl);

  if (previewUrl) {
    actions.push({
      actionType: 'open_url',
      label: typeof metadata.previewLabel === 'string' ? metadata.previewLabel : 'View in Paperless-ngx',
      icon: 'external-link',
      variant: 'primary',
      isPrimary: true,
      payload: { url: previewUrl },
      opensExternal: true,
      createdBy: 'connector',
    });
  }
  if (docHubUrl) {
    actions.push({
      actionType: 'open_url',
      label: 'Open in OWL',
      icon: 'external-link',
      variant: 'secondary',
      payload: { url: docHubUrl },
      opensExternal: true,
      createdBy: 'connector',
    });
  }

  return actions;
}

function buildLinks(metadata: Record<string, unknown>): NotificationRichContent['links'] {
  return buildLinkActions(metadata).map(action => ({
    label: action.label,
    url: String(action.payload?.url),
  }));
}

export const documentIntelligenceNotificationProvider: NotificationSourceProvider = {
  sourceType: 'document-intelligence',
  displayName: 'OWL',
  signatures: [
    {
      key: 'missing-statement',
      matches(notification) {
        return typeof metadataOf(notification).daysOverdue === 'number';
      },
      present(notification) {
        const metadata = metadataOf(notification);
        const daysOverdue = metadata.daysOverdue as number;

        return {
          title: notification.title,
          body: notification.body ?? null,
          category: notification.category,
          templateKey: 'missing_statement',
          metadata,
          presentation: {
            sourceName: 'OWL',
            providerSignature: 'missing-statement',
            richContent: {
              primaryText: typeof metadata.correspondent === 'string' ? metadata.correspondent : undefined,
              secondaryText: typeof metadata.expectedPeriod === 'string' ? metadata.expectedPeriod : undefined,
              progress: {
                value: Math.min(daysOverdue, 30),
                max: 30,
                label: `${daysOverdue} days overdue`,
                tone: daysOverdue > 14 ? 'danger' : 'warning',
              },
              footerText: typeof metadata.frequency === 'string' ? metadata.frequency : undefined,
              links: buildLinks(metadata),
            },
          },
          actions: buildLinkActions(metadata),
        };
      },
    },
    {
      key: 'unmatched-eob',
      matches(notification) {
        return typeof metadataOf(notification).patientResponsibility === 'number';
      },
      present(notification) {
        const metadata = metadataOf(notification);
        const responsibility = metadata.patientResponsibility as number;
        const amount = typeof metadata.amount === 'number' ? metadata.amount : null;

        return {
          title: notification.title,
          body: notification.body ?? null,
          category: notification.category,
          templateKey: 'unmatched_eob',
          metadata,
          presentation: {
            sourceName: 'OWL',
            providerSignature: 'unmatched-eob',
            richContent: {
              primaryText: typeof metadata.provider === 'string' ? metadata.provider : undefined,
              secondaryText: typeof metadata.dateOfService === 'string' ? metadata.dateOfService : undefined,
              stats: [
                ...(amount === null ? [] : [{ value: amount.toFixed(2), tone: 'neutral' as const }]),
                {
                  label: 'Patient',
                  value: `$${responsibility.toFixed(2)}`,
                  tone: responsibility > 100 ? 'danger' as const : 'warning' as const,
                },
              ],
              links: buildLinks(metadata),
            },
          },
          actions: buildLinkActions(metadata),
        };
      },
    },
  ],
};
