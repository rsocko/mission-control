import type { InboundNotification } from '@/types';
import { normalizeNotificationUrl } from './registry';
import type {
  NotificationPresentationStat,
  NotificationSourceProvider,
} from './types';

const linkLabels = {
  dashboard: 'Open dashboard',
  logs: 'View logs',
  uptime: 'Open uptime',
  runbook: 'Open runbook',
} as const;

function metadataOf(notification: InboundNotification): Record<string, unknown> {
  return notification.metadata
    && typeof notification.metadata === 'object'
    && !Array.isArray(notification.metadata)
    ? notification.metadata
    : {};
}

function stringValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function statsOf(metadata: Record<string, unknown>): NotificationPresentationStat[] {
  const context: NotificationPresentationStat[] = [];
  const environment = stringValue(metadata, 'environment');
  const owner = stringValue(metadata, 'owner');
  if (environment) context.push({ label: 'Environment', value: environment });
  if (owner) context.push({ label: 'Owner', value: owner });
  const metrics = Array.isArray(metadata.metrics)
    ? metadata.metrics.flatMap((metric): NotificationPresentationStat[] => {
        if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return [];
        const item = metric as Record<string, unknown>;
        if (typeof item.label !== 'string' || typeof item.value !== 'string') return [];
        const tone = ['neutral', 'info', 'warning', 'danger', 'success'].includes(
          String(item.tone),
        )
          ? item.tone as NotificationPresentationStat['tone']
          : undefined;
        return [{
          label: item.label.slice(0, 64),
          value: item.value.slice(0, 128),
          ...(tone ? { tone } : {}),
        }];
      })
    : [];
  return [...context, ...metrics].slice(0, 4);
}

function linksOf(metadata: Record<string, unknown>) {
  if (!Array.isArray(metadata.links)) return [];
  return metadata.links.flatMap((link) => {
    if (!link || typeof link !== 'object' || Array.isArray(link)) return [];
    const item = link as Record<string, unknown>;
    if (
      !['dashboard', 'logs', 'uptime', 'runbook'].includes(String(item.kind))
    ) {
      return [];
    }
    const url = normalizeNotificationUrl(item.url);
    if (!url) return [];
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash) return [];
    const kind = item.kind as keyof typeof linkLabels;
    return [{ kind, label: linkLabels[kind], url }];
  }).slice(0, 4);
}

export const homelabNotificationProvider: NotificationSourceProvider = {
  sourceType: 'homelab',
  displayName: 'Homelab',
  signatures: [{
    key: 'homelab-incident',
    matches(notification) {
      const metadata = metadataOf(notification);
      return metadata.schemaVersion === 1
        && typeof metadata.fingerprint === 'string'
        && (metadata.status === 'firing' || metadata.status === 'resolved');
    },
    present(notification) {
      const metadata = metadataOf(notification);
      const status = metadata.status === 'resolved' ? 'resolved' : 'firing';
      const context = stringValue(metadata, 'node')
        || stringValue(metadata, 'site')
        || stringValue(metadata, 'service')
        || 'Homelab';
      const links = linksOf(metadata);
      return {
        title: notification.title,
        body: notification.body ?? null,
        category: notification.category,
        templateKey: stringValue(metadata, 'type'),
        metadata,
        presentation: {
          sourceName: 'Homelab',
          subtitle: `${context} - ${status}`,
          providerSignature: 'homelab-incident',
          richContent: {
            stats: statsOf(metadata),
            links: links.map(link => ({ label: link.label, url: link.url })),
          },
        },
        isActionable: status === 'firing' && links.length > 0,
        actions: status === 'firing'
          ? links.map((link, index) => ({
              actionType: 'open_url',
              label: link.label,
              icon: 'external-link',
              variant: index === 0 ? 'primary' : 'secondary',
              isPrimary: index === 0,
              payload: { url: link.url, kind: link.kind },
              opensExternal: true,
              createdBy: 'connector',
            }))
          : [],
      };
    },
  }],
};
