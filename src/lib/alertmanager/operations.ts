import 'server-only';

import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  alertmanagerIntegrationEvents,
  appSettings,
  homelabAlertReceipts,
  notificationActions,
  notificationDeliveryEvents,
  notifications,
} from '@/db/schema';
import type { IngestHomelabAlertResult } from './service';
import { ingestHomelabAlertEvents } from './service';

const CONTROL_KEY = 'alertmanager-integration-control';
const TOKEN_MIN_LENGTH = 32;
const MAX_DETAIL_LENGTH = 500;
const MAX_EVENT_HISTORY = 1_000;
const EVENT_PRUNE_BATCH = 100;

export type AlertmanagerEventKind =
  | 'webhook_request'
  | 'operator_action'
  | 'synthetic_test';

export interface AlertmanagerIntegrationEventInput {
  integration: string;
  kind: AlertmanagerEventKind;
  outcome: string;
  authenticated?: boolean;
  httpStatus: number;
  result?: Partial<IngestHomelabAlertResult>;
  detail?: string;
  occurredAt?: Date;
}

interface AlertmanagerControl {
  paused: boolean;
  updatedAt: string | null;
}

export function getAlertmanagerIntegrationId(): string {
  return process.env.MC_ALERTMANAGER_INTEGRATION_ID?.trim() || 'homelab';
}

export function isAlertmanagerConfigured(): boolean {
  const token = process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN?.trim();
  return Boolean(token && token.length >= TOKEN_MIN_LENGTH);
}

export async function getAlertmanagerControl(): Promise<AlertmanagerControl> {
  const [row] = await db.select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .where(eq(appSettings.key, CONTROL_KEY))
    .limit(1);
  const value = row?.value;
  return {
    paused: Boolean(value && typeof value === 'object' && 'paused' in value && value.paused === true),
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function setAlertmanagerPaused(
  integration: string,
  paused: boolean,
  actor: string,
): Promise<AlertmanagerControl> {
  const now = new Date().toISOString();
  const event = integrationEventValues({
    integration,
    kind: 'operator_action',
    outcome: paused ? 'paused' : 'resumed',
    authenticated: true,
    httpStatus: 200,
    detail: `${paused ? 'Paused' : 'Resumed'} by ${actor}`,
  });
  runTransaction((transaction) => {
    transaction.insert(appSettings).values({
      key: CONTROL_KEY,
      value: { paused },
      updatedAt: now,
    }).onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { paused }, updatedAt: now },
    }).run();
    transaction.insert(alertmanagerIntegrationEvents).values(event).run();
  });
  await pruneEventHistory(integration);
  return { paused, updatedAt: now };
}

function integrationEventValues(
  input: AlertmanagerIntegrationEventInput,
): typeof alertmanagerIntegrationEvents.$inferInsert {
  const result = input.result ?? {};
  return {
    id: crypto.randomUUID(),
    integration: input.integration,
    kind: input.kind,
    outcome: input.outcome.slice(0, 80),
    authenticated: input.authenticated ?? false,
    httpStatus: input.httpStatus,
    accepted: result.accepted ?? 0,
    applied: result.applied ?? 0,
    created: result.created ?? 0,
    updated: result.updated ?? 0,
    stale: result.stale ?? 0,
    duplicateReceipts: result.duplicateReceipts ?? 0,
    detail: input.detail?.slice(0, MAX_DETAIL_LENGTH) ?? null,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
  };
}

async function pruneEventHistory(integration: string): Promise<void> {
  const protectedRows = await Promise.all([
    db.select({ id: alertmanagerIntegrationEvents.id })
      .from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
        eq(alertmanagerIntegrationEvents.outcome, 'projected'),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(1),
    db.select({ id: alertmanagerIntegrationEvents.id })
      .from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'synthetic_test'),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(1),
    db.select({ id: alertmanagerIntegrationEvents.id })
      .from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
        eq(alertmanagerIntegrationEvents.authenticated, true),
        notInArray(alertmanagerIntegrationEvents.outcome, ['projected', 'paused']),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(1),
  ]);
  const protectedIds = new Set(protectedRows.flat().map(row => row.id));
  const expired = await db.select({ id: alertmanagerIntegrationEvents.id })
    .from(alertmanagerIntegrationEvents)
    .where(eq(alertmanagerIntegrationEvents.integration, integration))
    .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
    .limit(EVENT_PRUNE_BATCH)
    .offset(MAX_EVENT_HISTORY);
  const expiredIds = expired.map(row => row.id).filter(id => !protectedIds.has(id));
  if (expiredIds.length > 0) {
    await db.delete(alertmanagerIntegrationEvents)
      .where(inArray(alertmanagerIntegrationEvents.id, expiredIds));
  }
}

export async function recordAlertmanagerIntegrationEvent(
  input: AlertmanagerIntegrationEventInput,
): Promise<void> {
  await db.insert(alertmanagerIntegrationEvents).values(integrationEventValues(input));
  await pruneEventHistory(input.integration);
}

export async function getAlertmanagerIntegrationStatus() {
  const integration = getAlertmanagerIntegrationId();
  const [
    control,
    [lastRequest = null],
    [lastAuthenticatedReceipt = null],
    [lastSuccessfulProjection = null],
    [lastSyntheticTest = null],
    recentFailures,
    [counts],
  ] = await Promise.all([
    getAlertmanagerControl(),
    db.select().from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(1),
    db.select().from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
        eq(alertmanagerIntegrationEvents.authenticated, true),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(1),
    db.select().from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
        eq(alertmanagerIntegrationEvents.outcome, 'projected'),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(1),
    db.select().from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'synthetic_test'),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(1),
    db.select().from(alertmanagerIntegrationEvents)
      .where(and(
        eq(alertmanagerIntegrationEvents.integration, integration),
        eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
        eq(alertmanagerIntegrationEvents.authenticated, true),
        notInArray(alertmanagerIntegrationEvents.outcome, ['projected', 'paused']),
      ))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt))
      .limit(5),
    db.select({
      requests: sql<number>`coalesce(sum(case when ${alertmanagerIntegrationEvents.kind} = 'webhook_request' then 1 else 0 end), 0)`,
      failures: sql<number>`coalesce(sum(case when ${alertmanagerIntegrationEvents.kind} = 'webhook_request' and ${alertmanagerIntegrationEvents.authenticated} = true and ${alertmanagerIntegrationEvents.outcome} not in ('projected', 'paused') then 1 else 0 end), 0)`,
      intentionalDrops: sql<number>`coalesce(sum(case when ${alertmanagerIntegrationEvents.outcome} = 'paused' and ${alertmanagerIntegrationEvents.kind} = 'webhook_request' then 1 else 0 end), 0)`,
      accepted: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.accepted}), 0)`,
      applied: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.applied}), 0)`,
      created: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.created}), 0)`,
      updated: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.updated}), 0)`,
      stale: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.stale}), 0)`,
      duplicateReceipts: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.duplicateReceipts}), 0)`,
    }).from(alertmanagerIntegrationEvents)
      .where(eq(alertmanagerIntegrationEvents.integration, integration)),
  ]);

  const configured = isAlertmanagerConfigured();
  const state = !configured
    ? 'not_configured'
    : control.paused
      ? 'paused'
      : lastSuccessfulProjection
        ? recentFailures[0]
          && recentFailures[0].occurredAt > lastSuccessfulProjection.occurredAt
          ? 'degraded'
          : 'connected'
        : 'awaiting_delivery';

  return {
    id: integration,
    name: 'Alertmanager',
    endpoint: '/api/integrations/alertmanager/webhook',
    systemManaged: true,
    configured,
    connected: Boolean(lastSuccessfulProjection),
    enabled: configured && !control.paused,
    paused: control.paused,
    state,
    controlUpdatedAt: control.updatedAt,
    lastRequest,
    lastAuthenticatedReceipt,
    lastSuccessfulProjection,
    lastSyntheticTest,
    recentFailures,
    counts: Object.fromEntries(
      Object.entries(counts ?? {}).map(([key, value]) => [key, Number(value)]),
    ),
  };
}

export async function runSyntheticAlertmanagerLifecycle(integration: string) {
  const runId = crypto.randomUUID();
  const fingerprint = runId.replaceAll('-', '');
  const sourceId = `${integration}:alertmanager:${fingerprint}`;
  const startedAt = new Date();
  const resolvedAt = new Date(startedAt.getTime() + 1_000);
  const baseEvent = {
    schemaVersion: 1 as const,
    source: 'alertmanager' as const,
    fingerprint,
    startsAt: startedAt.toISOString(),
    severity: 'info' as const,
    type: 'homelab_service_unavailable' as const,
    summary: 'Synthetic Alertmanager lifecycle test',
    description: 'Fixed local test event; no upstream service or runbook is invoked.',
    service: 'mission-control-synthetic',
    environment: 'synthetic',
    actionRequired: false,
  };

  try {
    const firing = ingestHomelabAlertEvents([{
      ...baseEvent,
      eventId: `${runId}:firing`,
      occurredAt: startedAt.toISOString(),
      status: 'firing',
    }], {
      integration,
      wakeDispatcher: false,
      suppressDeliveries: true,
    });
    const duplicate = ingestHomelabAlertEvents([{
      ...baseEvent,
      eventId: `${runId}:firing`,
      occurredAt: startedAt.toISOString(),
      status: 'firing',
    }], {
      integration,
      wakeDispatcher: false,
      suppressDeliveries: true,
    });
    const resolved = ingestHomelabAlertEvents([{
      ...baseEvent,
      eventId: `${runId}:resolved`,
      occurredAt: resolvedAt.toISOString(),
      status: 'resolved',
      endsAt: resolvedAt.toISOString(),
    }], {
      integration,
      wakeDispatcher: false,
      suppressDeliveries: true,
    });

    const [projection, receipts] = await Promise.all([
      db.select().from(notifications).where(eq(notifications.sourceId, sourceId)),
      db.select().from(homelabAlertReceipts).where(and(
        eq(homelabAlertReceipts.integration, integration),
        eq(homelabAlertReceipts.fingerprint, fingerprint),
      )),
    ]);
    const firingReceipt = receipts.find(receipt => receipt.status === 'firing');
    if (
      projection.length !== 1
      || projection[0].sourceState !== 'resolved'
      || receipts.length !== 2
      || firingReceipt?.deliveryCount !== 2
    ) {
      throw new Error('Synthetic lifecycle did not produce one deduplicated resolved projection');
    }

    return {
      success: true,
      fingerprint,
      lifecycle: ['firing', 'duplicate_firing', 'resolved'],
      projectionCount: projection.length,
      receiptCount: receipts.length,
      duplicateReceipts: duplicate.duplicateReceipts,
      applied: firing.applied + duplicate.applied + resolved.applied,
    };
  } finally {
    runTransaction((transaction) => {
      const projection = transaction.select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.sourceId, sourceId))
        .get();
      if (projection) {
        transaction.delete(notificationActions)
          .where(eq(notificationActions.notificationId, projection.id))
          .run();
        transaction.delete(notificationDeliveryEvents)
          .where(eq(notificationDeliveryEvents.notificationId, projection.id))
          .run();
      }
      transaction.delete(homelabAlertReceipts).where(and(
        eq(homelabAlertReceipts.integration, integration),
        eq(homelabAlertReceipts.fingerprint, fingerprint),
      )).run();
      transaction.delete(notifications).where(eq(notifications.sourceId, sourceId)).run();
    });
  }
}
