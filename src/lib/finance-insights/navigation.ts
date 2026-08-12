const FINANCE_INSIGHT_PERIOD_QUERY = 'insightPeriod';

export function financeInsightDetailTarget(occurrenceId: string): string {
  return `/finance/insights/${encodeURIComponent(occurrenceId)}`;
}

export function financeInsightPeriodTarget(period: {
  start: string;
  end: string;
}): string {
  return `/finance?${FINANCE_INSIGHT_PERIOD_QUERY}=${encodeURIComponent(`${period.start}:${period.end}`)}`;
}
