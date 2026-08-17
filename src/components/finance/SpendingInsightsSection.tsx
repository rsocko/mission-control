'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUpRight,
  DatabaseZap,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/ui/Modal';
import type { InsightOccurrenceSummaryV1 } from '@/lib/finance-insights/contract';
import type {
  FinanceInsightPresentationState,
  FinanceInsightsPresentationData,
} from './types';
import { FinanceInsightDetail } from './FinanceInsightDetail';
import {
  currentAppHistoryDetail,
  getAppHistorySnapshot,
  pushAppHistoryDetail,
  replaceAppHistoryDetail,
} from '@/lib/navigation/app-history';
import {
  FINANCE_INSIGHT_KIND_LABELS,
  formatFinanceMoney,
  formatFinancePercentage,
  formatFinanceRange,
  formatFinanceTimestamp,
  friendlyFinanceInsightValue,
} from './insight-presentation';

const OCCURRENCE_ID_PATTERN = /^occurrence-v1_[A-Za-z0-9_-]{43}$/;
const GROUPS: Array<{
  kind: InsightOccurrenceSummaryV1['kind'];
  title: string;
  description: string;
}> = [
  {
    kind: 'recurringAmountChange',
    title: 'Recurring changes',
    description: 'Material changes to known recurring obligations.',
  },
  {
    kind: 'largeTransaction',
    title: 'Large transactions',
    description: 'Recent and open transactions above explicit or adaptive thresholds.',
  },
  {
    kind: 'categoryVariance',
    title: 'Category movers',
    description: 'Month-over-month category changes with comparable baselines.',
  },
  {
    kind: 'merchantVariance',
    title: 'Merchant movers',
    description: 'Month-over-month merchant changes with comparable baselines.',
  },
];

function selectedOccurrenceFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('insight');
  return value && OCCURRENCE_ID_PATTERN.test(value) ? value : null;
}

function financeUrlWithInsight(occurrenceId: string | null): string {
  const url = new URL(window.location.href);
  if (occurrenceId) url.searchParams.set('insight', occurrenceId);
  else url.searchParams.delete('insight');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function SpendingInsightsSection({ refreshToken = 0 }: { refreshToken?: number }) {
  const [data, setData] = useState<FinanceInsightsPresentationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const selectedRef = useRef<string | null>(null);

  const load = useCallback(async (manual = false, signal?: AbortSignal) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await fetch('/api/finance/insights/presentation', {
        cache: 'no-store',
        signal,
      });
      if (!result.ok) throw new Error(`Finance insights failed with status ${result.status}`);
      setData(await result.json() as FinanceInsightsPresentationData);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setData({
        contractVersion: '1.0',
        state: 'unavailable',
        transport: 'none',
        authoritative: false,
        sourceAsOf: null,
        collapsedCount: 0,
        items: [],
      });
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // This section owns an isolated request lifecycle independent of overview and health.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load, refreshToken]);

  useEffect(() => {
    const updateSelection = () => {
      const occurrenceId = selectedOccurrenceFromLocation();
      selectedRef.current = occurrenceId;
      setSelectedOccurrenceId(occurrenceId);
    };
    updateSelection();
    window.addEventListener('popstate', updateSelection);
    return () => window.removeEventListener('popstate', updateSelection);
  }, []);

  const openDetail = useCallback((occurrenceId: string) => {
    const replacing = selectedRef.current !== null;
    const currentDetail = currentAppHistoryDetail();
    const detail = {
      kind: 'detail' as const,
      param: 'insight',
      parentHref: currentDetail?.param === 'insight'
        ? currentDetail.parentHref
        : `${window.location.pathname}${window.location.search}${window.location.hash}`,
    };
    if (replacing) {
      replaceAppHistoryDetail(financeUrlWithInsight(occurrenceId), detail);
    } else {
      pushAppHistoryDetail(financeUrlWithInsight(occurrenceId), detail);
    }
    selectedRef.current = occurrenceId;
    setSelectedOccurrenceId(occurrenceId);
  }, []);

  const closeDetail = useCallback(() => {
    const openedHere = currentAppHistoryDetail()?.param === 'insight'
      && getAppHistorySnapshot().canGoBack;
    selectedRef.current = null;
    setSelectedOccurrenceId(null);
    if (openedHere) {
      window.history.back();
    } else {
      replaceAppHistoryDetail(financeUrlWithInsight(null), null);
    }
  }, []);

  return (
    <section aria-labelledby="spending-insights-heading">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-violet-400" aria-hidden="true" />
            <h2 id="spending-insights-heading" className="text-sm font-semibold text-[var(--text-primary)]">
              Spending insights
            </h2>
          </div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Bounded Tyrion comparisons for attention, not a transaction ledger.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || refreshing}
          onClick={() => void load(true)}
          aria-label="Refresh Spending insights"
        >
          <RefreshCw className={refreshing ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {loading ? (
        <InsightState role="status" icon={Loader2} iconClassName="motion-safe:animate-spin">
          Loading Spending insights...
        </InsightState>
      ) : data ? (
        <>
          <PresentationState data={data} />
          {data.items.length > 0 && (
            <div data-testid="finance-insight-groups" className="mt-4 grid gap-4 xl:grid-cols-2">
              {GROUPS.map((group) => (
                <InsightGroup
                  key={group.kind}
                  group={group}
                  items={data.items.filter((item) => item.kind === group.kind).slice(0, 12)}
                  authoritative={data.authoritative}
                  onOpen={openDetail}
                />
              ))}
            </div>
          )}
        </>
      ) : null}

      <Modal
        isOpen={selectedOccurrenceId !== null}
        onClose={closeDetail}
        title="Spending insight details"
        size="xl"
        overlayClassName="items-stretch justify-end pt-0"
        className="h-full max-h-none w-full max-w-full overflow-hidden rounded-none sm:w-[min(42rem,92vw)] sm:rounded-l-2xl sm:rounded-r-none"
        contentTestId="finance-insight-drawer-panel"
      >
        <div data-testid="finance-insight-drawer-scroll" className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {selectedOccurrenceId && (
            <>
              <div className="mb-4 flex justify-end">
                <Link
                  href={`/finance/insights/${encodeURIComponent(selectedOccurrenceId)}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-400)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  Open full page <ArrowUpRight size={13} aria-hidden="true" />
                </Link>
              </div>
              <FinanceInsightDetail occurrenceId={selectedOccurrenceId} context="drawer" />
            </>
          )}
        </div>
      </Modal>
    </section>
  );
}

function PresentationState({ data }: { data: FinanceInsightsPresentationData }) {
  if (data.state === 'connectorUnavailable') {
    return (
      <InsightState role="status" icon={DatabaseZap}>
        Spending insights require exactly one enabled Finance connector. Existing Finance content remains available.
      </InsightState>
    );
  }
  if (data.transport === 'metadata-only') {
    return (
      <InsightState role="status" icon={AlertTriangle} tone="warning">
        Cached insight payloads passed the seven-day display window. {data.collapsedCount.toLocaleString('en-US')} occurrence metadata record{data.collapsedCount === 1 ? '' : 's'} remain, but details are collapsed until Tyrion reconnects.
      </InsightState>
    );
  }
  if (data.state === 'unavailable') {
    return (
      <InsightState role="status" icon={AlertTriangle} tone="warning">
        Spending insights are unavailable. Existing Finance overview, health, digest, and alerts are unchanged.
      </InsightState>
    );
  }
  if (data.items.length === 0 && data.authoritative) {
    return (
      <InsightState role="status" icon={Sparkles} tone="success">
        Tyrion returned an authoritative empty result. No current Spending insights need attention.
      </InsightState>
    );
  }

  const labels: Record<Exclude<FinanceInsightPresentationState, 'connectorUnavailable' | 'unavailable'>, string> = {
    connected: 'Connected — live insight summaries are current.',
    degraded: 'Degraded — current summaries include mixed freshness or cached fallback data.',
    partial: 'Partial — bounded source retrieval was incomplete; available groups remain visible.',
    stale: 'Stale — insight summaries are outside their freshness window.',
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <p role="status" className="text-xs text-[var(--text-secondary)]">{labels[data.state]}</p>
      {data.sourceAsOf && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Source as of <time dateTime={data.sourceAsOf}>{formatFinanceTimestamp(data.sourceAsOf)} UTC</time>
        </p>
      )}
    </div>
  );
}

function InsightGroup({
  group,
  items,
  authoritative,
  onOpen,
}: {
  group: (typeof GROUPS)[number];
  items: InsightOccurrenceSummaryV1[];
  authoritative: boolean;
  onOpen: (occurrenceId: string) => void;
}) {
  return (
    <section aria-labelledby={`finance-insight-group-${group.kind}`} className="min-w-0">
      <div className="mb-2">
        <h3 id={`finance-insight-group-${group.kind}`} className="text-sm font-semibold text-[var(--text-primary)]">
          {group.title}
        </h3>
        <p className="text-xs text-[var(--text-muted)]">{group.description}</p>
      </div>
      {items.length === 0 ? (
        <Card className="p-4 text-sm text-[var(--text-muted)]">
          {authoritative
            ? `No current ${group.title.toLowerCase()}.`
            : `No ${group.title.toLowerCase()} in the available partial response.`}
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <InsightCard key={item.occurrenceId} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

function InsightCard({
  item,
  onOpen,
}: {
  item: InsightOccurrenceSummaryV1;
  onOpen: (occurrenceId: string) => void;
}) {
  return (
    <article aria-label={`${FINANCE_INSIGHT_KIND_LABELS[item.kind]}: ${item.headline}`}>
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{FINANCE_INSIGHT_KIND_LABELS[item.kind]}</Badge>
            <Badge variant={item.severity === 'high' ? 'danger' : item.severity === 'medium' ? 'warning' : 'outline'}>
              {friendlyFinanceInsightValue(item.severity)}
            </Badge>
            <Badge variant="outline">{friendlyFinanceInsightValue(item.confidence)} confidence</Badge>
          </div>
          <CardTitle className="pt-1 text-sm leading-5">{item.headline}</CardTitle>
          <p className="text-xs font-medium text-[var(--text-secondary)]">{item.entity.displayName}</p>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <p className="line-clamp-3 text-xs leading-5 text-[var(--text-muted)]">{item.explanation}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <CompactValue label="Observed" value={formatFinanceMoney(item.observedValue)} />
            <CompactValue label="Expected" value={formatFinanceRange(item.expectedRange)} />
            <CompactValue label="Delta" value={`${formatFinanceMoney(item.absoluteDelta)} · ${formatFinancePercentage(item.percentageDeltaBasisPoints)}`} />
            <CompactValue label="Baseline" value={friendlyFinanceInsightValue(item.baselineSufficiency)} />
            <CompactValue label="Lifecycle" value={item.sourceLifecycle ? friendlyFinanceInsightValue(item.sourceLifecycle) : friendlyFinanceInsightValue(item.analysisState)} />
            <CompactValue label="Freshness" value={friendlyFinanceInsightValue(item.freshness.state)} />
          </dl>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
            <p className="text-[11px] leading-4 text-[var(--text-muted)]">
              Monarch bridge normalized<br />
              Source as of {formatFinanceTimestamp(item.provenance.sourceAsOf)} UTC
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpen(item.occurrenceId)}>
              View details
            </Button>
          </div>
        </CardContent>
      </Card>
    </article>
  );
}

function CompactValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[var(--text-muted)]">{label}</dt>
      <dd className="truncate text-[var(--text-secondary)]" title={value}>{value}</dd>
    </div>
  );
}

function InsightState({
  children,
  icon: Icon,
  iconClassName,
  tone = 'neutral',
  role,
}: {
  children: React.ReactNode;
  icon: typeof Sparkles;
  iconClassName?: string;
  tone?: 'neutral' | 'success' | 'warning';
  role: 'status';
}) {
  const tones = {
    neutral: 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)]',
    success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    warning: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  };
  return (
    <div role={role} className={`flex items-start gap-2 rounded-xl border p-4 text-sm ${tones[tone]}`}>
      <Icon size={17} className={`mt-0.5 shrink-0 ${iconClassName ?? ''}`} aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}
