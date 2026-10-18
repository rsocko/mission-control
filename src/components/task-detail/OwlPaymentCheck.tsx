'use client';

import { useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
} from 'lucide-react';
import type { TaskDetailMetadata } from './task-detail-types';

type PaymentCheck = NonNullable<TaskDetailMetadata['paymentCheck']>;
type SourceAction = NonNullable<TaskDetailMetadata['sourceActions']>[number];

const PAYMENT_STATE_COPY: Record<
  PaymentCheck['state'],
  { title: string; detail: string; tone: string }
> = {
  unchecked: {
    title: 'Payment not checked',
    detail: 'Ask OWL to match this bill against Tyrion transactions.',
    tone: 'text-[var(--text-secondary)]',
  },
  checking: {
    title: 'Checking for payment',
    detail: 'OWL is evaluating current Tyrion transaction evidence.',
    tone: 'text-blue-300',
  },
  posted_match: {
    title: 'Posted payment found',
    detail: 'Review the evidence before confirming payment and completing the task.',
    tone: 'text-emerald-300',
  },
  pending_match: {
    title: 'Pending transaction found',
    detail: 'Pending evidence cannot confirm that the bill was paid.',
    tone: 'text-amber-300',
  },
  multiple_matches: {
    title: 'Multiple possible payments',
    detail: 'The evidence is ambiguous. Review the candidates before taking action.',
    tone: 'text-amber-300',
  },
  no_match: {
    title: 'No payment found',
    detail: 'OWL did not find a matching Tyrion transaction in the current window.',
    tone: 'text-[var(--text-secondary)]',
  },
  partial_payment: {
    title: 'Possible partial payment',
    detail: 'The transaction amount does not fully cover the bill.',
    tone: 'text-amber-300',
  },
  source_unavailable: {
    title: 'Payment source unavailable',
    detail: 'OWL could not reach the Tyrion matching source. Retry when it is available.',
    tone: 'text-[var(--danger)]',
  },
  stale: {
    title: 'Payment evidence is stale',
    detail: 'Run a new check before relying on this result.',
    tone: 'text-amber-300',
  },
  conflict: {
    title: 'Payment evidence changed',
    detail: 'The source revision changed. Refresh the evidence before deciding.',
    tone: 'text-[var(--danger)]',
  },
  possible_double_payment: {
    title: 'Possible double payment',
    detail: 'More than one transaction may cover this bill. Do not confirm until reviewed.',
    tone: 'text-[var(--danger)]',
  },
  confirmed: {
    title: 'Payment confirmed',
    detail: 'OWL confirmed the posted payment and completed the source task atomically.',
    tone: 'text-emerald-300',
  },
};

interface OwlPaymentCheckProps {
  paymentCheck?: PaymentCheck;
  sourceActions?: SourceAction[];
  busyAction: string | null;
  onExecute: (action: SourceAction, successMessage: string) => void;
}

export function OwlPaymentCheck({
  paymentCheck,
  sourceActions = [],
  busyAction,
  onExecute,
}: OwlPaymentCheckProps) {
  const [confirming, setConfirming] = useState(false);
  const headingId = useId();
  const checkAction = sourceActions.find((action) => action.id === 'check_payment');
  const confirmAction = sourceActions.find((action) => action.id === 'confirm_payment_and_complete');
  const state = paymentCheck?.state ?? 'unchecked';
  const copy = PAYMENT_STATE_COPY[state];
  const checkedLabel = formatTimestamp(
    paymentCheck?.checkedAt || paymentCheck?.searchContext?.searchedAt,
  );
  const freshLabel = useMemo(
    () => describeFreshness(paymentCheck?.freshUntil),
    [paymentCheck?.freshUntil],
  );
  const canConfirm = state === 'posted_match' && !!confirmAction;
  const isChecking = busyAction === 'source:check_payment' || state === 'checking';
  const isConfirming = busyAction === 'source:confirm_payment_and_complete';

  if (!checkAction && !paymentCheck) return null;

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-0)]/45"
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <div className="min-w-0">
          <h3 id={headingId} className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-heading)]">
            <SearchCheck size={14} aria-hidden="true" />
            Check for payment
          </h3>
          <p className={`mt-1 text-xs font-medium ${copy.tone}`}>{copy.title}</p>
        </div>
        {state === 'confirmed' ? (
          <ShieldCheck size={18} className="shrink-0 text-emerald-300" aria-label="Payment confirmed" />
        ) : state === 'posted_match' ? (
          <CheckCircle2 size={18} className="shrink-0 text-emerald-300" aria-label="Posted match" />
        ) : state === 'pending_match' || state === 'stale' || state === 'multiple_matches' ? (
          <Clock3 size={18} className="shrink-0 text-amber-300" aria-label="Review needed" />
        ) : state === 'source_unavailable' || state === 'conflict' || state === 'possible_double_payment' ? (
          <AlertTriangle size={18} className="shrink-0 text-[var(--danger)]" aria-label="Attention needed" />
        ) : null}
      </div>

      <div className="space-y-3 px-3 py-3">
        <p className="text-xs leading-5 text-[var(--text-muted)]">
          {paymentCheck?.message || copy.detail}
        </p>

        {(checkedLabel
          || freshLabel
          || paymentCheck?.source
          || paymentCheck?.searchContext?.sourceAsOf
          || (
            paymentCheck?.searchContext?.windowStart
            && paymentCheck.searchContext.windowEnd
          )) && (
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
            {checkedLabel && <EvidenceFact label="Checked" value={checkedLabel} />}
            {freshLabel && <EvidenceFact label="Freshness" value={freshLabel} />}
            {paymentCheck?.source && <EvidenceFact label="Source" value={paymentCheck.source} />}
            {formatTimestamp(paymentCheck?.searchContext?.sourceAsOf) && (
              <EvidenceFact
                label="Source as of"
                value={formatTimestamp(paymentCheck?.searchContext?.sourceAsOf)!}
              />
            )}
            {paymentCheck?.searchContext?.windowStart && paymentCheck.searchContext.windowEnd && (
              <EvidenceFact
                label="Window"
                value={`${formatShortDate(paymentCheck.searchContext.windowStart)}–${formatShortDate(paymentCheck.searchContext.windowEnd)}`}
              />
            )}
          </dl>
        )}

        {paymentCheck?.candidates.map((candidate) => (
          <article
            key={candidate.id}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-2.5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{candidate.payee}</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {formatTransactionDate(candidate.transactionDate)}
                  {' · '}
                  {candidate.accountDisplayName}
                  {candidate.accountLastFour ? ` •••• ${candidate.accountLastFour}` : ''}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                  {formatMoney(candidate.amount, candidate.currency)}
                </p>
                <p className={`mt-0.5 text-[11px] font-medium ${
                  candidate.status === 'posted' ? 'text-emerald-300' : 'text-amber-300'
                }`}>
                  {candidate.status === 'posted' ? 'Posted' : 'Pending'}
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
              {candidate.rank && <span>Rank #{candidate.rank}</span>}
              <span>Confidence {formatPercent(candidate.confidence)}</span>
              <span>Score {formatPercent(candidate.score)}</span>
              {candidate.scoreGapBasisPoints !== undefined && (
                <span>Lead {candidate.scoreGapBasisPoints} bp</span>
              )}
            </div>
            {candidate.matchReasons.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Match reasons">
                {candidate.matchReasons.map((reason) => (
                  <li
                    key={reason}
                    className="rounded-md bg-[var(--surface-3)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                  >
                    {reason}
                  </li>
                ))}
              </ul>
            )}
            {candidate.receiptAssociation && (
              <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">
                Receipt evidence: {candidate.receiptAssociation.label
                  || candidate.receiptAssociation.status
                  || 'associated'}
                {candidate.receiptAssociation.receiptDate
                  ? ` · ${formatShortDate(candidate.receiptAssociation.receiptDate)}`
                  : ''}
                {candidate.receiptAssociation.amount !== undefined
                  && candidate.receiptAssociation.currency
                  ? ` · ${formatMoney(
                    candidate.receiptAssociation.amount,
                    candidate.receiptAssociation.currency,
                  )}`
                  : ''}
                {' · supporting evidence only'}
              </p>
            )}
          </article>
        ))}

        {confirming && canConfirm ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
            <p className="text-xs font-semibold text-emerald-200">
              Confirm this posted transaction as payment?
            </p>
            <p className="mt-1 text-xs leading-5 text-emerald-100/80">
              OWL will atomically record the confirmation and complete the source task.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => setConfirming(false)}
                className="inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => onExecute(
                  confirmAction,
                  'Payment confirmed in OWL and the source task was completed.',
                )}
                className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-wait disabled:opacity-60"
              >
                {isConfirming ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                Confirm paid
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {checkAction && (
              <button
                type="button"
                disabled={busyAction !== null || isChecking}
                onClick={() => onExecute(checkAction, 'OWL refreshed the payment evidence.')}
                className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 text-xs font-semibold text-blue-300 transition-colors hover:bg-blue-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-wait disabled:opacity-60"
              >
                {isChecking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {state === 'unchecked' ? 'Check for payment' : 'Check again'}
              </button>
            )}
            {canConfirm && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => setConfirming(true)}
                className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-wait disabled:opacity-60"
              >
                <ShieldCheck size={13} />
                Confirm payment
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function EvidenceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{label}:</dt>
      <dd className="font-medium text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatTransactionDate(value: string): string {
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value,
  );
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatShortDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTimestamp(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function describeFreshness(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime() < Date.now()
    ? `Stale since ${date.toLocaleString()}`
    : `Current until ${date.toLocaleString()}`;
}
