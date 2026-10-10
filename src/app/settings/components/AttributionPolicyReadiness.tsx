'use client';

import { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';

interface ReadinessResponse {
  connector: {
    enabled: boolean;
    configurationUrl: string;
  };
  policySelection: {
    mode: 'follow-current' | 'pinned';
    pinnedPolicyVersion: number | null;
  };
  activePolicyVersion: number | null;
  policyUpdatedAt: string | null;
  policyDiscoveryError: string | null;
  accountSummary: {
    total: number;
    active: number;
    accounts: Array<{
      accountRef: string;
      displayName: string;
      active: boolean;
    }>;
  };
  householdCurrency: string;
  attentionPolicy: {
    pendingCountThreshold: number;
    highAmountThresholdMinor: number;
    accountOverrides: Record<string, {
      pendingCountThreshold: number | null;
      highAmountThresholdMinor: number | null;
    }>;
  };
  historyProjection: {
    status: 'idle' | 'running' | 'succeeded' | 'failed';
    lastSuccessfulAt: string | null;
    itemCount: number | null;
    coverageStart: string | null;
    coverageEnd: string | null;
    windowCount: number | null;
    lastErrorCode: string | null;
    updatedAt: string | null;
  } | null;
}

interface PreviewResponse {
  generatedAt: string;
  policyVersion: number | null;
  engineVersion: string | null;
  totalTransactions: number;
  evaluated: number;
  truncated: boolean;
  complete: boolean;
  ready: boolean;
  acceptedRuleBasedReviewBacklog: number;
  blockingReviewRequired: number;
  counts: {
    status: Record<string, number>;
    reason: Record<string, number>;
    method: Record<string, number>;
    confidence: Record<string, number>;
    reviewStatus: Record<string, number>;
  };
}

function responseError(body: unknown, fallback: string): string {
  if (
    body
    && typeof body === 'object'
    && 'error' in body
    && typeof body.error === 'string'
  ) {
    return body.error.replaceAll('_', ' ');
  }
  return fallback;
}

export function AttributionPolicyReadiness({ connectorId }: { connectorId: string }) {
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'follow-current' | 'pinned'>('follow-current');
  const [pin, setPin] = useState('');
  const [countThreshold, setCountThreshold] = useState('10');
  const [amountThreshold, setAmountThreshold] = useState('250');
  const [accountOverrides, setAccountOverrides] = useState<Record<string, {
    count: string;
    amount: string;
  }>>({});
  const [savedMessage, setSavedMessage] = useState('');
  const [error, setError] = useState('');

  function applyReadiness(body: ReadinessResponse) {
    setReadiness(body);
    setMode(body.policySelection.mode);
    setPin(body.policySelection.pinnedPolicyVersion?.toString() ?? '');
    const minorDigits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: body.householdCurrency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
    const minorFactor = 10 ** minorDigits;
    setCountThreshold(body.attentionPolicy.pendingCountThreshold.toString());
    setAmountThreshold(
      (body.attentionPolicy.highAmountThresholdMinor / minorFactor).toString(),
    );
    setAccountOverrides(Object.fromEntries(body.accountSummary.accounts.map((account) => {
      const override = body.attentionPolicy.accountOverrides[account.accountRef];
      return [account.accountRef, {
        count: override?.pendingCountThreshold?.toString() ?? '',
        amount: override?.highAmountThresholdMinor === null
          || override?.highAmountThresholdMinor === undefined
          ? ''
          : (override.highAmountThresholdMinor / minorFactor).toString(),
      }];
    })));
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/connectors/${connectorId}/finance/attribution-readiness`, {
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as unknown;
        if (!response.ok) throw new Error(responseError(body, 'Policy readiness is unavailable'));
        return body as ReadinessResponse;
      })
      .then((body) => {
        if (!cancelled) applyReadiness(body);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Policy readiness is unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectorId]);

  async function savePolicySelection() {
    const parsedPin = Number(pin);
    if (mode === 'pinned' && (!Number.isSafeInteger(parsedPin) || parsedPin < 1)) {
      setError('Enter a positive whole-number policy version.');
      return;
    }
    setSaving(true);
    setError('');
    setSavedMessage('');
    try {
      const response = await fetch(
        `/api/connectors/${connectorId}/finance/attribution-readiness`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pinnedPolicyVersion: mode === 'pinned' ? parsedPin : null,
          }),
        },
      );
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        throw new Error(responseError(body, 'Policy selection could not be saved'));
      }
      applyReadiness(body as ReadinessResponse);
      setSavedMessage(
        mode === 'pinned'
          ? `Pinned to policy ${parsedPin}.`
          : 'Following Tyrion’s current policy.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Policy selection could not be saved');
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setError('');
    setPreview(null);
    try {
      const response = await fetch(
        `/api/connectors/${connectorId}/finance/attribution-readiness`,
        { method: 'POST' },
      );
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        throw new Error(responseError(body, 'Attribution preview failed'));
      }

      setPreview(body as PreviewResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Attribution preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  async function saveAttentionPolicy() {
    if (!readiness) return;
    const count = Number(countThreshold);
    const amount = Number(amountThreshold);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(amount) || amount < 0) {
      setError('Notification thresholds must be nonnegative numbers.');
      return;
    }
    const minorDigits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: readiness.householdCurrency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
    const minorFactor = 10 ** minorDigits;
    const overrides: ReadinessResponse['attentionPolicy']['accountOverrides'] = {};
    for (const [accountRef, override] of Object.entries(accountOverrides)) {
      const overrideCount = override.count.trim() === '' ? null : Number(override.count);
      const overrideAmount = override.amount.trim() === '' ? null : Number(override.amount);
      if (
        (overrideCount !== null && (!Number.isSafeInteger(overrideCount) || overrideCount < 0))
        || (overrideAmount !== null && (!Number.isFinite(overrideAmount) || overrideAmount < 0))
      ) {
        setError('Account overrides must be nonnegative numbers or blank to inherit.');
        return;
      }
      if (overrideCount !== null || overrideAmount !== null) {
        overrides[accountRef] = {
          pendingCountThreshold: overrideCount,
          highAmountThresholdMinor: overrideAmount === null
            ? null
            : Math.round(overrideAmount * minorFactor),
        };
      }
    }
    setSaving(true);
    setError('');
    setSavedMessage('');
    try {
      const response = await fetch(
        `/api/connectors/${connectorId}/finance/attribution-readiness`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attentionPolicy: {
              pendingCountThreshold: count,
              highAmountThresholdMinor: Math.round(amount * minorFactor),
              accountOverrides: overrides,
            },
          }),
        },
      );
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        throw new Error(responseError(body, 'Notification thresholds could not be saved'));
      }
      applyReadiness(body as ReadinessResponse);
      setSavedMessage('Attribution notification thresholds saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Notification thresholds could not be saved');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 size={13} className="animate-spin" />
          Loading attribution policy readiness...
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby={`attribution-readiness-${connectorId}`}
      className="space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id={`attribution-readiness-${connectorId}`}
            className="text-sm font-semibold text-[var(--text-primary)]"
          >
            Attribution policy readiness
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
            Set each account&apos;s Default attribution in Tyrion, then run a no-write
            coverage preview. Manual assignments and explicit rules override defaults.
          </p>
        </div>
        {readiness?.connector.configurationUrl && (
          <a
            href={readiness.connector.configurationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Configure defaults in Tyrion <ExternalLink size={11} />
          </a>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-800/40 bg-red-950/30 p-2 text-xs text-red-300"
        >
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {readiness && (
        <>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-[var(--text-primary)]">
              Policy version
            </legend>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="radio"
                name={`attribution-policy-mode-${connectorId}`}
                value="follow-current"
                checked={mode === 'follow-current'}
                onChange={() => {
                  setMode('follow-current');
                  setSavedMessage('');
                }}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-[var(--text-primary)]">
                  Follow Tyrion&apos;s current policy
                </span>
                <span className="mt-0.5 block leading-5 text-[var(--text-muted)]">
                  Each preview or sync locks the current version for that entire operation.
                  Newly saved Tyrion policies are used without redeploying Mission Control.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="radio"
                name={`attribution-policy-mode-${connectorId}`}
                value="pinned"
                checked={mode === 'pinned'}
                onChange={() => {
                  setMode('pinned');
                  setSavedMessage('');
                }}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="font-medium text-[var(--text-primary)]">
                  Pin a specific policy version
                </span>
                <span className="mt-0.5 block leading-5 text-[var(--text-muted)]">
                  Operations fail closed when Tyrion&apos;s active version does not match.
                </span>
              </span>
            </label>
            {mode === 'pinned' && (
              <label className="block max-w-48 text-xs font-medium text-[var(--text-secondary)]">
                Policy version
                <span className="input-glow mt-1 block rounded-md border border-[var(--border)] bg-[var(--surface-0)]">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={pin}
                    onChange={(event) => {
                      setPin(event.target.value);
                      setSavedMessage('');
                    }}
                    aria-describedby={`policy-pin-help-${connectorId}`}
                    className="w-full rounded-md border-0 bg-transparent px-2 py-1.5 text-sm text-[var(--text-primary)] outline-none"
                  />
                </span>
                <span
                  id={`policy-pin-help-${connectorId}`}
                  className="mt-1 block font-normal leading-5 text-[var(--text-muted)]"
                >
                  Enter the positive version number shown in Tyrion.
                </span>
              </label>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={savePolicySelection}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {saving && <Loader2 size={12} className="animate-spin" />}
                {saving ? 'Saving policy mode...' : 'Save policy mode'}
              </button>
              <span aria-live="polite" className="text-xs text-green-400">
                {savedMessage}
              </span>
            </div>
          </fieldset>

          <fieldset className="space-y-3 border-t border-[var(--border-subtle)] pt-3">
            <legend className="text-xs font-medium text-[var(--text-primary)]">
              Account review notifications
            </legend>
            <p className="text-xs leading-5 text-[var(--text-muted)]">
              Mission Control keeps every unmatched transaction in the review queue and sends
              at most one live summary per account. Set a threshold to 0 to disable that trigger.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                Pending transactions
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={countThreshold}
                  onChange={(event) => setCountThreshold(event.target.value)}
                  className="mt-1 block w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                />
              </label>
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                High amount ({readiness.householdCurrency})
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amountThreshold}
                  onChange={(event) => setAmountThreshold(event.target.value)}
                  className="mt-1 block w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                />
              </label>
            </div>
            {readiness.accountSummary.accounts.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-[var(--text-secondary)]">
                  Optional account overrides
                </p>
                {readiness.accountSummary.accounts.map((account) => (
                  <div
                    key={account.accountRef}
                    className="grid gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] p-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]"
                  >
                    <span className="self-center truncate text-xs text-[var(--text-primary)]">
                      {account.displayName}
                    </span>
                    <label className="text-[11px] text-[var(--text-muted)]">
                      Pending count
                      <input
                        type="number"
                        min={0}
                        step={1}
                        placeholder="Inherit"
                        value={accountOverrides[account.accountRef]?.count ?? ''}
                        onChange={(event) => setAccountOverrides((current) => ({
                          ...current,
                          [account.accountRef]: {
                            count: event.target.value,
                            amount: current[account.accountRef]?.amount ?? '',
                          },
                        }))}
                        className="mt-1 block w-full rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs text-[var(--text-primary)]"
                      />
                    </label>
                    <label className="text-[11px] text-[var(--text-muted)]">
                      Amount ({readiness.householdCurrency})
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="Inherit"
                        value={accountOverrides[account.accountRef]?.amount ?? ''}
                        onChange={(event) => setAccountOverrides((current) => ({
                          ...current,
                          [account.accountRef]: {
                            count: current[account.accountRef]?.count ?? '',
                            amount: event.target.value,
                          },
                        }))}
                        className="mt-1 block w-full rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs text-[var(--text-primary)]"
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={saveAttentionPolicy}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              {saving ? 'Saving thresholds...' : 'Save notification thresholds'}
            </button>
          </fieldset>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
            <span>
              Active Tyrion policy: {readiness.activePolicyVersion ?? 'unavailable'}
            </span>
            <span>
              Mission Control mode: {readiness.policySelection.mode === 'pinned'
                ? `pinned to ${readiness.policySelection.pinnedPolicyVersion}`
                : 'follow current'}
            </span>
            <span>
              {readiness.accountSummary.total} synchronized account
              {readiness.accountSummary.total === 1 ? '' : 's'}
              {' '}({readiness.accountSummary.active} active)
            </span>
          </div>

          {readiness.policyDiscoveryError && (
            <div
              role="status"
              className="rounded-md border border-amber-800/40 bg-amber-950/20 p-2 text-xs text-amber-300"
            >
              Tyrion&apos;s active policy is currently unavailable (
              {readiness.policyDiscoveryError}). You can still change the saved mode,
              but follow-current operations will fail closed until discovery recovers.
            </div>
          )}

          {readiness.policySelection.mode === 'pinned'
            && readiness.activePolicyVersion !== null
            && readiness.activePolicyVersion !== readiness.policySelection.pinnedPolicyVersion && (
            <div
              role="status"
              className="rounded-md border border-amber-800/40 bg-amber-950/20 p-2 text-xs text-amber-300"
            >
              Tyrion is currently on policy {readiness.activePolicyVersion}. Preview and sync
              will remain blocked until it matches pinned policy{' '}
              {readiness.policySelection.pinnedPolicyVersion}, or you switch to follow current.
            </div>
          )}

          {readiness.accountSummary.total === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">
              No synchronized accounts are available yet. Keep the connector quarantined
              and complete a successful snapshot before configuring defaults.
            </p>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] p-2 text-xs text-[var(--text-secondary)]">
              <Check size={13} className="mt-0.5 shrink-0 text-green-400" />
              <p className="leading-5">
                Default attribution is managed directly in Tyrion as a child,
                Parent/shared, or Rule-based. Transaction-level manual assignments
                remain authoritative.
              </p>
            </div>
          )}

          {readiness.historyProjection?.lastErrorCode && (
            <div className="rounded-md border border-amber-800/40 bg-amber-950/20 p-2 text-xs text-amber-300">
              Finance Insight history projection failed: {' '}
              <code>{readiness.historyProjection.lastErrorCode}</code>
            </div>
          )}

          <button
            type="button"
            onClick={runPreview}
            disabled={previewing || readiness.accountSummary.total === 0}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {previewing
              ? <Loader2 size={12} className="animate-spin" />
              : <RefreshCw size={12} />}
            {previewing ? 'Evaluating policy...' : 'Run no-write preview'}
          </button>
        </>
      )}

      {preview && (
        <div
          role="status"
          className={`rounded-md border p-2 text-xs ${
            preview.ready
              ? 'border-green-800/40 bg-green-950/20 text-green-300'
              : 'border-amber-800/40 bg-amber-950/20 text-amber-300'
          }`}
        >
          <p className="font-medium">
            {preview.ready
              ? 'Policy safely covers the complete local transaction projection.'
              : 'Policy still requires review before another canary.'}
          </p>
          <p className="mt-1 leading-5">
            Evaluated {preview.evaluated} of {preview.totalTransactions};
            {' '}{preview.counts.reviewStatus.pending ?? 0} pending review,
            {' '}{preview.counts.reason['no-match'] ?? 0} no-match,
            {' '}{preview.counts.status.attributed ?? 0} attributed,
            {' '}{preview.counts.method.manual ?? 0} manual decisions preserved.
            {preview.truncated ? ' The bounded preview was truncated.' : ''}
          </p>
          {preview.acceptedRuleBasedReviewBacklog > 0 && (
            <p className="mt-1 leading-5">
              {preview.acceptedRuleBasedReviewBacklog} explicitly accepted Rule-based
              {' '}items may remain in the manual review queue. This backlog is not a
              configuration defect and must not add per-transaction notifications;
              release safety still requires canary notificationsAdded=0.
            </p>
          )}
          <p className="mt-1 text-[11px] opacity-80">
            Policy {preview.policyVersion ?? 'unknown'} - engine {preview.engineVersion ?? 'unknown'}
          </p>
        </div>
      )}
    </section>
  );
}
