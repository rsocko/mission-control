'use client';

import { useEffect, useState } from 'react';
import {
  Check,
  Clipboard,
  ExternalLink,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';

interface AttributionAccount {
  accountRef: string;
  displayName: string;
  type: string;
  mask: string | null;
  active: boolean;
}

interface ReadinessResponse {
  connector: {
    enabled: boolean;
    configurationUrl: string;
  };
  expectedPolicyVersion: number | null;
  accounts: AttributionAccount[];
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
  const [error, setError] = useState('');
  const [copiedRef, setCopiedRef] = useState<string | null>(null);

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
        if (!cancelled) setReadiness(body);
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

  async function copyAccountRef(accountRef: string) {
    try {
      await navigator.clipboard.writeText(accountRef);
      setCopiedRef(accountRef);
      setTimeout(() => setCopiedRef((current) => current === accountRef ? null : current), 2000);
    } catch {
      setError('Could not copy the account reference');
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
            Copy each opaque reference into its matching Tyrion account rule, save the
            policy, then run a no-write coverage preview.
          </p>
        </div>
        {readiness?.connector.configurationUrl && (
          <a
            href={readiness.connector.configurationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Configure <ExternalLink size={11} />
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
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
            <span>Policy fence: {readiness.expectedPolicyVersion ?? 'not configured'}</span>
            <span>{readiness.accounts.length} account{readiness.accounts.length === 1 ? '' : 's'}</span>
          </div>

          {readiness.accounts.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">
              No synchronized accounts are available yet. Keep the connector quarantined
              and complete a successful snapshot before configuring policy rules.
            </p>
          ) : (
            <div className="max-h-56 divide-y divide-[var(--border-subtle)] overflow-y-auto rounded-md border border-[var(--border-subtle)]">
              {readiness.accounts.map((account) => (
                <div key={account.accountRef} className="space-y-1.5 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-[var(--text-secondary)]">
                      {account.displayName}
                      {account.mask ? ` - ${account.mask}` : ''}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                      {account.type}{account.active ? '' : ' - inactive'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded bg-[var(--surface-0)] px-2 py-1 text-[11px] text-[var(--text-tertiary)]">
                      {account.accountRef}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyAccountRef(account.accountRef)}
                      className="rounded-md border border-[var(--border)] p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      aria-label={`Copy Tyrion account reference for ${account.displayName}`}
                    >
                      {copiedRef === account.accountRef
                        ? <Check size={12} className="text-green-400" />
                        : <Clipboard size={12} />}
                    </button>
                  </div>
                </div>
              ))}
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
            disabled={previewing || readiness.accounts.length === 0}
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
              ? 'Policy covers the complete local transaction projection.'
              : 'Policy still requires review before another canary.'}
          </p>
          <p className="mt-1 leading-5">
            Evaluated {preview.evaluated} of {preview.totalTransactions};
            {' '}{preview.counts.reviewStatus.pending ?? 0} pending review,
            {' '}{preview.counts.reason['no-match'] ?? 0} no-match,
            {' '}{preview.counts.status.attributed ?? 0} attributed.
            {preview.truncated ? ' The bounded preview was truncated.' : ''}
          </p>
          <p className="mt-1 text-[11px] opacity-80">
            Policy {preview.policyVersion ?? 'unknown'} - engine {preview.engineVersion ?? 'unknown'}
          </p>
        </div>
      )}
    </section>
  );
}
