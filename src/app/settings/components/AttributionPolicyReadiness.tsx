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
  expectedPolicyVersion: number | null;
  accountSummary: {
    total: number;
    active: number;
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
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
            <span>Policy fence: {readiness.expectedPolicyVersion ?? 'not configured'}</span>
            <span>
              {readiness.accountSummary.total} synchronized account
              {readiness.accountSummary.total === 1 ? '' : 's'}
              {' '}({readiness.accountSummary.active} active)
            </span>
          </div>

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
              ? 'Policy covers the complete local transaction projection.'
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
          <p className="mt-1 text-[11px] opacity-80">
            Policy {preview.policyVersion ?? 'unknown'} - engine {preview.engineVersion ?? 'unknown'}
          </p>
        </div>
      )}
    </section>
  );
}
