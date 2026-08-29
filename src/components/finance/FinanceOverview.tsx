'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleDollarSign,
  Coins,
  Database,
  ExternalLink,
  HeartPulse,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { AgentAttribution } from '@/components/domains/AgentAttribution';
import { cn } from '@/lib/utils';
import { SpendingInsightsSection } from './SpendingInsightsSection';
import type { FinanceHealth, FinanceOverviewData } from './types';
import { FinanceConnectionWarning } from './FinanceConnectionWarning';

type ProjectionState = FinanceHealth['projection']['aggregate'];
type ProjectionDataset = FinanceHealth['projection']['datasets'][number];

const PROJECTION_DATASETS: Array<{
  id: ProjectionDataset['dataset'];
  label: string;
  kind: string;
}> = [
  { id: 'accounts', label: 'Accounts', kind: 'Reference dataset' },
  { id: 'category-groups', label: 'Category groups', kind: 'Reference dataset' },
  { id: 'categories', label: 'Categories', kind: 'Reference dataset' },
  { id: 'tags', label: 'Tags', kind: 'Reference dataset' },
  { id: 'recurring', label: 'Recurring', kind: 'Current snapshot' },
  { id: 'budgets', label: 'Budgets', kind: 'Current snapshot' },
];

function healthTone(status: string, healthyValues: string[] = ['healthy', 'succeeded', 'connected']) {
  if (healthyValues.includes(status)) return 'text-emerald-300 bg-emerald-400/10 border-emerald-400/30';
  if (['idle', 'disabled', 'unknown'].includes(status)) return 'text-slate-300 bg-slate-400/10 border-slate-400/30';
  return 'text-amber-300 bg-amber-400/10 border-amber-400/30';
}

function projectionTone(state: ProjectionState) {
  if (state === 'fresh') return 'text-emerald-300 bg-emerald-400/10 border-emerald-400/30';
  if (state === 'unavailable') return 'text-slate-300 bg-slate-400/10 border-slate-400/30';
  return 'text-amber-300 bg-amber-400/10 border-amber-400/30';
}

function friendlyStatus(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function projectionState(value: unknown): ProjectionState {
  return value === 'fresh' || value === 'stale' || value === 'partial'
    ? value
    : 'unavailable';
}

function datasetStateLabel(state: ProjectionState, itemCount: number | null) {
  if (state === 'fresh') {
    if (itemCount === null) return 'Fresh, count unavailable';
    return itemCount === 0 ? 'Fresh and empty' : 'Fresh with data';
  }
  return friendlyStatus(state);
}

function datasetGuidance(state: ProjectionState, itemCount: number | null) {
  if (state === 'fresh' && itemCount === 0) {
    return 'Current authoritative result contains no items.';
  }
  if (state === 'fresh') {
    return 'Current projection is available for Finance attention workflows.';
  }
  if (state === 'stale') {
    return 'Last successful data is outside its freshness window. Check connector operations while scheduled sync retries.';
  }
  if (state === 'partial') {
    return 'Coverage is incomplete. Last successful data may remain available; check connector operations.';
  }
  return 'No usable projection is available yet. Confirm the Tyrion Bridge contract and connector health.';
}

function aggregateGuidance(state: ProjectionState) {
  if (state === 'fresh') return 'All six projection datasets are current.';
  if (state === 'stale') return 'All available projection datasets are outside their freshness windows.';
  if (state === 'partial') return 'Projection coverage is mixed or a later dataset attempt failed.';
  return 'No current projection dataset is available.';
}

function warningGuidance(warning: string) {
  const guidance: Record<string, string> = {
    bridge_unavailable: 'Tyrion could not be reached during the latest dataset attempt.',
    dataset_sync_failed: 'The latest dataset attempt did not complete.',
    invalid_contract: 'Tyrion returned an incompatible or oversized dataset contract.',
    invalid_source_timestamp: 'Tyrion returned a source timestamp outside the accepted window.',
    response_too_large: 'The dataset response exceeded Mission Control safety limits.',
    session_in_use: 'Tyrion was busy during the latest dataset attempt.',
    sync_cancelled: 'The latest dataset attempt was cancelled before publication.',
    unsupported_contract: 'The deployed Tyrion Bridge contract is not supported.',
    upstream_error: 'Tyrion could not complete the latest dataset attempt.',
    upstream_rate_limited: 'Tyrion deferred the latest dataset attempt due to rate limits.',
    upstream_timeout: 'Tyrion timed out during the latest dataset attempt.',
  };
  return guidance[warning] ?? 'The latest dataset attempt did not complete.';
}

function validItemCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(timestamp);
}

function formatCoverage(coverage: ProjectionDataset['coverage'] | null | undefined) {
  if (
    !coverage
    || !/^\d{4}-\d{2}-\d{2}$/.test(coverage.start)
    || !/^\d{4}-\d{2}-\d{2}$/.test(coverage.end)
  ) {
    return null;
  }
  return `${coverage.start} to ${coverage.end}`;
}

class ResponseStatusError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with status ${status}`);
  }
}

export function FinanceOverview() {
  const [overview, setOverview] = useState<FinanceOverviewData | null>(null);
  const [health, setHealth] = useState<FinanceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [insightsRefreshToken, setInsightsRefreshToken] = useState(0);

  const load = useCallback(async (refresh = false) => {
    if (refresh) {
      setRefreshing(true);
      setInsightsRefreshToken((value) => value + 1);
    }
    else setLoading(true);
    setError(null);
    setHealthLoading(true);
    setHealthUnavailable(false);
    let nextOverview: FinanceOverviewData;
    try {
      const overviewResponse = await fetch('/api/finance/overview', { cache: 'no-store' });
      if (!overviewResponse.ok) {
        throw new ResponseStatusError(overviewResponse.status);
      }
      nextOverview = await overviewResponse.json() as FinanceOverviewData;
      setOverview(nextOverview);
    } catch (loadError) {
      const status = loadError instanceof ResponseStatusError ? loadError.status : 0;
      setError({
        status,
        message: status === 403
          ? 'Finance access is restricted to the parent administrator.'
          : status === 404
            ? 'Connect Tyrion to use Finance operations.'
            : 'Finance operations could not be loaded.',
      });
      setHealthLoading(false);
      return;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }

    try {
      const healthResponse = await fetch(
        `/api/connectors/${encodeURIComponent(nextOverview.connector.id)}/health`,
        { cache: 'no-store' },
      );
      if (healthResponse.ok) {
        setHealth(await healthResponse.json() as FinanceHealth);
      } else {
        setHealth(null);
        setHealthUnavailable(true);
      }
    } catch {
      setHealth(null);
      setHealthUnavailable(true);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial client hydration starts the same bounded API refresh used by the manual control.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-primary)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Coins size={21} className="text-amber-400" />
              <h1 className="text-lg font-semibold text-[var(--text-primary)]">Finance</h1>
              <AgentAttribution agent="Tyrion" />
            </div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Household attention and exception handling, not a financial ledger.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            aria-label="Refresh Finance operations"
            className="flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
          >
            <RefreshCw size={14} className={cn(refreshing && 'motion-safe:animate-spin')} />
            Refresh
          </button>
        </div>
      </header>

      {loading ? (
        <div role="status" className="flex items-center justify-center py-24 text-sm text-[var(--text-muted)]">
          <Loader2 size={20} className="mr-2 motion-safe:animate-spin" />
          Loading Finance operations...
        </div>
      ) : error ? (
        <div role="alert" className="flex flex-col items-center justify-center px-6 py-24 text-center">
          <AlertTriangle size={28} className="mb-3 text-amber-400" />
          <p className="text-sm font-medium text-[var(--text-secondary)]">{error.message}</p>
          {error.status === 404 && (
            <Link href="/settings/connectors" className="mt-4 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              Open connector settings
            </Link>
          )}
          {error.status !== 403 && (
            <button type="button" onClick={() => void load()} className="mt-3 text-xs font-medium text-[var(--accent-400)] underline-offset-4 hover:underline">
              Try again
            </button>
          )}
        </div>
      ) : overview ? (
        <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
          {health?.recovery && (
            <FinanceConnectionWarning
              connectorId={overview.connector.id}
              recovery={health.recovery}
              onVerified={() => load(true)}
            />
          )}
          <section aria-labelledby="finance-attention-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="finance-attention-heading" className="text-sm font-semibold text-[var(--text-primary)]">
                Needs attention
              </h2>
              <Link href="/finance/review" className="flex items-center gap-1 text-xs font-medium text-[var(--accent-400)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                Review exceptions <ArrowUpRight size={13} />
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <AttentionCard label="Pending exceptions" value={overview.attention.pendingExceptions} icon={ShieldAlert} />
              <AttentionCard label="Retries queued" value={overview.attention.retryRequested} icon={RefreshCw} />
              <AttentionCard label="Open alerts" value={overview.attention.openAlerts} icon={AlertTriangle} />
              <AttentionCard label="Failed write-backs" value={overview.attention.failedWritebacks} icon={CircleDollarSign} />
            </div>
          </section>

          <SpendingInsightsSection refreshToken={insightsRefreshToken} />

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
            <section aria-labelledby="household-digest-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
              <h2 id="household-digest-heading" className="text-sm font-semibold text-[var(--text-primary)]">
                Household digest
              </h2>
              <ul className="mt-3 space-y-2">
                {overview.digest.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                    <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="policy-status-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2">
                <Users size={16} className="text-sky-400" />
                <h2 id="policy-status-heading" className="text-sm font-semibold text-[var(--text-primary)]">
                  Policy and limit status
                </h2>
              </div>
              {overview.subjects.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--text-muted)]">No current Tyrion subject projection is available.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {overview.subjects.map((subject) => (
                    <li key={subject.kidId} className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-2)] px-3 py-2">
                      <span className="truncate text-sm text-[var(--text-secondary)]">{subject.name}</span>
                      <span className="shrink-0 rounded-full border border-slate-400/30 bg-slate-400/10 px-2 py-0.5 text-[11px] font-medium text-slate-300">
                        Policy current · Limit unavailable
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <a href={overview.links.tyrionConfiguration} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-400)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                Configure money policies in Tyrion <ExternalLink size={12} />
              </a>
            </section>
          </div>

          <section aria-labelledby="finance-health-heading">
            <div className="mb-3 flex items-center gap-2">
              <HeartPulse size={16} className="text-rose-400" />
              <h2 id="finance-health-heading" className="text-sm font-semibold text-[var(--text-primary)]">
                Connection health
              </h2>
            </div>
            {healthLoading ? (
              <div role="status" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-muted)]">
                Loading canonical health details…
              </div>
            ) : healthUnavailable || !health ? (
              <div role="status" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
                Health details are temporarily unavailable. Finance attention data may be partial.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <HealthCard label="Bridge reachability" status={health.bridge.reachable ? 'reachable' : 'unreachable'} detail={health.bridge.mode ? `${friendlyStatus(health.bridge.mode)} mode` : 'Mode unavailable'} healthy={health.bridge.reachable} />
                  <HealthCard label="Connector credentials" status={health.bridge.authenticated ? health.bridge.authState : 'authentication required'} detail="Monarch authorization" healthy={health.bridge.authenticated} />
                  <HealthCard label="Transaction snapshot sync" status={health.sync.stale ? 'stale' : health.sync.status} detail={health.sync.activeJob?.retrying ? `Retry ${health.sync.activeJob.attempt + 1} of ${health.sync.activeJob.maxAttempts}` : health.sync.lastSuccessfulSyncAt ? 'Last successful transaction snapshot recorded' : 'No successful transaction snapshot yet'} healthy={health.sync.status === 'succeeded' && !health.sync.stale} />
                  <HealthCard label="Tyrion attribution" status={health.attribution.status} detail={health.attribution.policyVersion ? `Policy projection ${health.attribution.policyVersion}` : 'Policy projection unavailable'} healthy={health.attribution.status === 'healthy'} />
                </div>
                <ProjectionHealth projection={health.projection} />
              </div>
            )}
          </section>

          <section aria-labelledby="finance-alerts-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <h2 id="finance-alerts-heading" className="text-sm font-semibold text-[var(--text-primary)]">Important alerts and obligations</h2>
            </div>
            {overview.alerts.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">No important finance alerts are open.</p>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {overview.alerts.map((alert, index) => (
                  <article key={`${alert.receivedAt}-${index}`} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-medium text-[var(--text-primary)]">{alert.title}</h3>
                        {alert.summary && <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">{alert.summary}</p>}
                      </div>
                      <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px]', healthTone(alert.level, []))}>
                        {friendlyStatus(alert.level)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="monarch-workflows-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <h2 id="monarch-workflows-heading" className="text-sm font-semibold text-[var(--text-primary)]">
              Continue comprehensive money work in Monarch
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(overview.links.monarch).map(([label, href]) => (
                <a key={label} href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium capitalize text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                  {label} <ExternalLink size={12} />
                </a>
              ))}
            </div>
          </section>
        </main>
      ) : null}
    </div>
  );
}

function AttentionCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof ShieldAlert }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
        <Icon size={15} className={value > 0 ? 'text-amber-400' : 'text-emerald-400'} />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

function HealthCard({ label, status, detail, healthy }: { label: string; status: string; detail: string; healthy: boolean }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <h3 className="text-xs font-medium text-[var(--text-muted)]">{label}</h3>
      <span className={cn('mt-2 inline-flex rounded-full border px-2 py-0.5 text-xs font-medium', healthy ? healthTone('healthy') : healthTone(status))}>
        {friendlyStatus(status)}
      </span>
      <p className="mt-2 text-xs text-[var(--text-tertiary)]">{detail}</p>
    </article>
  );
}

function ProjectionHealth({ projection }: { projection: FinanceHealth['projection'] | null | undefined }) {
  const aggregate = projectionState(projection?.aggregate);
  const datasets = Array.isArray(projection?.datasets) ? projection.datasets : [];

  return (
    <section
      aria-labelledby="projection-health-heading"
      className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Database size={16} className="text-violet-400" aria-hidden="true" />
            <h3 id="projection-health-heading" className="text-sm font-semibold text-[var(--text-primary)]">
              Projection dataset health
            </h3>
          </div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Reference and current-snapshot observability, separate from transaction snapshot sync.
          </p>
        </div>
        <div className="text-right">
          <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-medium', projectionTone(aggregate))}>
            {friendlyStatus(aggregate)}
          </span>
          <p className="mt-1 max-w-sm text-xs text-[var(--text-tertiary)]">{aggregateGuidance(aggregate)}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {PROJECTION_DATASETS.map((definition) => (
          <ProjectionDatasetCard
            key={definition.id}
            definition={definition}
            dataset={datasets.find((candidate) => candidate.dataset === definition.id)}
          />
        ))}
      </div>
      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Dataset refreshes run through the authorized connector schedule.{' '}
        <Link
          href="/settings/connectors"
          className="font-medium text-[var(--accent-400)] underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Open connector operations
        </Link>{' '}
        for recovery; manage accounts, budgets, and recurring items in Monarch.
      </p>
    </section>
  );
}

function ProjectionDatasetCard({
  definition,
  dataset,
}: {
  definition: (typeof PROJECTION_DATASETS)[number];
  dataset: ProjectionDataset | undefined;
}) {
  const state = projectionState(dataset?.state);
  const itemCount = validItemCount(dataset?.itemCount);
  const sourceAsOf = formatTimestamp(dataset?.sourceAsOf);
  const freshUntil = formatTimestamp(dataset?.freshUntil);
  const lastSuccessfulAt = formatTimestamp(dataset?.lastSuccessfulAt);
  const coverage = formatCoverage(dataset?.coverage);
  const countLabel = state === 'unavailable' || itemCount === null
    ? 'Unavailable'
    : `${itemCount.toLocaleString('en-US')} ${itemCount === 1 ? 'item' : 'items'}`;

  return (
    <article
      aria-label={`${definition.label} projection health`}
      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-[var(--text-primary)]">{definition.label}</h4>
          <p className="text-[11px] text-[var(--text-muted)]">{definition.kind}</p>
        </div>
        <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', projectionTone(state))}>
          {datasetStateLabel(state, itemCount)}
        </span>
      </div>

      <p className="mt-3 text-xs text-[var(--text-secondary)]">{datasetGuidance(state, itemCount)}</p>
      {dataset?.warning && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span><span className="font-medium">Latest attempt:</span> {warningGuidance(dataset.warning)}</span>
        </p>
      )}

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-[var(--text-muted)]">Item count</dt>
        <dd className="text-right tabular-nums text-[var(--text-secondary)]">{countLabel}</dd>
        <dt className="text-[var(--text-muted)]">Source as of</dt>
        <TimestampValue value={dataset?.sourceAsOf} label={sourceAsOf} />
        <dt className="text-[var(--text-muted)]">Fresh until</dt>
        <TimestampValue value={dataset?.freshUntil} label={freshUntil} />
        <dt className="text-[var(--text-muted)]">Last successful</dt>
        <TimestampValue value={dataset?.lastSuccessfulAt} label={lastSuccessfulAt} />
        {coverage && (
          <>
            <dt className="text-[var(--text-muted)]">Coverage</dt>
            <dd className="text-right text-[var(--text-secondary)]">{coverage}</dd>
          </>
        )}
      </dl>
    </article>
  );
}

function TimestampValue({ value, label }: { value: string | null | undefined; label: string | null }) {
  return (
    <dd className="text-right text-[var(--text-secondary)]">
      {value && label ? <time dateTime={value}>{label} UTC</time> : 'Not available'}
    </dd>
  );
}
