import 'server-only';

import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications/dispatcher-wake';
import {
  homelabAlertLifecycleEventV1Schema,
  type HomelabAlertLifecycleEventV1,
} from './contracts';

interface AlertmanagerProjectionAction {
  id: string;
  actionType: 'open_url';
  label: string;
  icon: string;
  variant: 'primary' | 'secondary';
  isPrimary: boolean;
  sortOrder: number;
  payload: { url: string; kind: string };
  opensExternal: true;
  createdBy: 'connector';
}

interface AlertmanagerLifecycleWrite {
  source: string;
  eventId: string;
  fingerprint: string;
  status: 'firing' | 'resolved';
  occurredAt: string;
  projection: {
    newNotificationId: string;
    sourceId: string;
    title: string;
    body: string | null;
    level: string;
    category: string;
    templateKey: string;
    readState: 'unread' | 'read';
    sourceState: 'active' | 'resolved';
    sourceActivityAt: string;
    sourceActivityKey: string;
    receivedAt: string;
    sortAt: string;
    dedupeKey: string;
    metadata: Record<string, unknown>;
    presentation: Record<string, unknown>;
    isActionable: boolean;
    occurrenceKey: string;
    actions: readonly AlertmanagerProjectionAction[];
  };
}

interface AlertmanagerRepository {
  ingestBatch(input: {
    integration: string;
    receivedAt: string;
    suppressDeliveries: boolean;
    events: readonly AlertmanagerLifecycleWrite[];
  }): Promise<IngestHomelabAlertResult & { pendingDelivery: boolean }>;
}

const linkLabels = {
  dashboard: 'Open dashboard',
  logs: 'View logs',
  uptime: 'Open uptime',
  runbook: 'Open runbook',
} as const;

export interface IngestHomelabAlertOptions {
  integration: string;
  receivedAt?: Date;
  wakeDispatcher?: boolean;
  suppressDeliveries?: boolean;
}

export interface IngestHomelabAlertResult {
  accepted: number;
  applied: number;
  stale: number;
  created: number;
  updated: number;
  duplicateReceipts: number;
}

function notificationIdentity(
  integration: string,
  event: HomelabAlertLifecycleEventV1,
): string {
  return `${integration}:${event.source}:${event.fingerprint}`;
}

function categoryFor(type: HomelabAlertLifecycleEventV1['type']): string {
  if (type === 'homelab_security_incident') return 'security';
  if (type === 'homelab_automation_failed') return 'automation';
  if (type === 'homelab_backup_failed' || type === 'homelab_backup_missed') return 'backup';
  return 'infrastructure';
}

function levelFor(event: HomelabAlertLifecycleEventV1) {
  if (event.status === 'resolved') return 'fyi';
  if (event.severity === 'critical') return 'urgent';
  if (event.severity === 'warning') {
    return event.actionRequired ? 'action_needed' : 'heads_up';
  }
  return 'fyi';
}

function createPresentation(event: HomelabAlertLifecycleEventV1) {
  const context = event.node || event.site || event.service || 'Homelab';
  const contextStats = [
    event.environment ? { label: 'Environment', value: event.environment } : null,
    event.owner ? { label: 'Owner', value: event.owner } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  return {
    sourceName: 'Homelab',
    subtitle: `${context} - ${event.status}`,
    richContent: {
      stats: [
        ...contextStats,
        ...(event.metrics ?? []).map(metric => ({
          label: metric.label,
          value: metric.value,
          tone: metric.tone,
        })),
      ].slice(0, 4),
      links: (event.links ?? []).map(link => ({
        label: linkLabels[link.kind],
        url: link.url,
      })),
    },
  };
}

function projectionActions(
  event: HomelabAlertLifecycleEventV1,
): AlertmanagerProjectionAction[] {
  return (event.links ?? []).map((link, index) => ({
    id: crypto.randomUUID(),
    actionType: 'open_url',
    label: linkLabels[link.kind],
    icon: 'external-link',
    variant: index === 0 ? 'primary' : 'secondary',
    isPrimary: index === 0,
    sortOrder: index,
    payload: { url: link.url, kind: link.kind },
    opensExternal: true,
    createdBy: 'connector',
  }));
}

function lifecycleWrite(
  integration: string,
  event: HomelabAlertLifecycleEventV1,
  receivedAt: string,
): AlertmanagerLifecycleWrite {
  const sourceId = notificationIdentity(integration, event);
  const actions = projectionActions(event);
  return {
    source: event.source,
    eventId: event.eventId,
    fingerprint: event.fingerprint,
    status: event.status,
    occurredAt: event.occurredAt,
    projection: {
      newNotificationId: crypto.randomUUID(),
      sourceId,
      title: event.service ? `${event.service}: ${event.summary}` : event.summary,
      body: event.description ?? null,
      level: levelFor(event),
      category: event.category ?? categoryFor(event.type),
      templateKey: event.type,
      readState: event.status === 'firing' ? 'unread' : 'read',
      sourceState: event.status === 'firing' ? 'active' : 'resolved',
      sourceActivityAt: event.occurredAt,
      sourceActivityKey: `${event.status}:${event.eventId}`,
      receivedAt,
      sortAt: event.occurredAt,
      dedupeKey: sourceId,
      metadata: {
        schemaVersion: event.schemaVersion,
        eventId: event.eventId,
        source: event.source,
        fingerprint: event.fingerprint,
        status: event.status,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        severity: event.severity,
        type: event.type,
        category: event.category ?? categoryFor(event.type),
        service: event.service,
        node: event.node,
        site: event.site,
        environment: event.environment,
        owner: event.owner,
        actionRequired: event.actionRequired,
        metrics: event.metrics ?? [],
        links: event.links ?? [],
        runbookKey: event.runbookKey,
      },
      presentation: createPresentation(event),
      isActionable: event.status === 'firing' && actions.length > 0,
      occurrenceKey: event.eventId,
      actions,
    },
  };
}

export async function ingestHomelabAlertEvents(
  rawEvents: readonly HomelabAlertLifecycleEventV1[],
  options: IngestHomelabAlertOptions,
  repository?: AlertmanagerRepository,
): Promise<IngestHomelabAlertResult> {
  const integration = options.integration.trim();
  if (!integration || integration.length > 100) {
    throw new Error('integration must contain between 1 and 100 characters');
  }
  const events = homelabAlertLifecycleEventV1Schema.array()
    .min(1)
    .max(100)
    .parse(rawEvents);
  const receivedAt = (options.receivedAt ?? new Date()).toISOString();
  const persistence = repository
    ?? (await getWorkerPersistenceRepositories()).webhookIntegrations.alertmanager;
  if (!persistence) {
    throw new Error('Alertmanager persistence is not available in the selected backend');
  }
  const { pendingDelivery, ...result } = await persistence.ingestBatch({
    integration,
    receivedAt,
    suppressDeliveries: options.suppressDeliveries ?? false,
    events: events.map(event => lifecycleWrite(integration, event, receivedAt)),
  });

  if (options.wakeDispatcher !== false && pendingDelivery) {
    wakeNotificationDeliveryDispatcher();
  }
  return result;
}
