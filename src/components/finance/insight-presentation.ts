import type { InsightOccurrenceSummaryV1 } from '@/lib/finance-insights/contract';

export const FINANCE_INSIGHT_KIND_LABELS: Record<InsightOccurrenceSummaryV1['kind'], string> = {
  recurringAmountChange: 'Recurring change',
  largeTransaction: 'Large transaction',
  categoryVariance: 'Category mover',
  merchantVariance: 'Merchant mover',
};

export function friendlyFinanceInsightValue(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatFinanceMoney(
  value: { currency: string; amountMinor: number } | null | undefined,
): string {
  if (!value) return 'Not available';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: value.currency,
  }).format(value.amountMinor / 100);
}

export function formatFinanceRange(
  value: { currency: string; lowerMinor: number; upperMinor: number } | null | undefined,
): string {
  if (!value) return 'Not available';
  return `${formatFinanceMoney({
    currency: value.currency,
    amountMinor: value.lowerMinor,
  })}–${formatFinanceMoney({
    currency: value.currency,
    amountMinor: value.upperMinor,
  })}`;
}

export function formatFinancePercentage(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined) return 'Not available';
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(basisPoints / 10_000);
}

export function formatFinanceDateRange(
  period: { start: string; end: string } | null | undefined,
): string {
  return period ? `${period.start} to ${period.end}` : 'Not available';
}

export function formatFinanceTimestamp(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(parsed);
}
