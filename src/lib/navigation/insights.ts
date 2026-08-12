import type { InsightsPeriod } from '@/lib/stats/insights';

const INSIGHTS_ORIGIN_PARAM = 'origin';
const INSIGHTS_PERIOD_PARAM = 'insightsPeriod';
const INSIGHTS_DRILLDOWN_PENDING = 'mc:insights-drilldown-pending';
const INSIGHTS_DRILLDOWN_STATE = 'mcInsightsDrilldown';

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

export function rememberInsightsDrilldown(href: string) {
  sessionStorage.setItem(INSIGHTS_DRILLDOWN_PENDING, href);
}

export function claimInsightsDrilldownHistory() {
  const pendingHref = sessionStorage.getItem(INSIGHTS_DRILLDOWN_PENDING);
  if (!pendingHref) return;

  const currentHref = `${window.location.pathname}${window.location.search}`;
  if (pendingHref !== currentHref) return;

  sessionStorage.removeItem(INSIGHTS_DRILLDOWN_PENDING);
  const currentState = window.history.state;
  const nextState = currentState && typeof currentState === 'object'
    ? { ...currentState }
    : {};
  window.history.replaceState(
    { ...nextState, [INSIGHTS_DRILLDOWN_STATE]: currentHref },
    '',
  );
}

export function hasInsightsDrilldownHistory(): boolean {
  const currentHref = `${window.location.pathname}${window.location.search}`;
  return window.history.state?.[INSIGHTS_DRILLDOWN_STATE] === currentHref;
}
