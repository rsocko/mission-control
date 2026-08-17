import type { InsightsPeriod } from '@/lib/stats/insights';
import {
  currentAppHistoryDetail,
  getAppHistorySnapshot,
} from '@/lib/navigation/app-history';

const INSIGHTS_ORIGIN_PARAM = 'origin';
const INSIGHTS_PERIOD_PARAM = 'insightsPeriod';

export function addInsightsReturnContext(params: URLSearchParams, period: InsightsPeriod) {
  params.set(INSIGHTS_ORIGIN_PARAM, 'insights');
  params.set(INSIGHTS_PERIOD_PARAM, String(period));
}

export function getInsightsReturnHref(searchParams: Pick<URLSearchParams, 'get'>): string | null {
  if (searchParams.get(INSIGHTS_ORIGIN_PARAM) !== 'insights') return null;

  const period = searchParams.get(INSIGHTS_PERIOD_PARAM);
  return period === '30' || period === '90'
    ? `/insights?period=${period}`
    : '/insights';
}

export function hasInsightsDrilldownHistory(): boolean {
  return currentAppHistoryDetail()?.param === INSIGHTS_ORIGIN_PARAM
    && getAppHistorySnapshot().canGoBack;
}
