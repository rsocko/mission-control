'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldOff, XCircle } from 'lucide-react';
import { NAVIGATION_COUNTS_REFRESH_EVENT } from '@/lib/navigation/badges';

interface EvidenceSummary {
  signalId: string;
  sourceType: string;
  kind: string;
  occurredAt: string;
  summary: string;
}

interface ReconciliationSuggestion {
  id: string;
  taskId: string;
  taskTitle: string;
  taskPriority: string;
  taskDueDate: string | null;
  action: 'suggest-complete' | 'escalate';
  confidence: number;
  evidence: EvidenceSummary[];
  policyReason: string;
  payloadHash: string;
  proposedEffect: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

type SuggestionAction = 'accept' | 'dismiss' | 'never-auto-complete';

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

export function ReconciliationReview() {
  const [suggestions, setSuggestions] = useState<ReconciliationSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadSuggestions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/scout/reconciliation/suggestions', { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json() as { suggestions: ReconciliationSuggestion[] };
      setSuggestions(payload.suggestions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load reconciliation suggestions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  const completionSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.action === 'suggest-complete'),
    [suggestions],
  );

  const act = useCallback(async (suggestion: ReconciliationSuggestion, action: SuggestionAction) => {
    setBusyIds((current) => new Set(current).add(suggestion.id));
    setError(null);
    try {
      const response = await fetch(`/api/scout/reconciliation/suggestions/${encodeURIComponent(suggestion.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payloadHash: suggestion.payloadHash }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
      window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Failed to apply suggestion');
      return false;
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(suggestion.id);
        return next;
      });
    }
  }, []);

  const actOnMany = useCallback(async (
    selected: ReconciliationSuggestion[],
    action: Extract<SuggestionAction, 'accept' | 'dismiss'>,
  ) => {
    for (const suggestion of selected) {
      const succeeded = await act(suggestion, action);
      if (!succeeded) break;
    }
  }, [act]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
        <Loader2 className="mr-2 animate-spin" size={18} />
        Loading reconciliation suggestions
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Scout reconciliation</h1>
            <p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
              Review completion and escalation recommendations. Confidence ranks evidence; it does not authorize changes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSuggestions()}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-red-700/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3">
            <button
              type="button"
              disabled={completionSuggestions.length === 0 || busyIds.size > 0}
              onClick={() => void actOnMany(completionSuggestions, 'accept')}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircle2 size={16} />
              Complete {completionSuggestions.length} task{completionSuggestions.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              disabled={busyIds.size > 0}
              onClick={() => void actOnMany(suggestions, 'dismiss')}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XCircle size={16} />
              Dismiss all
            </button>
          </div>
        )}

        {suggestions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-1)] px-6 py-12 text-center">
            <CheckCircle2 className="mx-auto mb-3 text-emerald-400" size={28} />
            <h2 className="font-medium text-[var(--text-primary)]">No suggestions need review</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              New structured Scout evidence will appear here after reconciliation.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {suggestions.map((suggestion) => {
              const busy = busyIds.has(suggestion.id);
              return (
                <article key={suggestion.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          suggestion.action === 'suggest-complete'
                            ? 'bg-emerald-900/40 text-emerald-300'
                            : 'bg-amber-900/40 text-amber-300'
                        }`}>
                          {suggestion.action === 'suggest-complete' ? 'Likely complete' : 'Escalation suggested'}
                        </span>
                        <span className="text-xs text-[var(--text-tertiary)]">
                          {Math.round(suggestion.confidence * 100)}% confidence
                        </span>
                      </div>
                      <Link
                        href={`/tasks/${encodeURIComponent(suggestion.taskId)}`}
                        className="font-medium text-[var(--text-primary)] hover:text-[var(--accent-400)]"
                      >
                        {suggestion.taskTitle}
                      </Link>
                      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                        Priority: {suggestion.taskPriority}
                        {suggestion.taskDueDate ? ` | Due: ${suggestion.taskDueDate}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {suggestion.action === 'suggest-complete' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(suggestion, 'accept')}
                          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {busy ? <Loader2 className="animate-spin" size={15} /> : <CheckCircle2 size={15} />}
                          Mark complete
                        </button>
                      ) : (
                        <Link
                          href={`/tasks/${encodeURIComponent(suggestion.taskId)}`}
                          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500"
                        >
                          <AlertTriangle size={15} />
                          Review task
                        </Link>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(suggestion, 'dismiss')}
                        className="min-h-10 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(suggestion, 'never-auto-complete')}
                        className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                      >
                        <ShieldOff size={15} />
                        Never auto-complete
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 rounded-lg bg-[var(--surface-2)] p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)]">Evidence</p>
                    <ul className="mt-2 space-y-1.5">
                      {suggestion.evidence.map((evidence) => (
                        <li key={evidence.signalId} className="text-sm text-[var(--text-secondary)]">
                          <span className="font-medium text-[var(--text-primary)]">{evidence.sourceType}:</span>{' '}
                          {evidence.summary}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-[var(--text-tertiary)]">{suggestion.policyReason}</p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
