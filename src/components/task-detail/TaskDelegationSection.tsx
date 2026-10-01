'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Ban,
  Bot,
  CheckCircle2,
  ChevronDown,
  CirclePause,
  Clock3,
  ExternalLink,
  GitCommit,
  GitPullRequest,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type {
  TaskDelegationContext,
  TaskDelegationDisplayState,
  TaskDelegationSummary,
  TaskDelegationTarget,
} from '@/lib/external-agents/task-delegation';
import type { TaskDetailMode } from './task-detail-types';

interface DelegationPreview {
  dispatchId: string;
  previewHash: string;
  processingLocation: string;
  dataClassification: string;
  disclosedFields: string[];
  allowedActions: string[];
  payloadPreview: Record<string, unknown>;
}

const STATE_PRESENTATION: Record<TaskDelegationDisplayState, {
  label: string;
  className: string;
  icon: typeof Clock3;
}> = {
  preview: {
    label: 'Awaiting confirmation',
    className: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
    icon: ShieldCheck,
  },
  queued: {
    label: 'Queued',
    className: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
    icon: Clock3,
  },
  running: {
    label: 'Running',
    className: 'border-blue-500/25 bg-blue-500/10 text-blue-300',
    icon: Play,
  },
  idle: {
    label: 'Idle',
    className: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
    icon: CirclePause,
  },
  waiting_for_user: {
    label: 'Waiting for you',
    className: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
    icon: CirclePause,
  },
  blocked: {
    label: 'Blocked',
    className: 'border-orange-500/25 bg-orange-500/10 text-orange-300',
    icon: AlertTriangle,
  },
  failed: {
    label: 'Failed',
    className: 'border-red-500/25 bg-red-500/10 text-red-300',
    icon: AlertTriangle,
  },
  timed_out: {
    label: 'Timed out',
    className: 'border-red-500/25 bg-red-500/10 text-red-300',
    icon: Clock3,
  },
  cancelled: {
    label: 'Cancelled',
    className: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
    icon: Ban,
  },
  completed: {
    label: 'Completed',
    className: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
    icon: CheckCircle2,
  },
};

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error || `Request failed (${response.status})`;
}

function StateBadge({ state }: { state: TaskDelegationDisplayState }) {
  const presentation = STATE_PRESENTATION[state];
  const Icon = presentation.icon;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
      presentation.className,
    )}>
      <Icon size={11} aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

function ReferenceLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: typeof ExternalLink;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs text-[var(--accent-400)] hover:bg-[var(--surface-2)] hover:text-[var(--accent-300)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <Icon size={12} aria-hidden="true" />
      {children}
    </a>
  );
}

function AssignmentDetails({
  assignment,
  busyAction,
  onAction,
}: {
  assignment: TaskDelegationSummary;
  busyAction: string | null;
  onAction: (action: 'cancel' | 'retry') => void;
}) {
  const refs = [
    ...assignment.checks.map((item) => ({ ...item, kind: 'Check' })),
    ...assignment.artifacts.map((item) => ({ ...item, kind: 'Artifact' })),
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={assignment.displayState} />
        {assignment.pendingApproval && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            <ShieldCheck size={11} aria-hidden="true" />
            Approval pending
          </span>
        )}
        <span className="text-xs text-[var(--text-muted)]">
          Canonical state: {assignment.canonicalState.replaceAll('_', ' ')}
        </span>
      </div>

      <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[var(--text-muted)]">Execution target</dt>
          <dd className="mt-0.5 font-medium text-[var(--text-primary)]">{assignment.targetName}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)]">Locality</dt>
          <dd className="mt-0.5 text-[var(--text-secondary)]">
            {assignment.locality.replaceAll('-', ' ')}
          </dd>
        </div>
        {assignment.companyId && (
          <div>
            <dt className="text-[var(--text-muted)]">Paperclip company</dt>
            <dd className="mt-0.5 break-all font-mono text-[11px] text-[var(--text-secondary)]">
              {assignment.companyId}
            </dd>
          </div>
        )}
        {(assignment.responsibleAgent || assignment.responsibleAgentId) && (
          <div>
            <dt className="text-[var(--text-muted)]">Active executor</dt>
            <dd className="mt-0.5 text-[var(--text-secondary)]">
              {assignment.responsibleAgent ?? assignment.responsibleAgentId}
            </dd>
          </div>
        )}
      </dl>

      {assignment.latestProgress && (
        <div className="rounded-lg bg-[var(--surface-1)] px-3 py-2 text-xs text-[var(--text-secondary)]">
          <span className="font-medium text-[var(--text-primary)]">Latest progress: </span>
          {assignment.latestProgress}
        </div>
      )}
      {(assignment.blocker || assignment.errorMessage) && (
        <div
          role="status"
          className="flex gap-2 rounded-lg border border-orange-500/20 bg-orange-500/8 px-3 py-2 text-xs text-orange-200"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{assignment.blocker ?? assignment.errorMessage}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {assignment.issueUrl && (
          <ReferenceLink href={assignment.issueUrl} icon={ExternalLink}>
            {assignment.issueIdentifier ?? 'Paperclip issue'}
          </ReferenceLink>
        )}
        {assignment.runUrl && (
          <ReferenceLink href={assignment.runUrl} icon={ExternalLink}>Run</ReferenceLink>
        )}
        {assignment.pullRequestUrl && (
          <ReferenceLink href={assignment.pullRequestUrl} icon={GitPullRequest}>
            Pull request
          </ReferenceLink>
        )}
        {assignment.commitSha && (
          <span className="inline-flex items-center gap-1 px-2 text-xs text-[var(--text-muted)]">
            <GitCommit size={12} aria-hidden="true" />
            <span className="font-mono">{assignment.commitSha.slice(0, 8)}</span>
          </span>
        )}
      </div>

      {refs.length > 0 && (
        <ul className="space-y-1" aria-label="Returned checks and artifacts">
          {refs.map((reference, index) => (
            <li key={`${reference.kind}-${reference.name}-${index}`} className="flex items-center gap-2 text-xs">
              <span className="text-[var(--text-muted)]">{reference.kind}</span>
              {reference.url ? (
                <a
                  href={reference.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-[var(--accent-400)] hover:underline"
                >
                  {reference.name}
                </a>
              ) : (
                <span className="truncate text-[var(--text-secondary)]">{reference.name}</span>
              )}
              {reference.status && (
                <span className="ml-auto shrink-0 text-[var(--text-muted)]">{reference.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {(assignment.canCancel || assignment.canRetry) && (
        <div className="flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-3">
          {assignment.canCancel && (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => onAction('cancel')}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-red-500/25 px-3 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'cancel' ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
              {assignment.displayState === 'preview' ? 'Revoke preview' : 'Cancel execution'}
            </button>
          )}
          {assignment.canRetry && (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => onAction('retry')}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'retry' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              Re-dispatch
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskDelegationSection({
  taskId,
  taskTitle,
  mode,
}: {
  taskId: string;
  taskTitle: string;
  mode: TaskDetailMode;
}) {
  const [context, setContext] = useState<TaskDelegationContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<DelegationPreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/delegation`);
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as Partial<TaskDelegationContext>;
      const next: TaskDelegationContext = {
        taskId,
        eligibleTargets: Array.isArray(body.eligibleTargets) ? body.eligibleTargets : [],
        assignments: Array.isArray(body.assignments) ? body.assignments : [],
        syncError: typeof body.syncError === 'string' ? body.syncError : null,
      };
      setContext(next);
      setSelectedTargetId((current) => (
        current || (next.eligibleTargets.length === 1 ? next.eligibleTargets[0].id : '')
      ));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Delegation could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const selectedTarget = useMemo(
    () => context?.eligibleTargets.find(({ id }) => id === selectedTargetId) ?? null,
    [context?.eligibleTargets, selectedTargetId],
  );
  const current = context?.assignments[0] ?? null;

  const createPreview = async () => {
    if (!selectedTarget || !instruction.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/delegation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `task-delegation:${taskId}:${selectedTarget.id}:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          agentId: selectedTarget.id,
          instruction: instruction.trim(),
          allowedActions: selectedTarget.allowedActions,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setPreview(await response.json() as DelegationPreview);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Preview could not be created');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmPreview = async () => {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/external-agents/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          dispatchId: preview.dispatchId,
          previewHash: preview.previewHash,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      toast.success(`Delegated "${taskTitle}" to ${selectedTarget?.name ?? 'execution target'}`);
      setPreview(null);
      setExpanded(false);
      setInstruction('');
      await load();
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : 'Delegation could not be confirmed');
    } finally {
      setSubmitting(false);
    }
  };

  const performAction = async (action: 'cancel' | 'retry') => {
    if (!current) return;
    setBusyAction(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/external-agents/dispatches/${encodeURIComponent(current.dispatchId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      toast.success(action === 'cancel' ? 'Execution cancelled' : 'Execution re-dispatched');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Delegation action failed');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className={cn(
      'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3',
      (mode === 'panel' || mode === 'mobile') && 'order-2',
      (mode === 'dialog' || mode === 'workspace') && 'col-start-2 row-span-2',
    )} aria-labelledby={`delegation-heading-${taskId}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot size={14} className="shrink-0 text-[var(--accent-400)]" aria-hidden="true" />
          <div className="min-w-0">
            <h3
              id={`delegation-heading-${taskId}`}
              className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
            >
              Execution
            </h3>
            {current && (
              <p className="truncate text-xs text-[var(--text-secondary)]">
                {current.targetName}
              </p>
            )}
          </div>
        </div>
        {!loading
          && !current?.canCancel
          && (context?.eligibleTargets.length ?? 0) > 0
          && (
          <button
            type="button"
            onClick={() => {
              setExpanded((value) => !value);
              setPreview(null);
              setError(null);
            }}
            aria-expanded={expanded}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Delegate...
            <ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} />
          </button>
          )}
      </div>

      {loading ? (
        <div className="mt-3 space-y-2" aria-label="Loading execution assignment">
          <div className="h-5 w-28 animate-pulse rounded bg-[var(--surface-2)]" />
          <div className="h-14 animate-pulse rounded-lg bg-[var(--surface-1)]" />
        </div>
      ) : error && !context ? (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-red-300" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 hover:bg-red-500/10"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      ) : (
        <>
          {context?.syncError && (
            <p className="mt-3 text-xs text-amber-300" role="status">
              Showing the last known state. Refresh failed: {context.syncError}
            </p>
          )}
          {current ? (
            <div className="mt-3">
              <AssignmentDetails
                assignment={current}
                busyAction={busyAction}
                onAction={(action) => void performAction(action)}
              />
            </div>
          ) : (
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              No execution target is assigned. The original task remains the canonical outcome.
            </p>
          )}

          {expanded && (
            <div className="mt-4 space-y-4 border-t border-[var(--border-subtle)] pt-4">
              {!context?.eligibleTargets.length ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No execution target is eligible under the task&apos;s current data policy.
                </p>
              ) : !preview ? (
                <>
                  <fieldset className="space-y-2">
                    <legend className="text-xs font-medium text-[var(--text-secondary)]">
                      Eligible execution targets
                    </legend>
                    {context.eligibleTargets.map((target: TaskDelegationTarget) => (
                      <label
                        key={target.id}
                        className={cn(
                          'flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors',
                          selectedTargetId === target.id
                            ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/8'
                            : 'border-[var(--border-subtle)] bg-[var(--surface-1)] hover:border-[var(--border)]',
                        )}
                      >
                        <input
                          type="radio"
                          name={`execution-target-${taskId}`}
                          value={target.id}
                          checked={selectedTargetId === target.id}
                          onChange={() => setSelectedTargetId(target.id)}
                          className="mt-0.5 accent-[var(--accent-500)]"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-[var(--text-primary)]">
                            {target.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                            {target.executionLocality.replaceAll('-', ' ')} · {target.dataClassification}
                            {target.description ? ` · ${target.description}` : ''}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <label className="block">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Instruction</span>
                    <div className="input-glow mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-0)]">
                      <textarea
                        value={instruction}
                        onChange={(event) => setInstruction(event.target.value)}
                        rows={4}
                        maxLength={32_000}
                        placeholder="Describe the outcome this executor should deliver."
                        className="w-full resize-y bg-transparent px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                      />
                    </div>
                  </label>
                  {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
                  <button
                    type="button"
                    disabled={!selectedTarget || !instruction.trim() || submitting}
                    onClick={() => void createPreview()}
                    className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-600)] px-4 text-sm font-medium text-white hover:bg-[var(--accent-500)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {submitting && <Loader2 size={14} className="animate-spin" />}
                    Review disclosure
                  </button>
                </>
              ) : (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                      Confirm delegation
                    </h4>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Verify the exact destination, locality, disclosed fields, and authorized actions.
                    </p>
                  </div>
                  <dl className="grid gap-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-[var(--text-muted)]">Destination</dt>
                      <dd className="mt-0.5 font-medium text-[var(--text-primary)]">{selectedTarget?.name}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-muted)]">Locality</dt>
                      <dd className="mt-0.5 text-[var(--text-secondary)]">{preview.processingLocation}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-muted)]">Classification</dt>
                      <dd className="mt-0.5 text-[var(--text-secondary)]">{preview.dataClassification}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-muted)]">Authorized actions</dt>
                      <dd className="mt-0.5 text-[var(--text-secondary)]">
                        {preview.allowedActions.length ? preview.allowedActions.join(', ') : 'No side effects'}
                      </dd>
                    </div>
                  </dl>
                  <div>
                    <p className="text-xs font-medium text-[var(--text-secondary)]">Disclosed fields</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {preview.disclosedFields.map((field) => (
                        <span key={field} className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
                          {field}
                        </span>
                      ))}
                    </div>
                  </div>
                  <details className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)]">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
                      Exact payload preview
                    </summary>
                    <pre className="max-h-64 overflow-auto border-t border-[var(--border-subtle)] p-3 text-xs leading-relaxed text-[var(--text-muted)]">
                      {JSON.stringify(preview.payloadPreview, null, 2)}
                    </pre>
                  </details>
                  {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => setPreview(null)}
                      className="min-h-10 rounded-lg border border-[var(--border)] px-4 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void confirmPreview()}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[var(--accent-600)] px-4 text-sm font-medium text-white hover:bg-[var(--accent-500)] disabled:opacity-50"
                    >
                      {submitting && <Loader2 size={14} className="animate-spin" />}
                      Confirm delegation
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
