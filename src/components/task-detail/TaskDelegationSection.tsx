'use client';

import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  openTaskDelegation,
  TASK_DELEGATION_UPDATED_EVENT,
} from '@/components/task-delegation/events';
import type {
  TaskDelegationContext,
  TaskDelegationDisplayState,
  TaskDelegationSummary,
} from '@/lib/external-agents/task-delegation';
import type { TaskDetailMode } from './task-detail-types';

const STATE_PRESENTATION: Record<TaskDelegationDisplayState, {
  label: string;
  className: string;
  icon: typeof CheckCircle2;
}> = {
  preview: { label: 'Review', className: 'text-amber-300', icon: CheckCircle2 },
  queued: { label: 'Queued', className: 'text-slate-300', icon: Loader2 },
  running: { label: 'Running', className: 'text-blue-300', icon: RefreshCw },
  idle: { label: 'Idle', className: 'text-slate-300', icon: Loader2 },
  waiting_for_user: { label: 'Waiting for you', className: 'text-amber-300', icon: Loader2 },
  blocked: { label: 'Blocked', className: 'text-orange-300', icon: AlertTriangle },
  failed: { label: 'Failed', className: 'text-red-300', icon: AlertTriangle },
  timed_out: { label: 'Timed out', className: 'text-red-300', icon: AlertTriangle },
  cancelled: { label: 'Cancelled', className: 'text-slate-300', icon: AlertTriangle },
  completed: { label: 'Completed', className: 'text-emerald-300', icon: CheckCircle2 },
};

interface RunDetail {
  id: string;
  providerTaskId: string | null;
  providerDetail: Record<string, unknown> | null;
  attempts: Array<{
    id: string;
    attemptNumber: number;
    status: string;
    startedAt: string;
    completedAt: string | null;
    errorMessage: string | null;
  }>;
  events: Array<{
    id: number;
    eventType: string;
    detail: Record<string, unknown>;
    createdAt: string;
  }>;
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `Request failed (${response.status})`;
}

function StateLine({ assignment }: { assignment: TaskDelegationSummary }) {
  const presentation = STATE_PRESENTATION[assignment.displayState];
  const Icon = presentation.icon;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon size={14} className={cn('shrink-0', presentation.className)} aria-hidden="true" />
      <span className={cn('font-medium', presentation.className)}>{presentation.label}</span>
      <span className="truncate text-[var(--text-muted)]">· {assignment.targetName}</span>
    </div>
  );
}

function outputLink(assignment: TaskDelegationSummary) {
  if (assignment.pullRequestUrl) {
    return { href: assignment.pullRequestUrl, label: 'Pull request', icon: GitPullRequest };
  }
  if (assignment.runUrl) {
    return { href: assignment.runUrl, label: 'Provider run', icon: ExternalLink };
  }
  if (assignment.issueUrl) {
    return {
      href: assignment.issueUrl,
      label: assignment.issueIdentifier ?? 'Provider issue',
      icon: ExternalLink,
    };
  }
  return null;
}

export function TaskDelegationSection({
  taskId,
  mode,
}: {
  taskId: string;
  taskTitle: string;
  mode: TaskDetailMode;
}) {
  const [context, setContext] = useState<TaskDelegationContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/delegation`);
      if (!response.ok) throw new Error(await responseError(response));
      setContext(await response.json() as TaskDelegationContext);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Delegation could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
    const refresh = (event: Event) => {
      const ids = (event as CustomEvent<{ taskIds?: string[] }>).detail?.taskIds ?? [];
      if (ids.includes(taskId)) void load();
    };
    window.addEventListener(TASK_DELEGATION_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(TASK_DELEGATION_UPDATED_EVENT, refresh);
  }, [load, taskId]);

  const current = context?.assignments?.[0] ?? null;
  const relevantOutput = current ? outputLink(current) : null;
  const OutputIcon = relevantOutput?.icon;

  return (
    <>
      <section
        className={cn(
          'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/45 p-3',
          (mode === 'panel' || mode === 'mobile') && 'order-2',
          (mode === 'dialog' || mode === 'workspace') && 'col-start-2 row-span-2',
        )}
        aria-labelledby={`delegation-heading-${taskId}`}
      >
        <div className="flex items-center justify-between gap-3">
          <h3
            id={`delegation-heading-${taskId}`}
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
          >
            <GitMerge size={14} className="text-[var(--accent-400)]" />
            Delegation
          </h3>
          {!current && !loading && (
            <button
              type="button"
              onClick={() => openTaskDelegation([taskId])}
              className="min-h-9 rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              Delegate
            </button>
          )}
        </div>

        {loading ? (
          <div className="mt-3 space-y-2" aria-label="Loading delegation">
            <div className="h-4 w-40 animate-pulse rounded bg-[var(--surface-2)]" />
            <div className="h-10 animate-pulse rounded bg-[var(--surface-1)]" />
          </div>
        ) : error && !context ? (
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-red-300" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void load()} className="min-h-8 rounded px-2 hover:bg-red-500/10">
              Retry
            </button>
          </div>
        ) : current ? (
          <div className="mt-3 space-y-2 text-xs">
            <StateLine assignment={current} />
            <p className="leading-relaxed text-[var(--text-secondary)]">
              {current.blocker
                ?? current.errorMessage
                ?? current.latestProgress
                ?? (current.pendingApproval
                  ? 'Approval is waiting for your review.'
                  : 'Provider state is current.')}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--text-muted)]">
              <span>{current.locality.replaceAll('-', ' ')}</span>
              {current.baseRef && <span>Base {current.baseRef}</span>}
              <span>Attempt {Math.max(current.attemptCount, 1)} of {current.maxAttempts}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              {relevantOutput && OutputIcon ? (
                <a
                  href={relevantOutput.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[var(--accent-300)] hover:bg-[var(--surface-2)]"
                >
                  <OutputIcon size={12} />
                  {relevantOutput.label}
                </a>
              ) : <span />}
              <button
                type="button"
                onClick={() => setDetailsOpen(true)}
                className="min-h-8 rounded-md border border-[var(--border)] px-2.5 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              >
                More details
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
            No destination is assigned. Delegation preserves this task as the canonical source of truth.
          </p>
        )}
      </section>

      {current && (
        <TaskDelegationRunDialog
          assignment={current}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          onUpdated={load}
        />
      )}
    </>
  );
}

function TaskDelegationRunDialog({
  assignment,
  open,
  onOpenChange,
  onUpdated,
}: {
  assignment: TaskDelegationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/external-agents/dispatches/${encodeURIComponent(assignment.dispatchId)}`,
      );
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as { dispatch: RunDetail };
      setDetail(body.dispatch);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Run details could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [assignment.dispatchId]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const act = async (action: 'cancel' | 'stop_tracking' | 'retry') => {
    setBusyAction(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/external-agents/dispatches/${encodeURIComponent(assignment.dispatchId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      toast.success(
        action === 'retry'
          ? 'Delegation retried'
          : action === 'stop_tracking'
            ? 'Mission Control stopped tracking the provider task'
            : 'Delegation cancelled',
      );
      await Promise.all([load(), onUpdated()]);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Delegation action failed');
    } finally {
      setBusyAction(null);
    }
  };

  const references = [
    ...(assignment.checks ?? []).map((reference) => ({ ...reference, kind: 'Check' })),
    ...(assignment.artifacts ?? []).map((reference) => ({ ...reference, kind: 'Artifact' })),
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[130] bg-black/70 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[131] max-h-[min(760px,calc(100dvh-24px))] w-[min(880px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl focus:outline-none">
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-4 sm:px-5">
            <div>
              <Dialog.Title className="text-base font-semibold text-[var(--text-primary)]">
                {assignment.targetName} run
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-[var(--text-muted)]">
                Durable assignment, provider state, outputs, and attempts.
              </Dialog.Description>
            </div>
            <Dialog.Close className="flex min-h-10 min-w-10 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]" aria-label="Close run details">
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="max-h-[calc(min(760px,100dvh-24px)-142px)] overflow-y-auto p-4 sm:p-5">
            {loading && !detail ? (
              <div className="space-y-3">
                <div className="h-16 animate-pulse rounded-lg bg-[var(--surface-2)]" />
                <div className="h-40 animate-pulse rounded-lg bg-[var(--surface-2)]" />
              </div>
            ) : (
              <div className="grid gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(260px,.8fr)]">
                <div className="min-w-0 space-y-5">
                  <section>
                    <StateLine assignment={assignment} />
                    <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                      {assignment.blocker
                        ?? assignment.errorMessage
                        ?? assignment.latestProgress
                        ?? 'No additional provider progress is available.'}
                    </p>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Timeline</h3>
                    <ol className="mt-2 overflow-hidden rounded-lg border border-[var(--border-subtle)]">
                      {(detail?.events ?? []).map((event) => (
                        <li key={event.id} className="grid grid-cols-[12px_minmax(0,1fr)_auto] gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2 text-xs last:border-b-0">
                          <span className="mt-1 h-2 w-2 rounded-full bg-[var(--accent)]" />
                          <span className="text-[var(--text-secondary)]">{event.eventType.replaceAll('_', ' ')}</span>
                          <time className="font-mono tabular-nums text-[var(--text-muted)]">
                            {new Date(event.createdAt).toLocaleString()}
                          </time>
                        </li>
                      ))}
                      {!detail?.events.length && (
                        <li className="bg-[var(--surface-0)] px-3 py-3 text-xs text-[var(--text-muted)]">
                          No timeline events are available.
                        </li>
                      )}
                    </ol>
                  </section>

                  {(assignment.pullRequestUrl || assignment.branchRef || assignment.commitSha || references.length > 0) && (
                    <section>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Outputs</h3>
                      <div className="mt-2 space-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-2">
                        {assignment.pullRequestUrl && (
                          <RunReference href={assignment.pullRequestUrl} icon={GitPullRequest}>Pull request</RunReference>
                        )}
                        {assignment.branchRef && (
                          <div className="flex min-h-8 items-center gap-2 px-2 text-xs text-[var(--text-secondary)]">
                            <GitBranch size={13} /><span className="truncate font-mono">{assignment.branchRef}</span>
                          </div>
                        )}
                        {assignment.commitSha && (
                          <div className="flex min-h-8 items-center gap-2 px-2 text-xs text-[var(--text-secondary)]">
                            <GitCommit size={13} /><span className="font-mono">{assignment.commitSha}</span>
                          </div>
                        )}
                        {references.map((reference, index) => (
                          reference.url
                            ? (
                              <RunReference key={`${reference.kind}-${reference.name}-${index}`} href={reference.url} icon={ExternalLink}>
                                {reference.kind}: {reference.name}
                              </RunReference>
                            )
                            : (
                              <div key={`${reference.kind}-${reference.name}-${index}`} className="px-2 py-1 text-xs text-[var(--text-secondary)]">
                                {reference.kind}: {reference.name}
                              </div>
                            )
                        ))}
                      </div>
                    </section>
                  )}

                  {assignment.cancellationLimitation && (
                    <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
                      {assignment.cancellationLimitation}
                    </div>
                  )}
                </div>

                <aside className="min-w-0 space-y-4">
                  <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Execution</h3>
                    <dl className="mt-3 space-y-2 text-xs">
                      {[
                        ['Destination', assignment.targetName],
                        ['Locality', assignment.locality.replaceAll('-', ' ')],
                        ['Repository', assignment.repository],
                        ['Base ref', assignment.baseRef],
                        ['Model', assignment.model ?? 'Auto'],
                        ['Attempt', `${Math.max(assignment.attemptCount, 1)} of ${assignment.maxAttempts}`],
                        ['Provider task', assignment.providerTaskId],
                        ['Run ID', assignment.runId],
                        ['Dispatch ID', assignment.dispatchId],
                      ].filter(([, value]) => Boolean(value)).map(([label, value]) => (
                        <div key={label} className="grid grid-cols-[90px_minmax(0,1fr)] gap-2">
                          <dt className="text-[var(--text-muted)]">{label}</dt>
                          <dd className="break-all text-right font-mono text-[var(--text-secondary)]">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>

                  <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Disclosure</h3>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {assignment.disclosedFields.map((field) => (
                        <span key={field} className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
                          {field}
                        </span>
                      ))}
                    </div>
                    <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Actions</h3>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {assignment.allowedActions.map((action) => (
                        <span key={action} className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
                          {action.replaceAll('_', ' ')}
                        </span>
                      ))}
                    </div>
                  </section>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={loading || Boolean(busyAction)}
                      onClick={() => void load()}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
                      Refresh
                    </button>
                    {assignment.canRetry && (
                      <button
                        type="button"
                        disabled={Boolean(busyAction)}
                        onClick={() => void act('retry')}
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                      >
                        {busyAction === 'retry' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                        Retry
                      </button>
                    )}
                    {assignment.canCancel && (
                      <button
                        type="button"
                        disabled={Boolean(busyAction)}
                        onClick={() => void act('cancel')}
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-red-500/30 px-3 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        <AlertTriangle size={13} />
                        Cancel
                      </button>
                    )}
                    {assignment.canStopTracking && (
                      <button
                        type="button"
                        disabled={Boolean(busyAction)}
                        onClick={() => void act('stop_tracking')}
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-amber-500/30 px-3 text-xs text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
                      >
                        <AlertTriangle size={13} />
                        Stop tracking
                      </button>
                    )}
                  </div>
                </aside>
              </div>
            )}
            {error && (
              <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
                {error}
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RunReference({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: typeof ExternalLink;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex min-h-8 items-center gap-2 rounded px-2 text-xs text-[var(--accent-300)] hover:bg-[var(--surface-2)]"
    >
      <Icon size={13} />
      <span className="truncate">{children}</span>
      <ExternalLink size={11} className="ml-auto shrink-0" />
    </a>
  );
}
