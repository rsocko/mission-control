import 'server-only';

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getTimezone } from '@/lib/mode';
import type { CreateNotificationInput } from '@/lib/notifications/service';
import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications/dispatcher-wake';
import type {
  ConnectorNotificationInput,
} from '@/db/persistence/connector-execution';
import type {
  FinanceInsightNotificationIngestItem,
} from '@/db/persistence/finance-insights';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { financeInsightDigestV1, type CanonicalJsonValue } from './canonical';
import type {
  InsightOccurrenceSummaryV1,
} from './contract';
import {
  financeInsightDetailTarget,
  financeInsightPeriodTarget,
} from './navigation';
import {
  FINANCE_MONTHLY_DIGEST_GATE,
  gateEnabled,
  isFinanceInsightAlertEligible,
  isOccurrenceNotificationEligible,
  notificationMetadata,
  primaryMonarchTarget,
  type FinanceNotificationEnvironment,
} from './notification-shared';
import { FINANCE_PROVIDER_ALIASES } from './provider';

export {
  FINANCE_IMMEDIATE_NOTIFICATION_GATE,
  FINANCE_MONTHLY_DIGEST_GATE,
  isFinanceInsightAlertEligible,
  isImmediateLargeTransactionEligible,
  isImmediateRecurringIncreaseEligible,
  isMaterialRecurringIncrease,
} from './notification-shared';

const MAX_DIGEST_MOVERS = 10;

export interface FinanceMonthlyDigestSchedule {
  period: { start: string; end: string };
  scheduledAt: Date;
  ready: boolean;
}

interface FinanceDigestMover {
  occurrenceId: string;
  name: string;
  kind: 'categoryVariance' | 'merchantVariance';
  absoluteDeltaMinor: number | null;
  percentageDeltaBasisPoints: number | null;
}

function calendarDate(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

export function getFinanceMonthlyDigestSchedule(
  now: Date,
  timezone: string,
): FinanceMonthlyDigestSchedule | null {
  try {
    const localDate = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
    const [year, month] = localDate.split('-').map(Number);
    if (!year || !month) return null;
    const currentMonthIndex = month - 1;
    const previousMonthEnd = new Date(Date.UTC(year, currentMonthIndex, 0));
    const period = {
      start: calendarDate(
        previousMonthEnd.getUTCFullYear(),
        previousMonthEnd.getUTCMonth(),
        1,
      ),
      end: calendarDate(
        previousMonthEnd.getUTCFullYear(),
        previousMonthEnd.getUTCMonth() + 1,
        0,
      ),
    };
    const scheduledAt = fromZonedTime(
      `${calendarDate(year, currentMonthIndex, 2)}T09:00:00`,
      timezone,
    );
    const deliveryWindowEnd = fromZonedTime(
      `${calendarDate(year, currentMonthIndex, 3)}T00:00:00`,
      timezone,
    );
    return {
      period,
      scheduledAt,
      ready: now.getTime() >= scheduledAt.getTime()
        && now.getTime() < deliveryWindowEnd.getTime(),
    };
  } catch {
    return null;
  }
}

export function financeInsightNotificationSourceId(
  connectorId: string,
  occurrenceId: string,
): string {
  return `finance-insight:${connectorId}:${occurrenceId}`;
}

export function financeInsightDigestSourceId(
  connectorId: string,
  period: { start: string; end: string },
): string {
  return `finance-insight-digest:${connectorId}:${period.start.slice(0, 7)}`;
}

function notificationLevel(
  severity: InsightOccurrenceSummaryV1['severity'],
): 'fyi' | 'heads_up' | 'action_needed' {
  if (severity === 'high') return 'action_needed';
  if (severity === 'medium') return 'heads_up';
  return 'fyi';
}

export function buildFinanceInsightNotificationInput(
  connectorId: string,
  item: InsightOccurrenceSummaryV1,
): CreateNotificationInput {
  const sourceId = financeInsightNotificationSourceId(connectorId, item.occurrenceId);
  const occurrenceKey = `${item.occurrenceId}:${item.deliveryRevision}`;
  const active = item.sourceLifecycle === 'open';
  const presentation = item.kind === 'merchantVariance' && item.entity.kind === 'merchant'
    ? {
        financeMerchantKey: item.entity.sourceRef,
        financeMerchantLabel: item.entity.displayName,
      }
    : {};
  return {
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: connectorId,
    title: item.headline,
    body: item.explanation,
    level: notificationLevel(item.severity),
    category: 'finance',
    templateKey: `finance-insight-${item.kind}`,
    readState: 'unread',
    sourceState: active ? 'active' : 'resolved',
    sourceActivityAt: item.updatedAt,
    sourceActivityKey: occurrenceKey,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: item.createdAt,
    sortAt: item.updatedAt,
    groupKey: `finance-insight:${connectorId}:${item.insightId}`,
    dedupeKey: sourceId,
    relatedEntityType: 'finance-insight-occurrence',
    relatedEntityId: item.occurrenceId,
    navigationTarget: financeInsightDetailTarget(item.occurrenceId),
    isActionable: active,
    occurrenceKey,
    metadata: notificationMetadata(item),
    presentation,
  };
}

function moverRank(item: InsightOccurrenceSummaryV1): number {
  return Math.max(
    Math.abs(item.absoluteDelta?.amountMinor ?? 0),
    Math.abs(item.percentageDeltaBasisPoints ?? 0),
  );
}

function digestRevision(
  items: readonly InsightOccurrenceSummaryV1[],
  period: { start: string; end: string },
): string {
  const members = items
    .map((item) => [item.occurrenceId, item.deliveryRevision] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const policyVersion = Math.max(
    ...items.map((item) => item.provenance.policyVersion),
  );
  return financeInsightDigestV1({
    members,
    policyVersion,
    comparisonPeriod: period,
  } as CanonicalJsonValue);
}

function digestTitle(periodStart: string): string {
  const label = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${periodStart}T00:00:00.000Z`));
  return `${label} spending movers`;
}

export function buildFinanceMonthlyDigestInput(input: {
  connectorId: string;
  items: readonly InsightOccurrenceSummaryV1[];
  now: Date;
  timezone: string;
  environment?: FinanceNotificationEnvironment;
}): CreateNotificationInput | null {
  const environment = input.environment ?? process.env;
  if (!gateEnabled(FINANCE_MONTHLY_DIGEST_GATE, environment)) return null;
  const schedule = getFinanceMonthlyDigestSchedule(input.now, input.timezone);
  if (!schedule?.ready) return null;

  const ranked = input.items
    .filter((item) => (
      (item.kind === 'categoryVariance' || item.kind === 'merchantVariance')
      && isFinanceInsightAlertEligible(item, input.now)
      && item.confidence === 'high'
      && !item.reasonCodes.includes('medium_confidence_no_notify')
      && item.observationPeriod.start === schedule.period.start
      && item.observationPeriod.end === schedule.period.end
    ))
    .sort((left, right) => (
      moverRank(right) - moverRank(left)
      || left.occurrenceId.localeCompare(right.occurrenceId)
    ));
  if (ranked.length === 0) return null;

  const bounded = ranked.slice(0, MAX_DIGEST_MOVERS);
  const revision = digestRevision(ranked, schedule.period);
  const sourceId = financeInsightDigestSourceId(input.connectorId, schedule.period);
  const periodKey = schedule.period.start.slice(0, 7);
  const occurrenceKey = `${periodKey}:${revision}`;
  const sourceActivityAt = ranked.reduce((latest, item) => {
    const itemActivityAt = item.updatedAt > item.provenance.evaluationCompletedAt
      ? item.updatedAt
      : item.provenance.evaluationCompletedAt;
    return itemActivityAt > latest ? itemActivityAt : latest;
  }, ranked[0]!.updatedAt);
  const movers: FinanceDigestMover[] = bounded.map((item) => ({
    occurrenceId: item.occurrenceId,
    name: item.entity.displayName,
    kind: item.kind as FinanceDigestMover['kind'],
    absoluteDeltaMinor: item.absoluteDelta?.amountMinor ?? null,
    percentageDeltaBasisPoints: item.percentageDeltaBasisPoints,
  }));

  return {
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: input.connectorId,
    title: digestTitle(schedule.period.start),
    body: `${ranked.length} high-confidence category and merchant spending ${ranked.length === 1 ? 'change' : 'changes'} ranked for review.`,
    level: 'digest',
    category: 'finance',
    templateKey: 'finance-insight-monthly-movers-digest',
    readState: 'unread',
    sourceState: 'active',
    sourceActivityAt,
    sourceActivityKey: occurrenceKey,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: schedule.scheduledAt.toISOString(),
    sortAt: schedule.scheduledAt.toISOString(),
    groupKey: sourceId,
    dedupeKey: sourceId,
    relatedEntityType: 'finance-insight-period',
    relatedEntityId: `${schedule.period.start}:${schedule.period.end}`,
    navigationTarget: financeInsightPeriodTarget(schedule.period),
    isActionable: true,
    occurrenceKey,
    metadata: {
      notificationType: 'monthlyMoversDigest',
      deliveryRevision: revision,
      confidence: 'high',
      observationPeriod: schedule.period,
      moverCount: ranked.length,
      movers,
      topContributors: movers,
      currency: bounded[0]!.currency,
      primaryTarget: primaryMonarchTarget(bounded[0]!),
    },
  };
}

export function selectFinanceInsightNotificationInputs(
  connectorId: string,
  items: readonly InsightOccurrenceSummaryV1[],
  now = new Date(),
  options: {
    environment?: FinanceNotificationEnvironment;
    timezone?: string;
  } = {},
): CreateNotificationInput[] {
  const environment = options.environment ?? process.env;
  const occurrenceInputs = items.flatMap((item) => {
    if (isOccurrenceNotificationEligible(item, now, environment)) {
      return [buildFinanceInsightNotificationInput(connectorId, item)];
    }
    return [];
  });
  const digest = buildFinanceMonthlyDigestInput({
    connectorId,
    items,
    now,
    timezone: options.timezone ?? getTimezone(),
    environment,
  });
  return digest ? [...occurrenceInputs, digest] : occurrenceInputs;
}

/**
 * Converts a finance-built `CreateNotificationInput` into the portable
 * `ConnectorNotificationInput` shape accepted by
 * `FinanceInsightPersistence.notifications.runLifecycle`, matching how the
 * generic (already-migrated) connector notification path represents
 * notifications on both backends. `groupKey`/`dedupeKey` are not part of
 * `ConnectorNotificationInput` (matching the existing generic
 * connector-notification adapters, which have no equivalent fields either);
 * they travel alongside it as `FinanceInsightNotificationIngestItem.groupKey`/
 * `.dedupeKey` instead, see `toFinanceInsightNotificationIngestItem` below.
 */
function toConnectorNotificationInput(input: CreateNotificationInput): ConnectorNotificationInput {
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

function toFinanceInsightNotificationIngestItem(
  input: CreateNotificationInput,
): FinanceInsightNotificationIngestItem {
  return {
    input: toConnectorNotificationInput(input),
    groupKey: input.groupKey ?? null,
    dedupeKey: input.dedupeKey ?? null,
  };
}

export async function ingestFinanceInsightNotifications(input: {
  connectorId: string;
  items: readonly InsightOccurrenceSummaryV1[];
  now?: Date;
  timezone?: string;
  environment?: FinanceNotificationEnvironment;
}): Promise<Array<{ id: string; created: boolean; pendingDelivery: boolean }>> {
  const now = input.now ?? new Date();
  const { execution, finance } = await getWorkerPersistenceRepositories();
  if (!await finance.insights.notifications.isDeliveryEnabled(input.connectorId)) return [];
  const activeConnectorId = await finance.insights.connectors.resolveSingleEnabledConnectorId(
    FINANCE_PROVIDER_ALIASES,
  );
  if (activeConnectorId !== input.connectorId) return [];

  const environment = input.environment ?? process.env;
  const notificationInputs = selectFinanceInsightNotificationInputs(
    input.connectorId,
    input.items,
    now,
    { environment: input.environment, timezone: input.timezone },
  );
  const reconcileItems = input.items
    .filter((item) => !(
      item.sourceLifecycle === 'open'
      && isOccurrenceNotificationEligible(item, now, environment)
    ))
    .map((item) => ({
      sourceId: financeInsightNotificationSourceId(input.connectorId, item.occurrenceId),
      lastSourceActivityAt: item.updatedAt,
      lastSourceActivityKey: `${item.occurrenceId}:${item.deliveryRevision}`,
      sourceResolvedAt: item.resolvedAt ?? null,
      metadata: notificationMetadata(item),
    }));

  const outcome = await finance.insights.notifications.runLifecycle({
    connectorId: input.connectorId,
    now: now.toISOString(),
    reconcile: reconcileItems,
    ingest: notificationInputs.map(toFinanceInsightNotificationIngestItem),
  });
  if (
    outcome.hasPendingDelivery
    && execution.support.allowsLegacyWorkflow('notification-dispatcher')
  ) {
    wakeNotificationDeliveryDispatcher();
  }
  return [...outcome.results];
}
