'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FileSearch,
  Loader2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { FinanceInsightDetailData } from './types';
import {
  FINANCE_INSIGHT_KIND_LABELS,
  formatFinanceDateRange,
  formatFinanceMoney,
  formatFinancePercentage,
  formatFinanceRange,
  formatFinanceTimestamp,
  friendlyFinanceInsightValue,
} from './insight-presentation';

export interface FinanceInsightDetailProps {
  occurrenceId: string;
  context: 'drawer' | 'route';
}

class FinanceInsightDetailResponseError extends Error {
  constructor(readonly status: number) {
    super(`Finance insight detail failed with status ${status}`);
  }
}

export function FinanceInsightDetail({
  occurrenceId,
  context,
}: FinanceInsightDetailProps) {
  const [data, setData] = useState<FinanceInsightDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setErrorStatus(null);
    try {
      const result = await fetch(
        `/api/finance/insights/${encodeURIComponent(occurrenceId)}`,
        { cache: 'no-store', signal },
      );
      if (!result.ok) throw new FinanceInsightDetailResponseError(result.status);
      setData(await result.json() as FinanceInsightDetailData);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setData(null);
      setErrorStatus(error instanceof FinanceInsightDetailResponseError ? error.status : 0);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [occurrenceId]);

  useEffect(() => {
    const controller = new AbortController();
    // Initial hydration starts the same bounded live-detail request used by retry.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return (
      <div role="status" className="flex min-h-48 items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 motion-safe:animate-spin" size={18} />
        Loading live insight detail...
      </div>
    );
  }

  if (!data || errorStatus !== null) {
    return (
      <div role="alert" className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
        <AlertTriangle className="mb-3 text-amber-400" size={24} />
        <p className="text-sm font-medium text-[var(--text-secondary)]">
          {errorStatus === 404
            ? 'This insight occurrence is no longer available.'
            : 'Live insight detail is temporarily unavailable.'}
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return <FinanceInsightDetailContent data={data} context={context} />;
}

export function FinanceInsightDetailContent({
  data,
  context,
}: {
  data: FinanceInsightDetailData;
  context: FinanceInsightDetailProps['context'];
}) {
  const { detail } = data;
  return (
    <article aria-labelledby={`finance-insight-${context}-heading`} className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{FINANCE_INSIGHT_KIND_LABELS[detail.kind]}</Badge>
          <Badge variant={detail.severity === 'high' ? 'danger' : detail.severity === 'medium' ? 'warning' : 'outline'}>
            {friendlyFinanceInsightValue(detail.severity)} severity
          </Badge>
          <Badge variant="outline">{friendlyFinanceInsightValue(detail.confidence)} confidence</Badge>
        </div>
        <h2 id={`finance-insight-${context}-heading`} className="mt-3 text-xl font-semibold text-[var(--text-primary)]">
          {detail.headline}
        </h2>
        <p className="mt-1 text-sm font-medium text-[var(--text-secondary)]">{detail.entity.displayName}</p>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{detail.explanation}</p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Current comparison</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <DetailValue label="Observed" value={formatFinanceMoney(detail.observedValue)} />
            <DetailValue label="Expected" value={formatFinanceRange(detail.expectedRange)} />
            <DetailValue label="Absolute delta" value={formatFinanceMoney(detail.absoluteDelta)} />
            <DetailValue label="Relative delta" value={formatFinancePercentage(detail.percentageDeltaBasisPoints)} />
            <DetailValue label="Observation period" value={formatFinanceDateRange(detail.observationPeriod)} />
            <DetailValue label="Baseline period" value={formatFinanceDateRange(detail.baselinePeriod)} />
          </dl>
        </CardContent>
      </Card>

      <section aria-labelledby={`finance-insight-${context}-status`}>
        <h3 id={`finance-insight-${context}-status`} className="text-sm font-semibold text-[var(--text-primary)]">
          Status and provenance
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <DetailValue label="Source lifecycle" value={detail.sourceLifecycle ? friendlyFinanceInsightValue(detail.sourceLifecycle) : 'Not qualified'} />
          <DetailValue label="Analysis state" value={friendlyFinanceInsightValue(detail.analysisState)} />
          <DetailValue label="Baseline sufficiency" value={friendlyFinanceInsightValue(detail.baselineSufficiency)} />
          <DetailValue label="Freshness" value={friendlyFinanceInsightValue(detail.freshness.state)} />
          <DetailValue label="Source as of" value={`${formatFinanceTimestamp(detail.provenance.sourceAsOf)} UTC`} />
          <DetailValue label="Source coverage" value={formatFinanceDateRange({
            start: detail.provenance.coverageStart,
            end: detail.provenance.coverageEnd,
          })} />
        </div>
        <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs leading-5 text-[var(--text-muted)]">
          Dismissing or snoozing a Mission Control notification changes only its local visibility.
          Tyrion&apos;s source lifecycle remains {detail.sourceLifecycle ?? detail.analysisState}.
        </p>
      </section>

      {detail.baseline && (
        <section aria-labelledby={`finance-insight-${context}-baseline`}>
          <h3 id={`finance-insight-${context}-baseline`} className="text-sm font-semibold text-[var(--text-primary)]">
            Baseline evidence
          </h3>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <DetailValue label="Method" value={friendlyFinanceInsightValue(detail.baseline.method)} />
            <DetailValue label="Window" value={formatFinanceDateRange({
              start: detail.baseline.windowStart,
              end: detail.baseline.windowEnd,
            })} />
            <DetailValue label="Samples" value={detail.baseline.sampleCount.toLocaleString('en-US')} />
            <DetailValue label="Active periods" value={detail.baseline.activePeriodCount.toLocaleString('en-US')} />
          </dl>
        </section>
      )}

      <BoundedList
        id={`finance-insight-${context}-comparisons`}
        title="Comparisons"
        empty="No comparison periods were supplied by the live detail."
        items={detail.comparisons.slice(0, 36).map((comparison) => ({
          key: `${comparison.period.start}-${comparison.period.end}`,
          title: formatFinanceDateRange(comparison.period),
          body: `${formatFinanceMoney(comparison.value)} · ${friendlyFinanceInsightValue(comparison.contribution)}`,
        }))}
      />

      <BoundedList
        id={`finance-insight-${context}-contributors`}
        title="Top contributors"
        empty="No contributors were supplied by the live detail."
        items={detail.contributors.slice(0, 10).map((contributor) => ({
          key: `${contributor.rank}-${contributor.sourceRef}`,
          title: `${contributor.rank}. ${contributor.displayName}`,
          body: `${contributor.occurredOn} · ${formatFinanceMoney(contributor.amount)} · contribution ${formatFinanceMoney({
            currency: contributor.amount.currency,
            amountMinor: contributor.contributionMinor,
          })}`,
        }))}
      />

      <BoundedList
        id={`finance-insight-${context}-evidence`}
        title="Supporting evidence"
        empty="No optional supporting evidence was supplied by the live detail."
        items={detail.evidence.slice(0, 8).map((evidence, index) => ({
          key: `${evidence.observedAt}-${index}`,
          title: friendlyFinanceInsightValue(evidence.evidenceType),
          body: `${friendlyFinanceInsightValue(evidence.source)} · ${formatFinanceTimestamp(evidence.observedAt)} UTC`,
        }))}
        icon
      />

      {data.externalLinks.length > 0 && (
        <section aria-labelledby={`finance-insight-${context}-actions`}>
          <h3 id={`finance-insight-${context}-actions`} className="text-sm font-semibold text-[var(--text-primary)]">
            Continue in source
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {data.externalLinks.slice(0, 4).map((link) => (
              <Button key={`${link.system}-${link.url}`} asChild variant="outline" size="sm">
                <a href={link.url} target="_blank" rel="noreferrer">
                  {link.label} <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

export function FinanceInsightRoute({ occurrenceId }: { occurrenceId: string }) {
  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-primary)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <Link
            href="/finance"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            Finance
          </Link>
          <span className="text-xs text-[var(--text-muted)]">Live occurrence detail</span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-4 sm:p-6">
        <FinanceInsightDetail occurrenceId={occurrenceId} context="route" />
      </main>
    </div>
  );
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3">
      <dt className="text-xs font-medium text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-1 text-sm text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

function BoundedList({
  id,
  title,
  empty,
  items,
  icon = false,
}: {
  id: string;
  title: string;
  empty: string;
  items: Array<{ key: string; title: string; body: string }>;
  icon?: boolean;
}) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--text-muted)]">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.key} className="flex gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3">
              {icon && <FileSearch className="mt-0.5 shrink-0 text-sky-400" size={15} aria-hidden="true" />}
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">{item.title}</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
