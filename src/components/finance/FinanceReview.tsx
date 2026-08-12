'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleX,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UserRoundCheck,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { cn } from '@/lib/utils';
import type {
  AttributionException,
  AttributionSubject,
  FinanceOverviewData,
} from './types';

interface ExceptionPage {
  exceptions: AttributionException[];
  nextCursor: string | null;
  subjects: AttributionSubject[];
}

type ExceptionAction = 'approve' | 'manual-resolve' | 'dismiss' | 'retry';

interface PendingConfirmation {
  action: Exclude<ExceptionAction, 'retry'>;
  kidId?: string | null;
  title: string;
  message: string;
  label: string;
}

class ResponseStatusError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with status ${status}`);
  }
}

function friendly(value: string) {
  return value.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function FinanceReview() {
  const [overview, setOverview] = useState<FinanceOverviewData | null>(null);
  const [exceptions, setExceptions] = useState<AttributionException[]>([]);
  const [subjects, setSubjects] = useState<AttributionSubject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [manualKidId, setManualKidId] = useState('');
  const [loading, setLoading] = useState(true);
  const [paginating, setPaginating] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [pageError, setPageError] = useState<{ status: number; message: string } | null>(null);
  const [actionStatus, setActionStatus] = useState('');
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRefresh = useRef<string | null>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);

  const selected = useMemo(
    () => exceptions.find((item) => item.id === selectedId) ?? exceptions[0] ?? null,
    [exceptions, selectedId],
  );
  const subjectNames = useMemo(
    () => new Map(subjects.map((subject) => [subject.kidId, subject.name])),
    [subjects],
  );

  const fetchExceptions = useCallback(async (
    connectorId: string,
    cursor?: string | null,
  ): Promise<ExceptionPage> => {
    const query = new URLSearchParams({ status: 'current', limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(
      `/api/connectors/${encodeURIComponent(connectorId)}/finance/attribution-exceptions?${query}`,
      { cache: 'no-store' },
    );
    if (!response.ok) throw new ResponseStatusError(response.status);
    return response.json() as Promise<ExceptionPage>;
  }, []);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setPageError(null);
    try {
      const overviewResponse = await fetch('/api/finance/overview', { cache: 'no-store' });
      if (!overviewResponse.ok) throw new ResponseStatusError(overviewResponse.status);
      const nextOverview = await overviewResponse.json() as FinanceOverviewData;
      const page = await fetchExceptions(nextOverview.connector.id);
      setOverview(nextOverview);
      setExceptions(page.exceptions);
      setSubjects(page.subjects);
      setNextCursor(page.nextCursor);
      setSelectedId((current) => (
        current && page.exceptions.some((item) => item.id === current)
          ? current
          : page.exceptions[0]?.id ?? null
      ));
      setManualKidId('');
    } catch (error) {
      const status = error instanceof ResponseStatusError ? error.status : 0;
      setPageError({
        status,
        message: status === 403
          ? 'Exception review is restricted to the parent administrator.'
          : status === 404
            ? 'Connect Tyrion to review finance exceptions.'
            : 'Finance exception review could not be loaded.',
      });
    } finally {
      setLoading(false);
    }
  }, [fetchExceptions]);

  useEffect(() => {
    // Initial client hydration starts the same authoritative refresh used after actions.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!focusAfterRefresh.current) return;
    const focusId = focusAfterRefresh.current;
    focusAfterRefresh.current = null;
    window.requestAnimationFrame(() => {
      const nextItem = itemRefs.current.get(focusId) ?? itemRefs.current.values().next().value;
      nextItem?.focus();
    });
  }, [exceptions]);

  const loadMore = async () => {
    if (!overview || !nextCursor || paginating) return;
    setPaginating(true);
    setPageError(null);
    try {
      const page = await fetchExceptions(overview.connector.id, nextCursor);
      setExceptions((current) => [...current, ...page.exceptions]);
      setSubjects(page.subjects);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setActionStatus(error instanceof ResponseStatusError && error.status === 403
        ? 'You no longer have permission to load more exceptions.'
        : 'More exceptions could not be loaded. Try again.');
    } finally {
      setPaginating(false);
    }
  };

  const performAction = async (
    action: ExceptionAction,
    kidId?: string | null,
  ) => {
    if (!overview || !selected || actionPending) return;
    const identity = `${selected.id}:${action}:${kidId ?? ''}`;
    const idempotencyKey = idempotencyKeys.current.get(identity) ?? crypto.randomUUID();
    idempotencyKeys.current.set(identity, idempotencyKey);
    setActionPending(true);
    setActionStatus(`${friendly(action)} in progress...`);

    try {
      const response = await fetch(
        `/api/connectors/${encodeURIComponent(overview.connector.id)}/finance/attribution-exceptions/${encodeURIComponent(selected.id)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(action === 'manual-resolve'
            ? { action, kidId: kidId ?? null, expectedUpdatedAt: selected.updatedAt }
            : { action, expectedUpdatedAt: selected.updatedAt }),
        },
      );
      const body = await response.json().catch(() => ({})) as { code?: string };
      if (!response.ok) {
        if (response.status === 409) {
          setActionStatus(
            body.code === 'unknown_attribution_subject'
              ? 'The Tyrion subject projection changed. The review list has been refreshed.'
              : 'A newer decision already changed this item. The review list has been refreshed.',
          );
          focusAfterRefresh.current = selected.id;
          await loadInitial();
          return;
        }
        if (response.status === 403) {
          setActionStatus('You do not have permission to update this exception.');
          return;
        }
        if (response.status >= 500) {
          setActionStatus('The action failed temporarily. Try again; the same request will be reused safely.');
          return;
        }
        setActionStatus('The action could not be completed.');
        return;
      }

      idempotencyKeys.current.delete(identity);
      const completedLabel = action === 'retry'
        ? 'Retry requested.'
        : action === 'dismiss'
          ? 'Exception dismissed.'
          : 'Attribution decision saved.';
      const currentIndex = exceptions.findIndex((item) => item.id === selected.id);
      const focusCandidate = exceptions[currentIndex + 1]?.id ?? exceptions[currentIndex - 1]?.id ?? null;
      focusAfterRefresh.current = focusCandidate;
      setActionStatus(completedLabel);
      await loadInitial();
    } catch {
      setActionStatus('The action failed temporarily. Try again; the same request will be reused safely.');
    } finally {
      setActionPending(false);
    }
  };

  const requestConfirmation = (
    next: PendingConfirmation,
    trigger: HTMLButtonElement,
  ) => {
    confirmationTrigger.current = trigger;
    setConfirmation(next);
  };

  const cancelConfirmation = () => {
    const trigger = confirmationTrigger.current;
    confirmationTrigger.current = null;
    setConfirmation(null);
    window.requestAnimationFrame(() => trigger?.focus());
  };

  if (loading) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 size={20} className="mr-2 motion-safe:animate-spin" />
        Loading attribution exceptions...
      </div>
    );
  }

  if (pageError) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center px-6 text-center">
        <AlertTriangle size={28} className="mb-3 text-amber-400" />
        <p className="text-sm font-medium text-[var(--text-secondary)]">{pageError.message}</p>
        {pageError.status !== 403 && (
          <button type="button" onClick={() => void loadInitial()} className="mt-4 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white">
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-primary)]">
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-start justify-between gap-3">
          <div>
            <Link href="/finance" className="mb-2 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              <ArrowLeft size={13} /> Finance overview
            </Link>
            <div className="flex items-center gap-2">
              <ShieldAlert size={20} className="text-amber-400" />
              <h1 className="text-lg font-semibold text-[var(--text-primary)]">Attribution exception review</h1>
            </div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Ambiguous attribution, anomalies, mismatches, and failed retries only.
            </p>
          </div>
          {overview && (
            <a href={overview.links.monarch.transactions} target="_blank" rel="noreferrer" className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              Full transactions in Monarch <ExternalLink size={12} />
            </a>
          )}
        </div>
      </header>

      <p aria-live="polite" role="status" className="sr-only">{actionStatus}</p>

      {exceptions.length === 0 ? (
        <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <Check size={30} className="mb-3 text-emerald-400" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">No exceptions need review</h2>
          <p className="mt-1 max-w-md text-sm text-[var(--text-muted)]">Tyrion attribution has no current ambiguous or failed items.</p>
        </main>
      ) : (
        <main className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 lg:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.28fr)]">
          <section aria-labelledby="exception-list-heading" className="min-h-0 overflow-y-auto border-b border-[var(--border)] lg:border-b-0 lg:border-r">
            <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
              <h2 id="exception-list-heading" className="text-sm font-semibold text-[var(--text-primary)]">
                Current exceptions
              </h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">{exceptions.length} loaded</p>
            </div>
            <div role="list" className="divide-y divide-[var(--border-subtle)]">
              {exceptions.map((item) => (
                <div key={item.id} role="listitem">
                  <button
                    ref={(node) => {
                      if (node) itemRefs.current.set(item.id, node);
                      else itemRefs.current.delete(item.id);
                    }}
                    type="button"
                    aria-pressed={selected?.id === item.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      setManualKidId('');
                      setActionStatus('');
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
                      selected?.id === item.id ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-1)]',
                    )}
                  >
                    <AlertTriangle size={16} className="shrink-0 text-amber-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                        {item.merchantName || 'Merchant unavailable'}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
                        {formatDate(item.date)} · {friendly(item.reasonCode)}
                      </span>
                    </span>
                    <ChevronRight size={15} className="shrink-0 text-[var(--text-muted)]" />
                  </button>
                </div>
              ))}
            </div>
            {nextCursor && (
              <div className="p-4">
                <button type="button" onClick={() => void loadMore()} disabled={paginating} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60">
                  {paginating && <Loader2 size={14} className="motion-safe:animate-spin" />}
                  {paginating ? 'Loading more...' : 'Load more'}
                </button>
              </div>
            )}
          </section>

          {selected && (
            <section aria-labelledby="exception-detail-heading" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              <div className="mx-auto max-w-2xl space-y-5">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-amber-300">{friendly(selected.reasonCode)}</p>
                  <h2 id="exception-detail-heading" className="mt-1 text-xl font-semibold text-[var(--text-primary)]">
                    {selected.merchantName || 'Merchant unavailable'}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--text-muted)]">{formatDate(selected.date)}</p>
                </div>

                <dl className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 sm:grid-cols-2">
                  <Detail label="Tyrion suggestion" value={selected.assignedKidId ? subjectNames.get(selected.assignedKidId) || 'Current household member' : 'Parent expense'} />
                  <Detail label="Confidence" value={selected.confidence ? friendly(selected.confidence) : 'Unavailable'} />
                  <Detail label="Decision method" value={selected.method ? friendly(selected.method) : 'Unavailable'} />
                  <Detail label="Observed" value={new Date(selected.lastObservedAt).toLocaleString()} />
                </dl>

                <section aria-labelledby="explanation-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <h3 id="explanation-heading" className="text-sm font-semibold text-[var(--text-primary)]">Tyrion explanation</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                    {selected.explanation || 'No bounded explanation is available.'}
                  </p>
                  {selected.reasons.length > 0 && (
                    <ul className="mt-3 flex flex-wrap gap-2" aria-label="Attribution reasons">
                      {selected.reasons.map((reason) => (
                        <li key={reason} className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200">
                          {friendly(reason)}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section aria-labelledby="decision-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <h3 id="decision-heading" className="text-sm font-semibold text-[var(--text-primary)]">Resolve exception</h3>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Manual choices are limited to the current Tyrion subject projection.</p>

                  <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
                    <div>
                      <label htmlFor="manual-subject" className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                        Manual correction
                      </label>
                      <select
                        id="manual-subject"
                        value={manualKidId}
                        onChange={(event) => setManualKidId(event.target.value)}
                        disabled={actionPending}
                        className="min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <option value="">Choose a current subject</option>
                        <option value="__parent__">Parent expense</option>
                        {subjects.map((subject) => (
                          <option key={subject.kidId} value={subject.kidId}>{subject.name}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      disabled={!manualKidId || actionPending}
                      onClick={(event) => requestConfirmation({
                        action: 'manual-resolve',
                        kidId: manualKidId === '__parent__' ? null : manualKidId,
                        title: 'Confirm manual attribution',
                        message: `Save this as ${manualKidId === '__parent__' ? 'a parent expense' : subjectNames.get(manualKidId) || 'the selected household member'}? This decision takes precedence over future automated attribution.`,
                        label: 'Save decision',
                      }, event.currentTarget)}
                      className="min-h-10 self-end rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
                    >
                      Save correction
                    </button>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-4">
                    <button
                      type="button"
                      disabled={actionPending}
                      onClick={(event) => requestConfirmation({
                        action: 'approve',
                        title: 'Approve Tyrion suggestion',
                        message: `Confirm ${selected.assignedKidId ? subjectNames.get(selected.assignedKidId) || 'the current household member' : 'this parent expense'} as the manual decision?`,
                        label: 'Approve',
                      }, event.currentTarget)}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-50"
                    >
                      <UserRoundCheck size={14} /> Approve suggestion
                    </button>
                    {selected.retryable && (
                      <button
                        type="button"
                        disabled={actionPending}
                        onClick={() => void performAction('retry')}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
                      >
                        <RefreshCw size={14} className={cn(actionPending && 'motion-safe:animate-spin')} /> Retry attribution
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={actionPending}
                      onClick={(event) => requestConfirmation({
                        action: 'dismiss',
                        title: 'Dismiss exception',
                        message: 'Dismiss this exception without changing the current attribution decision?',
                        label: 'Dismiss',
                      }, event.currentTarget)}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs font-medium text-rose-200 focus-visible:ring-2 focus-visible:ring-rose-400 disabled:opacity-50"
                    >
                      <CircleX size={14} /> Dismiss
                    </button>
                  </div>
                  {actionStatus && (
                    <p className="mt-3 text-xs text-[var(--text-secondary)]" aria-hidden="true">
                      {actionPending && <Loader2 size={12} className="mr-1 inline motion-safe:animate-spin" />}
                      {actionStatus}
                    </p>
                  )}
                </section>
              </div>
            </section>
          )}
        </main>
      )}

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        message={confirmation?.message ?? ''}
        confirmLabel={confirmation?.label ?? 'Confirm'}
        confirmVariant="warning"
        onConfirm={() => {
          const pending = confirmation;
          confirmationTrigger.current = null;
          setConfirmation(null);
          if (pending) void performAction(pending.action, pending.kidId);
        }}
        onCancel={cancelConfirmation}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-1 text-sm text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}
