import 'server-only';

import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { ingestHomelabAlertEvents } from './service';

const TOKEN_MIN_LENGTH = 32;
const MAX_DETAIL_LENGTH = 500;
const MAX_EVENT_HISTORY = 1_000;
const EVENT_PRUNE_BATCH = 100;

export type AlertmanagerEventKind =
  | 'webhook_request'
  | 'operator_action'
  | 'synthetic_test';

interface AlertmanagerIngestResult {
  accepted: number;
  applied: number;
  stale: number;
  created: number;
  updated: number;
  duplicateReceipts: number;
}

interface AlertmanagerIntegrationEventRecord extends AlertmanagerIngestResult {
  id: string;
  integration: string;
  kind: AlertmanagerEventKind;
  outcome: string;
  authenticated: boolean;
  httpStatus: number;
  detail: string | null;
  occurredAt: string;
}

type AlertmanagerRepository = NonNullable<
  Awaited<ReturnType<typeof getWorkerPersistenceRepositories>>['webhookIntegrations']['alertmanager']
>;

export interface AlertmanagerIntegrationEventInput {
  integration: string;
  kind: AlertmanagerEventKind;
  outcome: string;
  authenticated?: boolean;
  httpStatus: number;
  result?: Partial<AlertmanagerIngestResult>;
  detail?: string;
  occurredAt?: Date;
}

async function alertmanagerRepository(): Promise<AlertmanagerRepository> {
  const repository = (await getWorkerPersistenceRepositories()).webhookIntegrations.alertmanager;
  if (!repository) {
    throw new Error('Alertmanager persistence is not available in the selected backend');
  }
  return repository;
}

function integrationEvent(
  input: AlertmanagerIntegrationEventInput,
): AlertmanagerIntegrationEventRecord {
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

export function getAlertmanagerIntegrationId(): string {
  return process.env.MC_ALERTMANAGER_INTEGRATION_ID?.trim() || 'homelab';
}

export function isAlertmanagerConfigured(): boolean {
  const token = process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN?.trim();
  return Boolean(token && token.length >= TOKEN_MIN_LENGTH);
}

export async function getAlertmanagerControl() {
  return (await alertmanagerRepository()).getControl();
}

export async function setAlertmanagerPaused(
  integration: string,
  paused: boolean,
  actor: string,
) {
  const updatedAt = new Date().toISOString();
  return (await alertmanagerRepository()).setPaused({
    integration,
    paused,
    updatedAt,
    auditEvent: integrationEvent({
      integration,
      kind: 'operator_action',
      outcome: paused ? 'paused' : 'resumed',
      authenticated: true,
      httpStatus: 200,
      detail: `${paused ? 'Paused' : 'Resumed'} by ${actor}`,
      occurredAt: new Date(updatedAt),
    }),
    retainLatest: MAX_EVENT_HISTORY,
    pruneBatchSize: EVENT_PRUNE_BATCH,
  });
}

export async function recordAlertmanagerIntegrationEvent(
  input: AlertmanagerIntegrationEventInput,
): Promise<void> {
  await (await alertmanagerRepository()).recordEvent({
    event: integrationEvent(input),
    retainLatest: MAX_EVENT_HISTORY,
    pruneBatchSize: EVENT_PRUNE_BATCH,
  });
}

export async function getAlertmanagerIntegrationStatus() {
  const integration = getAlertmanagerIntegrationId();
  const snapshot = await (await alertmanagerRepository()).getStatus(integration);
  const {
    control,
    lastRequest,
    lastAuthenticatedReceipt,
    lastSuccessfulProjection,
    lastSyntheticTest,
    recentFailures,
    counts,
  } = snapshot;
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
    counts,
  };
}

export async function runSyntheticAlertmanagerLifecycle(integration: string) {
  const repository = await alertmanagerRepository();
  const runId = crypto.randomUUID();
  const fingerprint = runId.replaceAll('-', '');
  const sourceId = `${integration}:alertmanager:${fingerprint}`;
  const startedAt = new Date();
  const resolvedAt = new Date(startedAt.getTime() + 1_000);
  const identity = {
    integration,
    source: 'alertmanager',
    fingerprint,
    sourceId,
  };
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
    const firing = await ingestHomelabAlertEvents([{
      ...baseEvent,
      eventId: `${runId}:firing`,
      occurredAt: startedAt.toISOString(),
      status: 'firing',
    }], {
      integration,
      wakeDispatcher: false,
      suppressDeliveries: true,
    }, repository);
    const duplicate = await ingestHomelabAlertEvents([{
      ...baseEvent,
      eventId: `${runId}:firing`,
      occurredAt: startedAt.toISOString(),
      status: 'firing',
    }], {
      integration,
      wakeDispatcher: false,
      suppressDeliveries: true,
    }, repository);
    const resolved = await ingestHomelabAlertEvents([{
      ...baseEvent,
      eventId: `${runId}:resolved`,
      occurredAt: resolvedAt.toISOString(),
      status: 'resolved',
      endsAt: resolvedAt.toISOString(),
    }], {
      integration,
      wakeDispatcher: false,
      suppressDeliveries: true,
    }, repository);

    const inspection = await repository.inspectSyntheticLifecycle(identity);
    if (
      inspection.projectionCount !== 1
      || inspection.sourceState !== 'resolved'
      || inspection.receiptCount !== 2
      || inspection.firingDeliveryCount !== 2
    ) {
      throw new Error('Synthetic lifecycle did not produce one deduplicated resolved projection');
    }

    return {
      success: true,
      fingerprint,
      lifecycle: ['firing', 'duplicate_firing', 'resolved'],
      projectionCount: inspection.projectionCount,
      receiptCount: inspection.receiptCount,
      duplicateReceipts: duplicate.duplicateReceipts,
      applied: firing.applied + duplicate.applied + resolved.applied,
    };
  } finally {
    await repository.cleanupSyntheticLifecycle(identity);
  }
}
