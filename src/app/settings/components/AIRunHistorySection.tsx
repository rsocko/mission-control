'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  RefreshCw,
  RotateCcw,
  StopCircle,
} from 'lucide-react';
import { settingsLogger } from '@/lib/client-logger';

interface RunHistoryItem {
  id: string;
  featureId: string;
  status: string;
  executionRoute: string;
  provider: string | null;
  model: string | null;
  fallbackState: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

function statusColor(status: string): string {
  if (status === 'succeeded') return 'text-emerald-400';
  if (status === 'failed' || status === 'timed_out') return 'text-red-400';
  if (status === 'cancelled') return 'text-amber-400';
  return 'text-blue-400';
}

export function AIRunHistorySection() {
  const [runs, setRuns] = useState<RunHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const response = await fetch('/api/ai/runs?limit=10', {
        cache: 'no-store',
      });
      const body = await response.json() as {
        runs?: RunHistoryItem[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || 'Failed to load AI runs.');
      setRuns(body.runs ?? []);
      setError(null);
    } catch (loadError) {
      const message = loadError instanceof Error
        ? loadError.message
        : 'Failed to load AI runs.';
      setError(message);
      settingsLogger.error('Failed to load durable AI run history', {
        error: message,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh(true));
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function mutateRun(run: RunHistoryItem, action: 'cancel' | 'retry') {
    setPendingRunId(run.id);
    try {
      const idempotencyKey = action === 'retry' ? crypto.randomUUID() : undefined;
      const response = await fetch(`/api/ai/runs/${encodeURIComponent(run.id)}/${action}`, {
        method: 'POST',
        headers: action === 'retry'
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey ?? '',
            }
          : undefined,
        ...(action === 'retry'
          ? { body: JSON.stringify({ idempotencyKey }) }
          : {}),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `Failed to ${action} AI run.`);
      await refresh();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : `Failed to ${action} AI run.`,
      );
    } finally {
      setPendingRunId(null);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Durable AI run history
          </h3>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Reconnectable progress for AI work that can outlive this browser session.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={loading}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-red-800/30 bg-red-900/10 p-3 text-xs text-red-300">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {loading && runs.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--text-muted)]">
          <Loader2 size={15} className="animate-spin" />
          Loading run history...
        </div>
      ) : runs.length === 0 ? (
        <p className="py-8 text-center text-xs text-[var(--text-muted)]">
          No durable AI runs have been created.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--border-subtle)]">
          {runs.map((run) => {
            const mutable = pendingRunId === run.id;
            return (
              <li key={run.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {run.featureId}
                    </span>
                    <span className={`text-xs font-medium capitalize ${statusColor(run.status)}`}>
                      {run.status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                    {run.executionRoute}
                    {run.provider ? ` · ${run.provider}/${run.model || 'unknown'}` : ''}
                    {run.fallbackState === 'used' ? ' · fallback used' : ''}
                    {` · attempt ${run.attempt}/${run.maxAttempts}`}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-[var(--text-tertiary)]">
                    {run.id} · {new Date(run.updatedAt).toLocaleString()}
                  </p>
                </div>
                {['queued', 'running', 'cancelling'].includes(run.status) && (
                  <button
                    type="button"
                    onClick={() => void mutateRun(run, 'cancel')}
                    disabled={mutable || run.status === 'cancelling'}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-amber-800/40 px-3 py-2 text-xs text-amber-300 hover:bg-amber-900/10 disabled:opacity-50"
                  >
                    {mutable
                      ? <Loader2 size={13} className="animate-spin" />
                      : <StopCircle size={13} />}
                    Cancel
                  </button>
                )}
                {['failed', 'timed_out'].includes(run.status) && (
                  <button
                    type="button"
                    onClick={() => void mutateRun(run, 'retry')}
                    disabled={mutable}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                  >
                    {mutable
                      ? <Loader2 size={13} className="animate-spin" />
                      : <RotateCcw size={13} />}
                    Retry
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
