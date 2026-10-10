'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Landmark,
  Loader2,
  RefreshCw,
  Scale,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { cn } from '@/lib/utils';
import {
  httpReceiptReconciliationClient,
  ReceiptReconciliationClientError,
  type ReceiptReconciliationClient,
} from '@/lib/receipt-reconciliation/client';
import type {
  PaymentCaseAction,
  PaymentReviewActionRequest,
  PaymentReviewItem,
  PaymentReviewPage,
} from '@/lib/receipt-reconciliation/contract';

interface Props {
  initialReviewId?: string | null;
  client?: ReceiptReconciliationClient;
}

interface PendingAction {
  action: PaymentReviewActionRequest['action'];
  title: string;
  message: string;
  label: string;
}

const CASE_LABELS: Record<PaymentReviewItem['caseKind'], string> = {
  unmatched: 'Unmatched',
  ambiguous: 'Ambiguous match',
  source_unavailable: 'Source unavailable',
  projection_failed: 'Projection failed',
  stale: 'Stale evidence',
  conflict: 'Conflicting evidence',
  not_applicable: 'Not applicable',
  partial_payment: 'Partial payment',
  double_payment: 'Possible double payment',
};

const ACTION_LABELS: Partial<Record<PaymentCaseAction, string>> = {
  confirm: 'Confirm evidence',
  reject: 'Reject evidence',
  clear: 'Clear relationship',
  defer: 'Keep waiting',
  reopen: 'Reopen review',
  mark_not_applicable: 'Mark not applicable',
};

function money(amountMinor: number | null, currency: string | null): string {
  if (amountMinor === null || currency === null) return 'Unavailable';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(amountMinor / 100);
}

function title(item: PaymentReviewItem): string {
  return item.evidence?.payeeHint ?? CASE_LABELS[item.caseKind];
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('input, textarea, select, [role="dialog"], [contenteditable="true"]'));
}

export function ReceiptReconciliationReview({
  initialReviewId = null,
  client = httpReceiptReconciliationClient,
}: Props) {
  const [page, setPage] = useState<PaymentReviewPage | null>(null);
  const [selectedId, setSelectedId] = useState(initialReviewId);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const retryKeys = useRef(new Map<string, string>());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const emptyRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRefresh = useRef<string | null | undefined>(undefined);

  const selected = useMemo(
    () => page?.items.find((item) => item.id === selectedId)
      ?? page?.items[0]
      ?? null,
    [page, selectedId],
  );

  const selectReview = useCallback((reviewId: string | null) => {
    setSelectedId(reviewId);
    const url = new URL(window.location.href);
    if (reviewId) url.searchParams.set('review', reviewId);
    else url.searchParams.delete('review');
    window.history.replaceState(null, '', url);
  }, []);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const next = await client.list(0);
      setPage(next);
      setSelectedId((current) => (
        current && next.items.some((item) => item.id === current)
          ? current
          : next.items[0]?.id ?? null
      ));
      if (refresh) setAnnouncement('Receipt reconciliation refreshed from OWL.');
    } catch (loadError) {
      setError(loadError instanceof ReceiptReconciliationClientError
        ? loadError.message
        : 'Receipt reconciliation could not be loaded.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focusAfterRefresh.current === undefined) return;
    const target = focusAfterRefresh.current;
    focusAfterRefresh.current = undefined;
    window.requestAnimationFrame(() => {
      const row = target ? rowRefs.current.get(target) : undefined;
      if (row) row.focus();
      else emptyRef.current?.focus();
    });
  }, [page]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || !page?.items.length) return;
      const direction = event.key === 'ArrowDown' || event.key === 'j'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'k'
          ? -1
          : 0;
      if (direction === 0) return;
      event.preventDefault();
      const index = Math.max(0, page.items.findIndex((item) => item.id === selected?.id));
      const next = page.items[Math.min(page.items.length - 1, Math.max(0, index + direction))];
      if (next) {
        selectReview(next.id);
        rowRefs.current.get(next.id)?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page, selectReview, selected?.id]);

  const submit = async (action: PendingAction['action']) => {
    if (!selected || saving) return;
    const sourceAction = selected.sourceActions.find((candidate) => candidate.id === action);
    if (!sourceAction) return;
    const request: PaymentReviewActionRequest = {
      action,
      expectedRevision: selected.revision,
      ...(['confirm', 'reject', 'clear', 'mark_not_applicable'].includes(action)
        && selected.evidence ? { evidenceId: selected.evidence.id } : {}),
      ...(action === 'defer'
        ? { deferUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString() } : {}),
    };
    const identity = `${selected.id}:${selected.revision}:${JSON.stringify(request)}`;
    const idempotencyKey = retryKeys.current.get(identity)
      ?? `mc:payment-review:${crypto.randomUUID()}`;
    retryKeys.current.set(identity, idempotencyKey);
    setSaving(true);
    setPendingAction(null);
    setAnnouncement(`${ACTION_LABELS[action] ?? 'Receipt action'} in progress.`);
    const index = page?.items.findIndex((item) => item.id === selected.id) ?? 0;
    try {
      const result = await client.act(selected.id, request, idempotencyKey);
      retryKeys.current.delete(identity);
      const refreshed = await client.list(0);
      setPage(refreshed);
      const currentStillPresent = refreshed.items.some((item) => item.id === result.item.id);
      const nextFocus = currentStillPresent
        ? result.item.id
        : refreshed.items[index]?.id ?? refreshed.items[index - 1]?.id ?? null;
      selectReview(nextFocus);
      focusAfterRefresh.current = nextFocus;
      setAnnouncement(
        `${ACTION_LABELS[action] ?? 'Receipt action'} verified by OWL${result.idempotent ? ' from the original request' : ''}.`,
      );
    } catch (actionError) {
      if (actionError instanceof ReceiptReconciliationClientError) {
        if (!actionError.status || actionError.status >= 500) {
          setAnnouncement(`${actionError.message} Retry will reuse the same request safely.`);
        } else {
          retryKeys.current.delete(identity);
          setAnnouncement(actionError.message);
        }
        if (actionError.current && actionError.status === 409) {
          setPage((current) => current && ({
            ...current,
            items: current.items.map((item) => (
              item.id === actionError.current?.id ? actionError.current : item
            )),
          }));
          selectReview(actionError.current.id);
          focusAfterRefresh.current = actionError.current.id;
        }
      } else {
        setAnnouncement('The receipt action failed temporarily. Retry will reuse the same request safely.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 size={20} className="mr-2 motion-safe:animate-spin" />
        Loading receipt reconciliation...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-primary)]">
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-start justify-between gap-3">
          <div>
            <Link href="/finance" className="mb-2 inline-flex min-h-8 items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              <ArrowLeft size={13} aria-hidden="true" /> Finance overview
            </Link>
            <div className="flex items-center gap-2">
              <Scale size={20} className="text-cyan-400" aria-hidden="true" />
              <h1 className="text-lg font-semibold text-[var(--text-primary)]">Receipt reconciliation</h1>
            </div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Exceptions only. OWL owns documents, relationships, corrections, and settlement history.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
          >
            <RefreshCw size={14} className={cn(refreshing && 'motion-safe:animate-spin')} />
            Refresh
          </button>
        </div>
      </header>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      {error ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <AlertTriangle size={28} className="mb-3 text-amber-400" />
          <p className="text-sm text-[var(--text-secondary)]">{error}</p>
          <button type="button" onClick={() => void load()} className="mt-4 min-h-10 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-white">
            Try again
          </button>
        </div>
      ) : page?.state === 'unavailable' ? (
        <div role="status" className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <FileText size={28} className="mb-3 text-[var(--text-muted)]" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">OWL is not connected</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{page.unavailableReason}</p>
        </div>
      ) : !page || page.items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <Check size={30} className="mb-3 text-emerald-400" />
          <h2 ref={emptyRef} tabIndex={-1} className="text-base font-semibold text-[var(--text-primary)]">
            No receipt exceptions need review
          </h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Normal processing and verified relationships remain suppressed.
          </p>
        </div>
      ) : (
        <main className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 lg:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.28fr)]">
          <section aria-labelledby="receipt-list-heading" className="min-h-0 overflow-y-auto border-b border-[var(--border)] lg:border-b-0 lg:border-r">
            <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
              <h2 id="receipt-list-heading" className="text-sm font-semibold text-[var(--text-primary)]">Current exceptions</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {page.items.length} loaded · Use ↑/↓ or j/k to move
              </p>
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {page.items.map((item) => (
                <button
                  key={item.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(item.id, node);
                    else rowRefs.current.delete(item.id);
                  }}
                  type="button"
                  aria-pressed={selected?.id === item.id}
                  onClick={() => selectReview(item.id)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
                    selected?.id === item.id ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-1)]',
                  )}
                >
                  <AlertTriangle size={16} className="shrink-0 text-amber-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{title(item)}</span>
                    <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                      {CASE_LABELS[item.caseKind]} · {item.evidence?.paymentStatus ?? 'Evidence unavailable'}
                    </span>
                  </span>
                  <ChevronRight size={15} className="text-[var(--text-muted)]" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>

          {selected && (
            <section aria-labelledby="receipt-detail-heading" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              <div className="mx-auto max-w-3xl space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">{CASE_LABELS[selected.caseKind]}</p>
                  <h2 id="receipt-detail-heading" className="mt-1 text-xl font-semibold text-[var(--text-primary)]">{title(selected)}</h2>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    State: {selected.state} · Revision {selected.revision} · Attention {selected.attentionState}
                  </p>
                </div>

                <EvidenceSection
                  icon={<FileText size={15} className="text-cyan-400" />}
                  title="Document evidence — OWL / Paperless"
                  rows={selected.evidence && ['receipt', 'bill', 'invoice'].includes(selected.evidence.kind)
                    ? [
                        ['Kind', selected.evidence.kind],
                        ['Payee hint', selected.evidence.payeeHint ?? 'Unavailable'],
                        ['Amount', money(selected.evidence.amountMinor, selected.evidence.currency)],
                        ['Evidence date', selected.evidence.evidenceDate ?? 'Unavailable'],
                      ]
                    : [['Evidence', 'No document evidence is available for this exception.']]}
                />
                <EvidenceSection
                  icon={<Landmark size={15} className="text-amber-400" />}
                  title="Transaction evidence — Tyrion / Monarch"
                  rows={selected.evidence && ['posted_transaction', 'pending_transaction'].includes(selected.evidence.kind)
                    ? [
                        ['Kind', selected.evidence.kind],
                        ['Payee hint', selected.evidence.payeeHint ?? 'Unavailable'],
                        ['Amount', money(selected.evidence.amountMinor, selected.evidence.currency)],
                        ['Payment state', selected.evidence.paymentStatus],
                      ]
                    : [
                        ['Source', selected.evidence?.sourceSystem.replaceAll('_', ' ') ?? 'Unavailable'],
                        ['Match state', selected.evidence?.matchState.replaceAll('_', ' ') ?? 'Unavailable'],
                        ['Confidence', selected.evidence?.confidence ?? 'Unavailable'],
                        ['Reason codes', selected.evidence?.reasonCodes.join(', ') || 'None supplied'],
                      ]}
                />

                <section aria-labelledby="receipt-decision-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 id="receipt-decision-heading" className="text-sm font-semibold text-[var(--text-primary)]">Mission Control decision</h3>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        Actions write to OWL. Local dismissal never deletes evidence or settles the relationship.
                      </p>
                    </div>
                    <a
                      href={selected.owlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-9 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs font-medium text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      Open in OWL <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </div>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <Detail label="Obligation state" value={selected.obligation.status} />
                    <Detail label="Expected amount" value={money(selected.obligation.expectedAmountMinor, selected.obligation.currency)} />
                    <Detail label="Evidence edge" value={selected.evidence?.edgeState ?? 'Unavailable'} />
                    <Detail label="Completion suggested" value={selected.obligation.completionSuggested ? 'Yes — source completion still required' : 'No'} />
                  </dl>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selected.sourceActions
                      .filter((action) => action.id in ACTION_LABELS)
                      .map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          disabled={saving}
                          onClick={() => setPendingAction({
                            action: action.id as PendingAction['action'],
                            title: ACTION_LABELS[action.id] ?? 'Confirm receipt action',
                            message: `OWL will apply ${ACTION_LABELS[action.id]?.toLowerCase() ?? action.id} at revision ${selected.revision}, then Mission Control will verify the authoritative read-back.`,
                            label: ACTION_LABELS[action.id] ?? action.id,
                          })}
                          className="min-h-10 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-semibold text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
                        >
                          {saving ? 'Saving…' : ACTION_LABELS[action.id]}
                        </button>
                      ))}
                  </div>
                </section>
              </div>
            </section>
          )}
        </main>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.title ?? ''}
        message={pendingAction?.message ?? ''}
        confirmLabel={pendingAction?.label ?? 'Confirm'}
        confirmVariant="warning"
        onCancel={() => setPendingAction(null)}
        onConfirm={() => pendingAction && void submit(pendingAction.action)}
      />
    </div>
  );
}

function EvidenceSection({
  icon,
  title: heading,
  rows,
}: {
  icon: React.ReactNode;
  title: string;
  rows: string[][];
}) {
  const id = heading.toLowerCase().replaceAll(/[^a-z]+/g, '-');
  return (
    <section aria-labelledby={id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="flex items-center gap-2">
        {icon}
        <h3 id={id} className="text-sm font-semibold text-[var(--text-primary)]">{heading}</h3>
      </div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {rows.map(([label, value]) => <Detail key={label} label={label} value={value} />)}
      </dl>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-1 text-sm text-[var(--text-secondary)]">{value.replaceAll('_', ' ')}</dd>
    </div>
  );
}
