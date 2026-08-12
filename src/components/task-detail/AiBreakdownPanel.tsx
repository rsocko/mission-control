'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';

export interface ProposedSubtask {
  id: string;
  title: string;
  description: string;
  effort: number | null;
}

export interface AcceptedSubtask {
  id: string;
  title: string;
  status: string;
  effort?: number | null;
}

interface AiBreakdownPanelProps {
  taskId: string;
  onAccepted: (subtasks: AcceptedSubtask[]) => void;
  onClose: () => void;
}

interface BreakdownResponse {
  contextVersion?: string;
  proposals?: ProposedSubtask[];
  error?: string;
}

async function responseError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({})) as { error?: string };
  return data.error || fallback;
}

export function AiBreakdownPanel({ taskId, onAccepted, onClose }: AiBreakdownPanelProps) {
  const [proposals, setProposals] = useState<ProposedSubtask[]>([]);
  const [contextVersion, setContextVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acceptingIds, setAcceptingIds] = useState<Set<string>>(new Set());

  const fetchBreakdown = useCallback(async () => {
    const response = await fetch(`/api/tasks/${taskId}/breakdown`, { method: 'POST' });
    if (!response.ok) {
      throw new Error(await responseError(response, 'Failed to generate task breakdown'));
    }
    const data = await response.json() as BreakdownResponse;
    if (!data.contextVersion || !data.proposals?.length) {
      throw new Error('AI returned no usable subtasks');
    }
    return { contextVersion: data.contextVersion, proposals: data.proposals };
  }, [taskId]);

  useEffect(() => {
    let active = true;
    fetchBreakdown()
      .then((data) => {
        if (!active) return;
        setContextVersion(data.contextVersion);
        setProposals(data.proposals);
      })
      .catch((generationError: unknown) => {
        if (active) {
          setError(generationError instanceof Error ? generationError.message : 'Failed to generate task breakdown');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchBreakdown]);

  const generate = useCallback(async () => {
    setLoading(true);
    setError('');
    setProposals([]);
    try {
      const data = await fetchBreakdown();
      setContextVersion(data.contextVersion);
      setProposals(data.proposals);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : 'Failed to generate task breakdown');
    } finally {
      setLoading(false);
    }
  }, [fetchBreakdown]);

  const acceptProposal = useCallback(async (proposal: ProposedSubtask, expectedVersion = contextVersion) => {
    const response = await fetch(`/api/tasks/${taskId}/subtasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: proposal.title,
        effort: proposal.effort,
        proposalId: proposal.id,
        expectedContextVersion: expectedVersion,
      }),
    });
    if (!response.ok) {
      throw new Error(await responseError(response, 'Failed to accept subtask'));
    }
    const data = await response.json() as { subtask?: AcceptedSubtask; contextVersion?: string };
    if (!data.subtask || !data.contextVersion) {
      throw new Error('Subtask creation returned no task');
    }
    return { subtask: data.subtask, contextVersion: data.contextVersion };
  }, [contextVersion, taskId]);

  const acceptOne = useCallback(async (proposal: ProposedSubtask) => {
    setAcceptingIds(new Set([proposal.id]));
    setError('');
    try {
      const accepted = await acceptProposal(proposal);
      setProposals((current) => current.filter((item) => item.id !== proposal.id));
      setContextVersion(accepted.contextVersion);
      onAccepted([accepted.subtask]);
      toast.success('Subtask accepted');
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : 'Failed to accept subtask');
    } finally {
      setAcceptingIds(new Set());
    }
  }, [acceptProposal, onAccepted]);

  const acceptAll = useCallback(async () => {
    const pending = [...proposals];
    setAcceptingIds(new Set(pending.map((proposal) => proposal.id)));
    setError('');
    const accepted: AcceptedSubtask[] = [];
    const acceptedIds = new Set<string>();
    let nextContextVersion = contextVersion;

    try {
      for (const proposal of pending) {
        const result = await acceptProposal(proposal, nextContextVersion);
        accepted.push(result.subtask);
        nextContextVersion = result.contextVersion;
        acceptedIds.add(proposal.id);
      }
      setProposals([]);
      setContextVersion(nextContextVersion);
      onAccepted(accepted);
      toast.success(`${accepted.length} subtasks accepted`);
    } catch (acceptError) {
      setProposals((current) => current.filter((proposal) => !acceptedIds.has(proposal.id)));
      if (accepted.length > 0) {
        setContextVersion(nextContextVersion);
        onAccepted(accepted);
      }
      setError(acceptError instanceof Error ? acceptError.message : 'Failed to accept all subtasks');
    } finally {
      setAcceptingIds(new Set());
    }
  }, [acceptProposal, contextVersion, onAccepted, proposals]);

  const accepting = acceptingIds.size > 0;

  return (
    <section
      aria-label="AI task breakdown suggestions"
      className="mt-2 rounded-lg border border-dashed border-violet-400/40 bg-violet-500/5 p-2.5"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-violet-400" aria-hidden="true" />
        <h3 className="flex-1 text-xs font-semibold text-[var(--text-primary)]">AI suggestions</h3>
        {proposals.length > 1 && (
          <button
            type="button"
            onClick={() => void acceptAll()}
            disabled={accepting}
            className="rounded px-2 py-1 text-[11px] font-medium text-violet-300 hover:bg-violet-500/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Accept all
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          disabled={accepting}
          aria-label="Close AI suggestions"
          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-3 text-xs text-[var(--text-muted)]" role="status">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Generating subtasks…
        </div>
      )}

      {error && (
        <div className="mt-2 rounded border border-red-400/20 bg-red-500/10 p-2 text-xs text-red-300" role="alert">
          <p>{error}</p>
          {!accepting && proposals.length === 0 && (
            <button type="button" onClick={() => void generate()} className="mt-1 font-medium underline underline-offset-2">
              Try again
            </button>
          )}
        </div>
      )}

      {!loading && proposals.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {proposals.map((proposal) => {
            const isAccepting = acceptingIds.has(proposal.id);
            return (
              <li key={proposal.id} className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--surface-0)]/60 p-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[var(--text-primary)]">{proposal.title}</p>
                    {proposal.description && (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">{proposal.description}</p>
                    )}
                    {proposal.effort && (
                      <span className="mt-1 inline-block rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                        Effort {proposal.effort}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void acceptOne(proposal)}
                    disabled={accepting}
                    aria-label={`Accept ${proposal.title}`}
                    className="rounded p-1 text-emerald-400 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isAccepting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setProposals((current) => current.filter((item) => item.id !== proposal.id))}
                    disabled={accepting}
                    aria-label={`Dismiss ${proposal.title}`}
                    className="rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && proposals.length === 0 && (
        <p className="py-2 text-xs text-[var(--text-muted)]" role="status">All suggestions handled.</p>
      )}
    </section>
  );
}
