import { buildMonarchExternalTargetLink } from '@/lib/finance/external-targets';
import type { ExternalTargetV1, InsightOccurrenceSummaryV1 } from './contract';

/**
 * Pure (no persistence) finance-insight notification helpers shared between
 * `notification-ingestion.ts` (Layer 5B orchestration, audited to stay free
 * of direct `@/db`/drizzle-orm imports) and `notification-lifecycle.ts` (the
 * drizzle-transaction-touching half). Kept in their own module so neither of
 * those two files needs to import from the other.
 */

export type FinanceNotificationEnvironment = Readonly<Record<string, string | undefined>>;

const MAX_FRESH_AGE_MS = 48 * 60 * 60 * 1_000;

export const FINANCE_IMMEDIATE_NOTIFICATION_GATE =
  'TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED';
export const FINANCE_MONTHLY_DIGEST_GATE =
  'TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED';

export function gateEnabled(
  name: string,
  environment: FinanceNotificationEnvironment,
): boolean {
  return environment[name]?.trim().toLowerCase() === 'true';
}

export function primaryMonarchTarget(
  item: InsightOccurrenceSummaryV1,
): ExternalTargetV1 | null {
  return item.targets.find((target) => (
    target.system === 'monarch' && buildMonarchExternalTargetLink(target) !== null
  )) ?? null;
}

export function notificationMetadata(item: InsightOccurrenceSummaryV1) {
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

export function isOccurrenceNotificationEligible(
  item: InsightOccurrenceSummaryV1,
  now: Date,
  environment: FinanceNotificationEnvironment,
): boolean {
  return isImmediateNotificationEligible(item, now, environment);
}
