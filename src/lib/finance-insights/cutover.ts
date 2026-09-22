import 'server-only';

import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications/dispatcher-wake';
import type { CreateNotificationInput } from '@/lib/notifications/service';
import type { ConnectorNotificationInput } from '@/db/persistence/connector-execution';
import type {
  FinanceInsightNotificationIngestItem,
  FinanceInsightNotificationReconcileItem,
} from '@/db/persistence/finance-insights';
import {
  FinanceOperatorPersistenceError,
  type FinanceOperatorActorType,
  type FinanceOperatorPersistence,
} from '@/db/persistence/finance-operator';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { insightOccurrenceSummarySchema, type InsightOccurrenceSummaryV1 } from './contract';
import { FINANCE_PROVIDER_ALIASES } from './provider';
import { selectFinanceInsightNotificationInputs } from './notification-ingestion';
import {
  isOccurrenceNotificationEligible,
  notificationMetadata,
} from './notification-shared';

/**
 * Finance Insight cutover policy.
 *
 * All persistence goes through `FinanceWorkerPersistence.operator`, which owns
 * the single transaction that fences readiness/generation, records the optional
 * idempotency audit, expires the legacy anomaly notifications, runs the insight
 * notification lifecycle, and switches the cutover state. What remains here is
 * request-independent policy: occurrence-summary parsing, latest-revision
 * selection, notification input construction, and the wake-after-commit of the
 * notification delivery dispatcher.
 */

async function operatorPersistence(): Promise<FinanceOperatorPersistence> {
  return (await getWorkerPersistenceRepositories()).finance.operator;
}

export async function resolveSingleFinanceConnectorId(): Promise<string> {
  const { finance } = await getWorkerPersistenceRepositories();
  const connectorId = await finance.insights.connectors.resolveSingleEnabledConnectorId(
    FINANCE_PROVIDER_ALIASES,
  );
  if (!connectorId) throw new Error('finance_insight_connector_unavailable');
  return connectorId;
}

export async function isFinanceInsightDeliveryEnabled(connectorId: string): Promise<boolean> {
  const { finance } = await getWorkerPersistenceRepositories();
  return finance.insights.notifications.isDeliveryEnabled(connectorId);
}

/**
 * True while no connector has completed the cutover, i.e. while the legacy
 * finance anomaly production path is still the delivered surface.
 */
export async function isLegacyFinanceAnomalyProductionEnabled(): Promise<boolean> {
  return (await operatorPersistence()).isLegacyAnomalyProductionEnabled();
}

function financeInsightNotificationSourceId(
  connectorId: string,
  occurrenceId: string,
): string {
  return `finance-insight:${connectorId}:${occurrenceId}`;
}

function toConnectorNotificationInput(
  input: CreateNotificationInput,
): ConnectorNotificationInput {
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  return {
    id: input.id ?? crypto.randomUUID(),
    sourceId: input.sourceId,
    connectorType: input.connectorType,
    connectorInstanceId: input.connectorInstanceId,
    title: input.title,
    body: input.body ?? null,
    level: input.level ?? 'fyi',
    category: input.category ?? 'finance',
    templateKey: input.templateKey ?? null,
    readState: input.readState ?? 'unread',
    disposition: input.disposition,
    sourceState: input.sourceState ?? 'active',
    syncState: input.syncState,
    sourceActivityAt: input.sourceActivityAt ?? null,
    sourceActivityKey: input.sourceActivityKey ?? null,
    reopenPolicy: input.reopenPolicy ?? 'handled_and_dismissed',
    occurrenceKey: input.occurrenceKey ?? 'initial',
    isActionable: input.isActionable ?? false,
    primaryActionId: input.primaryActionId ?? null,
    receivedAt,
    sortAt: input.sortAt ?? receivedAt,
    relatedTaskId: input.relatedTaskId ?? null,
    relatedProjectId: input.relatedProjectId ?? null,
    relatedEntityType: input.relatedEntityType ?? null,
    relatedEntityId: input.relatedEntityId ?? null,
    navigationTarget: input.navigationTarget ?? null,
    metadata: input.metadata ?? {},
    presentation: input.presentation ?? {},
  };
}

function toIngestItem(input: CreateNotificationInput): FinanceInsightNotificationIngestItem {
  return {
    input: toConnectorNotificationInput(input),
    groupKey: input.groupKey ?? null,
    dedupeKey: input.dedupeKey ?? null,
  };
}

function toReconcileItems(
  connectorId: string,
  items: readonly InsightOccurrenceSummaryV1[],
  now: Date,
): FinanceInsightNotificationReconcileItem[] {
  return items
    .filter((item) => !(
      item.sourceLifecycle === 'open'
      && isOccurrenceNotificationEligible(item, now, process.env)
    ))
    .map((item) => ({
      sourceId: financeInsightNotificationSourceId(connectorId, item.occurrenceId),
      lastSourceActivityAt: item.updatedAt,
      lastSourceActivityKey: `${item.occurrenceId}:${item.deliveryRevision}`,
      sourceResolvedAt: item.resolvedAt ?? null,
      metadata: notificationMetadata(item),
    }));
}

/** Latest delivery revision per occurrence, in delivered projection order. */
function latestByOccurrence(payloads: readonly string[]): InsightOccurrenceSummaryV1[] {
  const latest = new Map<string, InsightOccurrenceSummaryV1>();
  for (const payload of payloads) {
    const item = insightOccurrenceSummarySchema.parse(JSON.parse(payload));
    const current = latest.get(item.occurrenceId);
    if (!current || item.deliveryRevision > current.deliveryRevision) {
      latest.set(item.occurrenceId, item);
    }
  }
  return [...latest.values()];
}

export interface FinanceInsightCutoverEnableResult {
  status: 'enabled';
  legacyExpiredCount: number;
  importedCount: number;
  suppressedDeliveryCount: number;
  replayed: boolean;
}

export async function enableFinanceInsightCutover(input: {
  connectorId: string;
  sourceGeneration: string;
  now?: Date;
  /** Operator identity. Omitted for a direct (non-operator) cutover. */
  actorType?: FinanceOperatorActorType;
  idempotencyKey?: string;
  /** Readiness blockers already determined by the caller. */
  blockers?: readonly string[];
}): Promise<FinanceInsightCutoverEnableResult> {
  const now = input.now ?? new Date();
  const operator = await operatorPersistence();
  const blockers = input.blockers ?? [];
  const generation = blockers.length > 0
    ? null
    : await operator.readCutoverGeneration({
      connectorId: input.connectorId,
      sourceGeneration: input.sourceGeneration,
    });
  const lifecycleItems = generation ? latestByOccurrence(generation.summaryPayloads) : [];
  const notificationInputs = generation
    ? selectFinanceInsightNotificationInputs(
      input.connectorId,
      lifecycleItems.filter((item) => item.sourceLifecycle === 'open'),
      now,
    )
    : [];

  const outcome = await operator.enableCutover({
    connectorId: input.connectorId,
    sourceGeneration: input.sourceGeneration,
    sourceSequence: generation?.sourceSequence ?? 0,
    actorType: input.actorType ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    now: now.toISOString(),
    blockers: blockers.length > 0
      ? blockers
      : generation
        ? []
        : ['finance_insight_cutover_generation_unavailable'],
    reconcile: toReconcileItems(input.connectorId, lifecycleItems, now),
    ingest: notificationInputs.map(toIngestItem),
  });
  if (outcome.outcome === 'blocked') {
    throw new FinanceOperatorPersistenceError(
      outcome.blockers[0] ?? 'finance_insight_cutover_failed',
    );
  }
  // Wake-after-commit only: never before the cutover transaction has landed,
  // and never for a replay, which creates no new pending delivery.
  if (outcome.hasPendingDelivery) wakeNotificationDeliveryDispatcher();
  return {
    status: 'enabled',
    legacyExpiredCount: outcome.legacyExpiredCount,
    importedCount: outcome.importedCount,
    suppressedDeliveryCount: outcome.suppressedDeliveryCount,
    replayed: outcome.replayed,
  };
}

export async function rollbackFinanceInsightCutover(input: {
  connectorId: string;
  sourceGeneration: string;
  now?: Date;
  actorType?: FinanceOperatorActorType;
  idempotencyKey?: string;
}): Promise<{
  status: 'rolled-back';
  legacyExpiredCount: number;
  importedCount: number;
  suppressedDeliveryCount: number;
  replayed: boolean;
}> {
  const operator = await operatorPersistence();
  const result = await operator.rollbackCutover({
    connectorId: input.connectorId,
    sourceGeneration: input.sourceGeneration,
    actorType: input.actorType ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    now: (input.now ?? new Date()).toISOString(),
  });
  return {
    status: 'rolled-back',
    legacyExpiredCount: result.legacyExpiredCount,
    importedCount: result.importedCount,
    suppressedDeliveryCount: result.suppressedDeliveryCount,
    replayed: result.replayed,
  };
}
