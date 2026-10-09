'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  FileQuestion,
  FileSearch,
  Landmark,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from 'lucide-react';
import { AgentAttribution } from '@/components/domains/AgentAttribution';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  httpPayeeDocumentReviewClient,
  PayeeDocumentReviewClientError,
  type PayeeDocumentReviewClient,
} from '@/lib/payee-document-review/client';
import type {
  PayeeClassification,
  PayeeDocumentReviewDecision,
  PayeeDocumentReviewItem,
  PayeeDocumentReviewSnapshot,
} from '@/lib/payee-document-review/contract';

interface PayeeDocumentReviewProps {
  client?: PayeeDocumentReviewClient;
}

const CLASSIFICATION_LABELS: Record<PayeeClassification, string> = {
  'recurring-fixed': 'Recurring, stable amount',
  'recurring-variable': 'Recurring, variable amount',
  regular: 'Regular activity',
  infrequent: 'Infrequent activity',
  'single-observation': 'Single observation',
  unknown: 'Pattern unknown',
};

function formatDate(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : value;
}

function formatConfidence(value: number | null) {
  if (value === null) return 'Not scored';
  return `${Math.round(value * 100)}%`;
}

function policyLabel(item: PayeeDocumentReviewItem) {
  if (item.documentPolicy.status === 'mapped') {
    return item.documentPolicy.correspondentName || 'Mapped';
  }
  if (item.documentPolicy.status === 'not-expected') return 'No documents expected';
  if (item.documentPolicy.status === 'unavailable') return 'OWL unavailable';
  return 'Needs review';
}

export function PayeeDocumentReview({
  client = httpPayeeDocumentReviewClient,
}: PayeeDocumentReviewProps) {
  const [snapshot, setSnapshot] = useState<PayeeDocumentReviewSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCorrespondentRef, setSelectedCorrespondentRef] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [confirmNoDocuments, setConfirmNoDocuments] = useState(false);

  const selected = useMemo(
    () => snapshot?.items.find((item) => item.candidateId === selectedId)
      ?? snapshot?.items[0]
      ?? null,
    [selectedId, snapshot],
  );

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    setStatusMessage('');
    try {
      const nextSnapshot = await client.load();
      setSnapshot(nextSnapshot);
      const nextSelected = nextSnapshot.items[0] ?? null;
      setSelectedId(nextSelected?.candidateId ?? null);
      setSelectedCorrespondentRef(nextSelected?.documentPolicy.correspondentRef ?? '');
    } catch (loadError) {
      const status = loadError instanceof PayeeDocumentReviewClientError
        ? loadError.status
        : 0;
      setError({
        status,
        message: status === 403
          ? 'Payee document review is restricted to the parent administrator.'
          : 'Payee document review could not be loaded.',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    // Initial hydration uses the same bounded adapter refresh as the manual control.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function submitDecision(decision: PayeeDocumentReviewDecision) {
    setSaving(true);
    setError(null);
    setStatusMessage('');
    try {
      const result = await client.decide(decision);
      setSnapshot((current) => current
        ? {
            ...current,
            items: current.items.map((item) => (
              item.candidateId === result.candidateId
                ? {
                    ...item,
                    documentPolicy: {
                      ...result.documentPolicy,
                      correspondentName: result.documentPolicy.correspondentRef
                        ? current.correspondents.find((correspondent) => (
                            correspondent.correspondentRef
                            === result.documentPolicy.correspondentRef
                          ))?.name ?? null
                        : null,
                    },
                  }
                : item
            )),
          }
        : current);
      setStatusMessage(
        decision.decision === 'map-correspondent'
          ? 'Paperless correspondent mapping saved.'
          : 'Marked as no documents expected.',
      );
    } catch (saveError) {
      setStatusMessage(saveError instanceof PayeeDocumentReviewClientError
        ? saveError.message
        : 'The review decision could not be saved. Try again.');
    } finally {
      setSaving(false);
      setConfirmNoDocuments(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-primary)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              href="/finance"
              className="mb-2 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-[var(--text-muted)] underline-offset-4 hover:text-[var(--text-primary)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <ArrowLeft size={13} aria-hidden="true" />
              Finance
            </Link>
            <div className="flex flex-wrap items-center gap-2.5">
              <FileSearch size={21} className="text-cyan-400" aria-hidden="true" />
              <h1 className="text-lg font-semibold text-[var(--text-primary)]">
                Payee document review
              </h1>
              <AgentAttribution agent="Tyrion" />
              <AgentAttribution agent="OWL" />
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--text-muted)]">
              Connect financial payee patterns to Paperless correspondents without exposing
              transactions or assuming that repeated charges produce repeated documents.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            aria-label="Refresh payee document review"
            className="mt-1 inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
          >
            <RefreshCw size={14} className={cn(refreshing && 'motion-safe:animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </header>

      {loading ? (
        <ReviewLoading />
      ) : error ? (
        <ReviewError error={error} onRetry={() => void load()} />
      ) : snapshot?.state === 'unavailable' ? (
        <UnavailableState reason={snapshot.unavailableReason} onRetry={() => void load()} />
      ) : snapshot?.state === 'empty' || !snapshot || snapshot.items.length === 0 ? (
        <EmptyState sourceAsOf={snapshot?.sourceAsOf ?? null} />
      ) : (
        <main className="mx-auto max-w-7xl p-4 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--text-muted)]">
              {snapshot.items.length} {snapshot.items.length === 1 ? 'candidate' : 'candidates'}
              {snapshot.sourceAsOf ? ` · Source current as of ${new Date(snapshot.sourceAsOf).toLocaleString()}` : ''}
            </p>
            <p className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <ShieldCheck size={13} className="text-emerald-400" aria-hidden="true" />
              Bounded evidence only - no transaction ledger
            </p>
          </div>

          <div className="grid min-h-[34rem] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] lg:grid-cols-[minmax(280px,0.78fr)_minmax(0,1.6fr)]">
            <section
              aria-label="Payee candidates"
              className="border-b border-[var(--border)] lg:border-b-0 lg:border-r"
            >
              <div className="border-b border-[var(--border-subtle)] px-4 py-3">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">Candidates</h2>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  Tyrion patterns awaiting document policy review.
                </p>
              </div>
              <div className="divide-y divide-[var(--border-subtle)]">
                {snapshot.items.map((item) => {
                  const active = item.candidateId === selected?.candidateId;
                  return (
                    <button
                      key={item.candidateId}
                      type="button"
                      onClick={() => {
                        setSelectedId(item.candidateId);
                        setSelectedCorrespondentRef(
                          item.documentPolicy.correspondentRef ?? '',
                        );
                      }}
                      aria-pressed={active}
                      className={cn(
                        'w-full px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
                        active ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-0)]',
                      )}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                            {item.pattern.displayName}
                          </span>
                          <span className="mt-1 block text-xs text-[var(--text-muted)]">
                            {CLASSIFICATION_LABELS[item.pattern.classification]}
                            {' · '}
                            {item.pattern.observationCount} observations
                          </span>
                        </span>
                        <span className={cn(
                          'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                          item.documentPolicy.status === 'mapped'
                            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                            : item.documentPolicy.status === 'not-expected'
                              ? 'border-slate-400/30 bg-slate-400/10 text-slate-300'
                              : 'border-amber-400/30 bg-amber-400/10 text-amber-300',
                        )}>
                          {policyLabel(item)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {selected && (
              <section aria-labelledby="selected-payee-heading" className="min-w-0 bg-[var(--surface-0)]">
                <div className="border-b border-[var(--border)] px-4 py-4 sm:px-5">
                  <h2 id="selected-payee-heading" className="text-base font-semibold text-[var(--text-primary)]">
                    {selected.pattern.displayName}
                  </h2>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Review each source on its own terms, then choose the document policy.
                  </p>
                </div>

                <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-2">
                  <TyrionEvidence item={selected} />
                  <OwlPolicy
                    item={selected}
                    correspondents={snapshot.correspondents}
                    selectedCorrespondentRef={selectedCorrespondentRef}
                    onCorrespondentChange={setSelectedCorrespondentRef}
                    saving={saving}
                    onMap={() => {
                      if (!selectedCorrespondentRef) return;
                      void submitDecision({
                        candidateId: selected.candidateId,
                        decision: 'map-correspondent',
                        correspondentRef: selectedCorrespondentRef,
                      });
                    }}
                    onNoDocuments={() => setConfirmNoDocuments(true)}
                  />
                </div>

                <div aria-live="polite" aria-atomic="true" className="min-h-11 px-4 pb-4 sm:px-5">
                  {statusMessage && (
                    <p className={cn(
                      'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs',
                      statusMessage.includes('saved') || statusMessage.startsWith('Marked')
                        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                        : 'border-amber-400/30 bg-amber-400/10 text-amber-200',
                    )}>
                      {(statusMessage.includes('saved') || statusMessage.startsWith('Marked'))
                        && <Check size={13} aria-hidden="true" />}
                      {statusMessage}
                    </p>
                  )}
                </div>
              </section>
            )}
          </div>
        </main>
      )}

      {selected && (
        <ConfirmDialog
          open={confirmNoDocuments}
          title="Mark no documents expected?"
          message={`OWL will record that ${selected.pattern.displayName} does not currently require a document expectation. This does not change Tyrion's financial pattern evidence.`}
          confirmLabel="Mark no documents expected"
          confirmVariant="warning"
          onCancel={() => setConfirmNoDocuments(false)}
          onConfirm={() => void submitDecision({
            candidateId: selected.candidateId,
            decision: 'no-documents-expected',
          })}
        />
      )}
    </div>
  );
}

function TyrionEvidence({ item }: { item: PayeeDocumentReviewItem }) {
  const { pattern } = item;
  return (
    <section aria-labelledby="tyrion-evidence-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <Landmark size={15} className="text-amber-400" aria-hidden="true" />
        <div>
          <h3 id="tyrion-evidence-heading" className="text-sm font-semibold text-[var(--text-primary)]">
            Financial pattern evidence
          </h3>
          <p className="text-xs text-[var(--text-muted)]">Read-only from Tyrion</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
        <EvidenceValue label="Classification" value={CLASSIFICATION_LABELS[pattern.classification]} />
        <EvidenceValue label="Confidence" value={formatConfidence(pattern.confidence)} tabular />
        <EvidenceValue label="Observations" value={String(pattern.observationCount)} tabular />
        <EvidenceValue
          label="Observed"
          value={`${formatDate(pattern.observationWindow.firstObservedOn)} - ${formatDate(pattern.observationWindow.lastObservedOn)}`}
        />
        <EvidenceValue
          label="Interval evidence"
          value={pattern.intervalEvidence
            ? `${Math.round(pattern.intervalEvidence.medianDays)} day median (${pattern.intervalEvidence.sampleCount} samples)`
            : 'Not enough evidence'}
          className="col-span-2"
        />
      </dl>
      <div className="mx-4 mb-4 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5">
        <p className="flex gap-2 text-xs leading-5 text-amber-100">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
          Repeated financial activity does not establish a document cadence. OWL owns
          document expectations separately.
        </p>
      </div>
    </section>
  );
}

function EvidenceValue({
  label,
  value,
  tabular,
  className,
}: {
  label: string;
  value: string;
  tabular?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
      <dd className={cn('mt-1 text-xs leading-5 text-[var(--text-secondary)]', tabular && 'tabular-nums')}>
        {value}
      </dd>
    </div>
  );
}

function OwlPolicy({
  item,
  correspondents,
  selectedCorrespondentRef,
  onCorrespondentChange,
  saving,
  onMap,
  onNoDocuments,
}: {
  item: PayeeDocumentReviewItem;
  correspondents: PayeeDocumentReviewSnapshot['correspondents'];
  selectedCorrespondentRef: string;
  onCorrespondentChange: (value: string) => void;
  saving: boolean;
  onMap: () => void;
  onNoDocuments: () => void;
}) {
  const { documentPolicy } = item;
  return (
    <section aria-labelledby="owl-policy-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <FileQuestion size={15} className="text-orange-400" aria-hidden="true" />
        <div>
          <h3 id="owl-policy-heading" className="text-sm font-semibold text-[var(--text-primary)]">
            Document policy
          </h3>
          <p className="text-xs text-[var(--text-muted)]">Owned by OWL and Paperless</p>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Current policy
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
            {policyLabel(item)}
          </p>
          {documentPolicy.expectationSummary && (
            <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
              {documentPolicy.expectationSummary}
            </p>
          )}
        </div>

        <div className="text-xs font-medium text-[var(--text-secondary)]">
          <p>Paperless correspondent</p>
          <Select
            value={selectedCorrespondentRef}
            onValueChange={onCorrespondentChange}
            disabled={saving || documentPolicy.status === 'unavailable'}
          >
            <SelectTrigger
              aria-label="Paperless correspondent"
              className="mt-1.5 min-h-10 w-full bg-[var(--surface-0)] text-sm"
            >
              <SelectValue placeholder="Choose a correspondent" />
            </SelectTrigger>
            <SelectContent>
              {correspondents.map((correspondent) => (
                <SelectItem
                  key={correspondent.correspondentRef}
                  value={correspondent.correspondentRef}
                >
                  {correspondent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <button
          type="button"
          onClick={onMap}
          disabled={saving || !selectedCorrespondentRef || documentPolicy.status === 'unavailable'}
          className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="motion-safe:animate-spin" /> : <Link2 size={13} />}
          Map to correspondent
        </button>

        <button
          type="button"
          onClick={onNoDocuments}
          disabled={saving || documentPolicy.status === 'unavailable'}
          className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
        >
          <Unlink size={13} aria-hidden="true" />
          No documents expected
        </button>

        {documentPolicy.owlPolicyUrl ? (
          <a
            href={documentPolicy.owlPolicyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-orange-400/30 bg-orange-400/10 px-3 text-xs font-medium text-orange-200 transition-colors hover:bg-orange-400/15 focus-visible:ring-2 focus-visible:ring-orange-300"
          >
            Edit detailed expectation policy in OWL
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        ) : (
          <p className="text-xs leading-5 text-[var(--text-muted)]">
            OWL has not provided a detailed policy link for this candidate.
          </p>
        )}
      </div>
    </section>
  );
}

function ReviewLoading() {
  return (
    <div role="status" aria-label="Loading payee document review" className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="h-[34rem] animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
        <div className="h-16 border-b border-[var(--border)] bg-[var(--surface-2)]/50" />
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <div className="h-64 rounded-xl bg-[var(--surface-2)]" />
          <div className="h-64 rounded-xl bg-[var(--surface-2)]" />
        </div>
      </div>
      <span className="sr-only">Loading Tyrion payee evidence and OWL document policy...</span>
    </div>
  );
}

function ReviewError({
  error,
  onRetry,
}: {
  error: { status: number; message: string };
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <AlertTriangle size={28} className="text-amber-400" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">Review could not load</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{error.message}</p>
      {error.status !== 403 && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 min-h-10 rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Try again
        </button>
      )}
    </div>
  );
}

function UnavailableState({
  reason,
  onRetry,
}: {
  reason: string | null;
  onRetry: () => void;
}) {
  return (
    <div role="status" className="mx-auto flex max-w-xl flex-col items-center px-6 py-24 text-center">
      <FileQuestion size={30} className="text-cyan-400" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
        Cross-domain review is not connected
      </h2>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
        {reason || 'Tyrion payee evidence or OWL document policy is unavailable.'}
      </p>
      <p className="mt-3 max-w-md text-xs leading-5 text-[var(--text-muted)]">
        Finance and document tools remain available separately. Mission Control will not infer
        document expectations from recurring charges while this connection is unavailable.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 min-h-10 rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Check again
      </button>
    </div>
  );
}

function EmptyState({ sourceAsOf }: { sourceAsOf: string | null }) {
  return (
    <div role="status" className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
      <Check size={28} className="text-emerald-400" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
        No payees need document review
      </h2>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
        Tyrion and OWL have no unresolved payee-to-correspondent decisions.
        {sourceAsOf ? ` Sources current as of ${new Date(sourceAsOf).toLocaleString()}.` : ''}
      </p>
    </div>
  );
}
