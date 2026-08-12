import 'server-only';

import { and, eq } from 'drizzle-orm';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { runTransaction, sqlite } from '@/db';
import { notificationActions, notifications } from '@/db/schema';
import { buildMonarchExternalTargetLink } from '@/lib/finance/external-targets';
import { getTimezone } from '@/lib/mode';
import {
  createNotificationsInTransaction,
  type CreateNotificationInput,
  type CreateNotificationResult,
  wakeNotificationDeliveryDispatcher,
} from '@/lib/notifications/service';
import {
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification } from '@/types';
import { financeInsightDigestV1, type CanonicalJsonValue } from './canonical';
import type {
  ExternalTargetV1,
  InsightOccurrenceSummaryV1,
} from './contract';
import {
  financeInsightDetailTarget,
  financeInsightPeriodTarget,
} from './navigation';
import { FINANCE_PROVIDER_ALIASES } from './provider';

const MAX_FRESH_AGE_MS = 48 * 60 * 60 * 1_000;
const MAX_DIGEST_MOVERS = 10;

export const FINANCE_IMMEDIATE_NOTIFICATION_GATE =
  'TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED';
export const FINANCE_MONTHLY_DIGEST_GATE =
  'TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED';

type FinanceNotificationEnvironment = Readonly<Record<string, string | undefined>>;

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

function gateEnabled(
  name: string,
  environment: FinanceNotificationEnvironment,
): boolean {
  return environment[name]?.trim().toLowerCase() === 'true';
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

function primaryMonarchTarget(
  item: InsightOccurrenceSummaryV1,
): ExternalTargetV1 | null {
  return item.targets.find((target) => (
    target.system === 'monarch' && buildMonarchExternalTargetLink(target) !== null
  )) ?? null;
}

export function isFinanceInsightAlertEligible(
  item: InsightOccurrenceSummaryV1,
  now = new Date(),
): boolean {
  const sourceAsOf = item.freshness.sourceAsOf === null
    ? Number.NaN
    : Date.parse(item.freshness.sourceAsOf);
  return item.analysisState === 'qualified'
    && item.sourceLifecycle === 'open'
    && item.freshness.state === 'fresh'
    && item.provenance.completeness === 'complete'
    && Number.isFinite(sourceAsOf)
    && sourceAsOf <= now.getTime()
    && now.getTime() - sourceAsOf <= MAX_FRESH_AGE_MS
    && primaryMonarchTarget(item) !== null;
}

export function isMaterialRecurringIncrease(
  item: InsightOccurrenceSummaryV1,
): boolean {
  return item.kind === 'recurringAmountChange'
    && !item.reasonCodes.includes('recurring_decrease_analysis_only')
    && item.absoluteDelta !== null
    && item.absoluteDelta.amountMinor > 0;
}

export function isImmediateLargeTransactionEligible(
  item: InsightOccurrenceSummaryV1,
  environment: FinanceNotificationEnvironment = process.env,
): boolean {
  return item.kind === 'largeTransaction'
    && item.confidence !== 'low'
    && gateEnabled(FINANCE_IMMEDIATE_NOTIFICATION_GATE, environment);
}

export function isImmediateRecurringIncreaseEligible(
  item: InsightOccurrenceSummaryV1,
  environment: FinanceNotificationEnvironment = process.env,
): boolean {
  return isMaterialRecurringIncrease(item)
    && gateEnabled(FINANCE_IMMEDIATE_NOTIFICATION_GATE, environment);
}

function notificationMetadata(item: InsightOccurrenceSummaryV1) {
  return {
    notificationType: item.kind,
    insightId: item.insightId,
    occurrenceId: item.occurrenceId,
    deliveryRevision: item.deliveryRevision,
    sourceLifecycle: item.sourceLifecycle,
    confidence: item.confidence,
    baselineSufficiency: item.baselineSufficiency,
    freshnessState: item.freshness.state,
    entityDisplayName: item.entity.displayName,
    observationPeriod: item.observationPeriod,
    observedAmountMinor: item.observedValue?.amountMinor ?? null,
    absoluteDeltaMinor: item.absoluteDelta?.amountMinor ?? null,
    percentageDeltaBasisPoints: item.percentageDeltaBasisPoints,
    currency: item.currency,
    primaryTarget: primaryMonarchTarget(item),
  };
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

function isImmediateNotificationEligible(
  item: InsightOccurrenceSummaryV1,
  now: Date,
  environment: FinanceNotificationEnvironment,
): boolean {
  return isFinanceInsightAlertEligible(item, now)
    && (
      isImmediateLargeTransactionEligible(item, environment)
      || isImmediateRecurringIncreaseEligible(item, environment)
    );
}

function isOccurrenceNotificationEligible(
  item: InsightOccurrenceSummaryV1,
  now: Date,
  environment: FinanceNotificationEnvironment,
): boolean {
  return isImmediateNotificationEligible(item, now, environment);
}

export function reconcileFinanceInsightNotificationLifecycle(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  connectorId: string,
  items: readonly InsightOccurrenceSummaryV1[],
  now: Date,
  environment: FinanceNotificationEnvironment = process.env,
): void {
  const nowIso = now.toISOString();
  for (const item of items) {
    if (
      item.sourceLifecycle === 'open'
      && isOccurrenceNotificationEligible(item, now, environment)
    ) {
      continue;
    }

    const sourceId = financeInsightNotificationSourceId(connectorId, item.occurrenceId);
    const existing = transaction.select({
      id: notifications.id,
      disposition: notifications.disposition,
      sourceResolvedAt: notifications.sourceResolvedAt,
    }).from(notifications).where(and(
      eq(notifications.sourceId, sourceId),
      eq(notifications.connectorType, 'finance-manager'),
      eq(notifications.connectorInstanceId, connectorId),
    )).get();
    if (!existing) continue;

    const state = existing.disposition === 'dismissed'
      ? 'dismissed'
      : existing.disposition === 'handled'
        ? 'archived'
        : 'resolved';
    transaction.update(notifications).set({
      state,
      sourceState: 'resolved',
      sourceResolvedAt: existing.sourceResolvedAt ?? item.resolvedAt ?? nowIso,
      lastSourceActivityAt: item.updatedAt,
      lastSourceActivityKey: `${item.occurrenceId}:${item.deliveryRevision}`,
      lastSourceSyncedAt: nowIso,
      isActionable: false,
      primaryActionId: null,
      metadata: notificationMetadata(item),
    }).where(eq(notifications.id, existing.id)).run();
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, existing.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
  }
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

function connectorSelectionResolved(connectorId: string): boolean {
  const placeholders = FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ');
  const rows = sqlite.prepare(`
    SELECT id FROM connector_configs
    WHERE enabled = 1 AND deleted_at IS NULL
      AND type IN (${placeholders})
    ORDER BY id
  `).all(...FINANCE_PROVIDER_ALIASES) as Array<{ id: string }>;
  return rows.length === 1 && rows[0]!.id === connectorId;
}

function providerNotification(
  result: CreateNotificationResult,
): InboundNotification {
  const notification = result.notification;
  return {
    id: notification.id,
    sourceId: notification.sourceId,
    connectorType: notification.connectorType,
    connectorInstanceId: notification.connectorInstanceId,
    title: notification.title,
    body: notification.body ?? undefined,
    level: notification.level as InboundNotification['level'],
    category: notification.category,
    isRead: notification.readState === 'read',
    isActionable: notification.isActionable,
    receivedAt: notification.receivedAt,
    hubProjectIds: [],
    tags: [],
    metadata: notification.metadata as Record<string, unknown>,
  };
}

export function syncFinanceProviderPresentation(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  results: readonly CreateNotificationResult[],
): void {
  registerDefaultNotificationProviders();
  for (const result of results) {
    const resolved = resolveNotificationProvider(providerNotification(result));
    if (!resolved) continue;
    const active = result.notification.sourceState === 'active';
    const drafts = active
      ? (resolved.presentation.actions ?? []).filter((action) => action.actionType !== 'create_task')
      : [];
    const actionRecords = materializeNotificationActions(
      result.notification.id,
      drafts,
      (() => {
        let index = 0;
        return () => `${result.notification.id}:finance-action:${index++}`;
      })(),
    );
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, result.notification.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
    if (actionRecords.length > 0) {
      transaction.insert(notificationActions).values(actionRecords).run();
    }
    transaction.update(notifications).set({
      title: resolved.presentation.title ?? result.notification.title,
      body: resolved.presentation.body ?? result.notification.body,
      presentation: {
        ...(result.notification.presentation !== null
          && typeof result.notification.presentation === 'object'
          && !Array.isArray(result.notification.presentation)
          ? result.notification.presentation
          : {}),
        ...(resolved.presentation.presentation ?? {}),
      },
      isActionable: active && (resolved.presentation.isActionable ?? actionRecords.length > 0),
      primaryActionId: actionRecords.find((action) => action.isPrimary)?.id ?? null,
    }).where(eq(notifications.id, result.notification.id)).run();
  }
}

export async function ingestFinanceInsightNotifications(input: {
  connectorId: string;
  items: readonly InsightOccurrenceSummaryV1[];
  now?: Date;
  timezone?: string;
  environment?: FinanceNotificationEnvironment;
}): Promise<CreateNotificationResult[]> {
  const now = input.now ?? new Date();
  const result = runTransaction((transaction) => {
    const gate = sqlite.prepare(`
      SELECT delivery_enabled AS deliveryEnabled
      FROM finance_insight_cutovers
      WHERE connector_id = ?
    `).get(input.connectorId) as { deliveryEnabled: number } | undefined;
    if (gate?.deliveryEnabled !== 1 || !connectorSelectionResolved(input.connectorId)) {
      return { created: [] as CreateNotificationResult[], hasPendingDelivery: false };
    }
    reconcileFinanceInsightNotificationLifecycle(
      transaction,
      input.connectorId,
      input.items,
      now,
      input.environment,
    );
    const created = createNotificationsInTransaction(
      transaction,
      selectFinanceInsightNotificationInputs(input.connectorId, input.items, now, {
        environment: input.environment,
        timezone: input.timezone,
      }),
      { now, timezone: input.timezone, wakeDispatcher: false },
    );
    syncFinanceProviderPresentation(transaction, created);
    return {
      created,
      hasPendingDelivery: created.some((entry) => (
        entry.deliveryEvents.some((event) => event.status === 'pending')
      )),
    };
  });
  if (result.hasPendingDelivery) wakeNotificationDeliveryDispatcher();
  return result.created;
}
