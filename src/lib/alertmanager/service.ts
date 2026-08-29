import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runTransaction } from '@/db';
import * as schema from '@/db/schema';
import {
  homelabAlertReceipts,
  notificationActions,
  notifications,
} from '@/db/schema';
import {
  createNotificationsInTransaction,
  wakeNotificationDeliveryDispatcher,
} from '@/lib/notifications';
import {
  homelabAlertLifecycleEventV1Schema,
  type HomelabAlertLifecycleEventV1,
} from './contracts';

type AlertDatabase = BetterSQLite3Database<typeof schema>;

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

function eventPrecedesProjection(
  event: HomelabAlertLifecycleEventV1,
  current: typeof notifications.$inferSelect | undefined,
): boolean {
  if (!current?.lastSourceActivityAt) return false;
  const incomingTime = Date.parse(event.occurredAt);
  const currentTime = Date.parse(current.lastSourceActivityAt);
  if (incomingTime < currentTime) return true;
  return incomingTime === currentTime
    && current.sourceState === 'resolved'
    && event.status === 'firing';
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

function replaceExternalActions(
  database: AlertDatabase,
  notificationId: string,
  event: HomelabAlertLifecycleEventV1,
): void {
  database.delete(notificationActions).where(and(
    eq(notificationActions.notificationId, notificationId),
    eq(notificationActions.createdBy, 'connector'),
    eq(notificationActions.actionType, 'open_url'),
  )).run();

  const actions = (event.links ?? []).map((link, index) => ({
    id: crypto.randomUUID(),
    notificationId,
    actionType: 'open_url',
    label: linkLabels[link.kind],
    icon: 'external-link',
    variant: index === 0 ? 'primary' : 'secondary',
    isPrimary: index === 0,
    sortOrder: index,
    payload: { url: link.url, kind: link.kind },
    opensExternal: true,
    requiresConfirmation: false,
    createdBy: 'connector',
  }));
  if (actions.length > 0) database.insert(notificationActions).values(actions).run();
  database.update(notifications).set({
    primaryActionId: actions[0]?.id ?? null,
    isActionable: event.status === 'firing' && actions.length > 0,
  }).where(eq(notifications.id, notificationId)).run();
}

function persistReceipt(
  database: AlertDatabase,
  integration: string,
  event: HomelabAlertLifecycleEventV1,
  notificationId: string,
  receivedAt: string,
  applied: boolean,
): boolean {
  const existing = database.select({ id: homelabAlertReceipts.id })
    .from(homelabAlertReceipts)
    .where(and(
      eq(homelabAlertReceipts.integration, integration),
      eq(homelabAlertReceipts.source, event.source),
      eq(homelabAlertReceipts.eventId, event.eventId),
    ))
    .get();
  if (existing) {
    database.update(homelabAlertReceipts).set({
      lastReceivedAt: receivedAt,
      deliveryCount: sql`${homelabAlertReceipts.deliveryCount} + 1`,
      applied,
    }).where(eq(homelabAlertReceipts.id, existing.id)).run();
    return true;
  }
  database.insert(homelabAlertReceipts).values({
    id: crypto.randomUUID(),
    integration,
    source: event.source,
    eventId: event.eventId,
    fingerprint: event.fingerprint,
    status: event.status,
    occurredAt: event.occurredAt,
    notificationId,
    firstReceivedAt: receivedAt,
    lastReceivedAt: receivedAt,
    deliveryCount: 1,
    applied,
  }).run();
  return false;
}

export function ingestHomelabAlertEvents(
  rawEvents: readonly HomelabAlertLifecycleEventV1[],
  options: IngestHomelabAlertOptions,
): IngestHomelabAlertResult {
  const integration = options.integration.trim();
  if (!integration || integration.length > 100) {
    throw new Error('integration must contain between 1 and 100 characters');
  }
  const events = homelabAlertLifecycleEventV1Schema.array()
    .min(1)
    .max(100)
    .parse(rawEvents);
  const receivedAt = (options.receivedAt ?? new Date()).toISOString();
  let shouldWakeDispatcher = false;

  const result = runTransaction((transaction) => {
    const totals: IngestHomelabAlertResult = {
      accepted: events.length,
      applied: 0,
      stale: 0,
      created: 0,
      updated: 0,
      duplicateReceipts: 0,
    };

    for (const event of events) {
      const sourceId = notificationIdentity(integration, event);
      const current = transaction.select().from(notifications)
        .where(eq(notifications.sourceId, sourceId))
        .get();
      const stale = eventPrecedesProjection(event, current);
      const duplicate = persistReceipt(
        transaction,
        integration,
        event,
        current?.id ?? sourceId,
        receivedAt,
        !stale,
      );
      if (duplicate) totals.duplicateReceipts++;
      if (stale) {
        totals.stale++;
        continue;
      }

      const [creation] = createNotificationsInTransaction(transaction, [{
        id: current?.id,
        sourceId,
        connectorType: 'homelab',
        connectorInstanceId: integration,
        title: event.service ? `${event.service}: ${event.summary}` : event.summary,
        body: event.description ?? null,
        level: levelFor(event),
        category: event.category ?? categoryFor(event.type),
        templateKey: event.type,
        readState: event.status === 'firing' ? 'unread' : 'read',
        sourceState: event.status === 'firing' ? 'active' : 'resolved',
        sourceActivityAt: event.occurredAt,
        sourceActivityKey: `${event.status}:${event.eventId}`,
        reopenPolicy: 'handled',
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
        isActionable: event.status === 'firing' && (event.links?.length ?? 0) > 0,
        occurrenceKey: event.eventId,
      }], {
        now: options.receivedAt,
        wakeDispatcher: false,
      });
      replaceExternalActions(transaction, creation.notification.id, event);
      transaction.update(homelabAlertReceipts).set({
        notificationId: creation.notification.id,
      }).where(and(
        eq(homelabAlertReceipts.integration, integration),
        eq(homelabAlertReceipts.source, event.source),
        eq(homelabAlertReceipts.eventId, event.eventId),
      )).run();
      totals.applied++;
      if (creation.created) totals.created++;
      else totals.updated++;
      shouldWakeDispatcher ||= creation.deliveryEvents.some(delivery => delivery.status === 'pending');
    }
    return totals;
  });

  if (options.wakeDispatcher !== false && shouldWakeDispatcher) {
    wakeNotificationDeliveryDispatcher();
  }
  return result;
}
