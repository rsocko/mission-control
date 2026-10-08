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
  Send,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

interface PendingInteraction {
  id: string;
  kind: 'question' | 'approval';
  status: 'pending';
  prompt: string;
  choices?: string[];
}

function pendingInteraction(detail: RunDetail | null): PendingInteraction | null {
  const value = detail?.providerDetail?.interaction;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const interaction = value as Record<string, unknown>;
  if (
    typeof interaction.id !== 'string'
    || (interaction.kind !== 'question' && interaction.kind !== 'approval')
    || interaction.status !== 'pending'
    || typeof interaction.prompt !== 'string'
  ) return null;
  const choices = Array.isArray(interaction.choices)
    && interaction.choices.every((choice) => typeof choice === 'string')
    ? interaction.choices as string[]
    : undefined;
  return {
    id: interaction.id,
    kind: interaction.kind,
    status: 'pending',
    prompt: interaction.prompt,
    ...(choices ? { choices } : {}),
  };
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `Request failed (${response.status})`;
}

function StateLine({
  assignment,
  stale = false,
}: {
  assignment: TaskDelegationSummary;
  stale?: boolean;
}) {
  const presentation = STATE_PRESENTATION[assignment.displayState];
  const Icon = presentation.icon;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon size={14} className={cn('shrink-0', presentation.className)} aria-hidden="true" />
      <span className={cn('font-medium', presentation.className)}>
        {stale ? `Last known: ${presentation.label}` : presentation.label}
      </span>
      <span className="truncate text-[var(--text-muted)]">· {assignment.targetName}</span>
    </div>
  );
}

function assignmentMessage(assignment: TaskDelegationSummary) {
  if (assignment.blocker) return assignment.blocker;
  if (assignment.errorMessage) return assignment.errorMessage;
  if (assignment.latestProgress) return assignment.latestProgress;
  if (assignment.pendingApproval) return 'Approval is waiting for your review.';
  return null;
}

function stateDescription(assignment: TaskDelegationSummary) {
  const message = assignmentMessage(assignment);
  if (message) return message;
  switch (assignment.displayState) {
    case 'preview':
      return 'Review the assignment before sending it to the provider.';
    case 'queued':
      return 'GitHub accepted the task and is waiting to start it.';
    case 'running':
      return 'The provider reports that work is in progress.';
    case 'idle':
      return 'The provider has not reported active work.';
    case 'waiting_for_user':
      return 'The provider is waiting for your input.';
    case 'blocked':
      return 'The provider reports that work cannot continue.';
    case 'failed':
      return 'The provider reported that the run failed.';
    case 'timed_out':
      return 'The provider reported that the run exceeded its time limit.';
    case 'cancelled':
      return 'The run is no longer active.';
    case 'completed':
      if (assignment.pullRequestState === 'merged') {
        return 'The provider completed the run and its pull request was merged.';
      }
      if (assignment.pullRequestState === 'closed') {
        return 'The provider completed the run and its pull request was closed without merging.';
      }
      if (assignment.pullRequestState === 'draft') {
        return 'The provider completed the run and its draft pull request is ready for review.';
      }
      if (assignment.pullRequestState === 'open') {
        return 'The provider completed the run and its pull request is ready for review.';
      }
      return 'The provider reported that the run completed.';
  }
}

function pullRequestStatusLabel(assignment: TaskDelegationSummary) {
  switch (assignment.pullRequestState) {
    case 'draft':
      return 'Draft';
    case 'open':
      return 'Open';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    default:
      return null;
  }
}

function outputLinks(assignment: TaskDelegationSummary) {
  const links: Array<{
    href: string;
    label: string;
    icon: typeof ExternalLink;
  }> = [];
  if (assignment.pullRequestUrl) {
    links.push({
      href: assignment.pullRequestUrl,
      label: assignment.pullRequestState === 'merged' || assignment.pullRequestState === 'closed'
        ? 'View PR'
        : 'Review PR',
      icon: GitPullRequest,
    });
  }
  if (assignment.providerTaskUrl) {
    links.push({
      href: assignment.providerTaskUrl,
      label: assignment.targetType === 'copilot-cloud' ? 'Cloud Agent' : 'Provider task',
      icon: ExternalLink,
    });
  } else if (assignment.runUrl) {
    links.push({ href: assignment.runUrl, label: 'Provider run', icon: ExternalLink });
  }
  if (!links.length && assignment.issueUrl) {
    links.push({
      href: assignment.issueUrl,
      label: assignment.issueIdentifier ?? 'Provider issue',
      icon: ExternalLink,
    });
  }
  return links;
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
      const response = await fetch(
        `/api/tasks/${encodeURIComponent(taskId)}/delegation`,
      );
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
  const syncError = current
    ? context?.syncErrors.find((item) => item.dispatchId === current.dispatchId) ?? null
    : null;
  const outputLinksForCurrent = current ? outputLinks(current) : [];
  const pullRequestStatus = current ? pullRequestStatusLabel(current) : null;
  const currentDescription = current ? assignmentMessage(current) : null;

  return (
    <>
      <section
        className={cn(
          'overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-0)]/45',
          (mode === 'panel' || mode === 'mobile') && 'order-2',
          (mode === 'dialog' || mode === 'workspace') && 'col-start-2 row-span-2',
        )}
        aria-labelledby={`delegation-heading-${taskId}`}
      >
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3">
          <h3
            id={`delegation-heading-${taskId}`}
            className="flex items-center gap-2 text-sm font-semibold text-[var(--text-heading)]"
          >
            <GitMerge
              size={14}
              className={current
                ? STATE_PRESENTATION[current.displayState].className
                : 'text-[var(--text-tertiary)]'}
            />
            Delegation
          </h3>
          {!current && !loading && (
            <button
              type="button"
              onClick={() => openTaskDelegation([taskId])}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              <Send size={13} aria-hidden="true" />
              Delegate
            </button>
          )}
        </div>

        <div className="p-3">
          {loading ? (
            <div className="space-y-2" aria-label="Loading delegation">
              <div className="h-4 w-40 animate-pulse rounded bg-[var(--surface-2)]" />
              <div className="h-10 animate-pulse rounded bg-[var(--surface-1)]" />
            </div>
          ) : error && !context ? (
            <div className="flex items-center justify-between gap-3 text-xs text-red-300" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load()} className="min-h-8 rounded px-2 hover:bg-red-500/10">
                Retry
              </button>
            </div>
          ) : current ? (
            <div className="space-y-1.5 text-xs">
              <StateLine assignment={current} stale={Boolean(syncError)} />
              {currentDescription && (
                <p className="leading-relaxed text-[var(--text-secondary)]">
                  {currentDescription}
                </p>
              )}
              {syncError && (
                <p className="text-amber-200" role="status">
                  State refresh failed: {syncError.message}
                </p>
              )}
              {current.outputWarning && (
                <p className="text-amber-200" role="status">
                  {current.outputWarning}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--text-muted)]">
                <span>{current.locality.replaceAll('-', ' ')}</span>
                {current.baseRef && <span>Base {current.baseRef}</span>}
                {pullRequestStatus && (
                  <span>
                    PR{current.pullRequestNumber ? ` #${current.pullRequestNumber}` : ''} {pullRequestStatus.toLowerCase()}
                  </span>
                )}
                {current.displayState !== 'completed' && (
                  <span>Attempt {Math.max(current.attemptCount, 1)}/{current.maxAttempts}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex flex-wrap items-center gap-1">
                  {outputLinksForCurrent.map((link) => {
                    const OutputIcon = link.icon;
                    return (
                      <a
                        key={`${link.label}-${link.href}`}
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[var(--accent-300)] hover:bg-[var(--surface-2)]"
                      >
                        <OutputIcon size={12} />
                        {link.label}
                      </a>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => setDetailsOpen(true)}
                  className="min-h-8 rounded-md border border-[var(--border)] px-2.5 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                >
                  Details
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              No destination is assigned. Delegation preserves this task as the canonical source of truth.
            </p>
          )}
        </div>
      </section>

      {current && (
        <TaskDelegationRunDialog
          assignment={current}
          syncError={syncError?.message ?? null}
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
  syncError,
  open,
  onOpenChange,
  onUpdated,
}: {
  assignment: TaskDelegationSummary;
  syncError: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interactionAnswer, setInteractionAnswer] = useState('');
  const refreshInFlight = useRef(false);

  const load = useCallback(async (requestProviderRefresh = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const url = `/api/external-agents/dispatches/${encodeURIComponent(assignment.dispatchId)}`;
      const response = await fetch(url, requestProviderRefresh
        ? {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'refresh' }),
        }
        : undefined);
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as {
        dispatch: RunDetail;
        accepted?: boolean;
      };
      setDetail(body.dispatch);
      setInteractionAnswer('');
      if (requestProviderRefresh) {
        toast.success(
          body.accepted === false
            ? 'Provider state is already current'
            : 'Provider refresh queued',
        );
        await onUpdated();
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Run details could not be loaded');
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  }, [assignment.dispatchId, onUpdated]);

  useEffect(() => {
    if (!open) return;
    const observePersistedState = () => {
      void Promise.all([load(false), onUpdated()]);
    };
    const initialRefresh = window.setTimeout(observePersistedState, 0);
    const active = [
      'queued',
      'running',
      'idle',
      'waiting_for_user',
      'blocked',
    ].includes(assignment.displayState)
      || (
        assignment.displayState === 'completed'
        && assignment.createPullRequest
        && assignment.pullRequestState !== 'merged'
        && assignment.pullRequestState !== 'closed'
      );
    if (!active) return () => window.clearTimeout(initialRefresh);
    const interval = window.setInterval(observePersistedState, 5_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [
    assignment.createPullRequest,
    assignment.displayState,
    assignment.pullRequestState,
    load,
    onUpdated,
    open,
  ]);

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
          ? 'Delegation retry queued'
          : action === 'stop_tracking'
            ? 'Mission Control stopped tracking the provider task'
            : 'Cancellation requested',
      );
      await Promise.all([load(), onUpdated()]);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Delegation action failed');
    } finally {
      setBusyAction(null);
    }
  };

  const resolveInteraction = async (
    interaction: PendingInteraction,
    outcome: 'answered' | 'approved' | 'rejected',
  ) => {
    if (outcome === 'answered' && !interactionAnswer.trim()) {
      setError('Enter or select an answer before continuing.');
      return;
    }
    setBusyAction(`interaction-${outcome}`);
    setError(null);
    try {
      const response = await fetch(
        `/api/external-agents/dispatches/${encodeURIComponent(assignment.dispatchId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'resolve_interaction',
            interactionId: interaction.id,
            outcome,
            ...(outcome === 'answered' ? { answer: interactionAnswer.trim() } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      toast.success(
        outcome === 'answered'
          ? 'Answer saved for worker delivery'
          : outcome === 'approved'
            ? 'Approval saved for worker delivery'
            : 'Rejection saved for worker delivery',
      );
      await Promise.all([load(), onUpdated()]);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Response could not be saved');
    } finally {
      setBusyAction(null);
    }
  };

  const interaction = pendingInteraction(detail);
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
                    <StateLine assignment={assignment} stale={Boolean(syncError || error)} />
                    <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                      {stateDescription(assignment)}
                    </p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      {assignment.providerState && (
                        <>Provider state: <span className="font-mono">{assignment.providerState}</span> · </>
                      )}
                      Last synced{' '}
                      <time dateTime={assignment.updatedAt}>
                        {new Date(assignment.updatedAt).toLocaleString()}
                      </time>
                      {assignment.providerUpdatedAt && (
                        <>
                          {' '}· Provider updated{' '}
                          <time dateTime={assignment.providerUpdatedAt}>
                            {new Date(assignment.providerUpdatedAt).toLocaleString()}
                          </time>
                        </>
                      )}
                    </p>
                    {syncError && (
                      <p className="mt-2 text-xs text-amber-200" role="status">
                        Automatic refresh failed: {syncError}
                      </p>
                    )}
                    {assignment.outputWarning && (
                      <p className="mt-2 text-xs text-amber-200" role="status">
                        {assignment.outputWarning}
                      </p>
                    )}
                  </section>

                  {interaction && (
                    <section className="rounded-lg border border-amber-500/30 bg-amber-950/25 p-4" aria-labelledby={`interaction-${interaction.id}`}>
                      <div className="flex gap-3">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" />
                        <div className="min-w-0 flex-1">
                          <h3 id={`interaction-${interaction.id}`} className="text-sm font-semibold text-amber-100">
                            {interaction.kind === 'approval'
                              ? 'Scout needs your approval'
                              : 'Scout needs your answer'}
                          </h3>
                          <p className="mt-1 text-sm leading-relaxed text-amber-50/90">
                            {interaction.prompt}
                          </p>
                          {interaction.kind === 'question' && (
                            <div className="mt-3">
                              {interaction.choices ? (
                                <fieldset className="space-y-2">
                                  <legend className="sr-only">Choose an answer</legend>
                                  {interaction.choices.map((choice) => (
                                    <label key={choice} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-amber-700/40 px-3 text-xs text-amber-50 hover:bg-amber-900/30">
                                      <input
                                        type="radio"
                                        name={`interaction-answer-${interaction.id}`}
                                        value={choice}
                                        checked={interactionAnswer === choice}
                                        onChange={(event) => setInteractionAnswer(event.target.value)}
                                        disabled={Boolean(busyAction)}
                                        className="accent-[var(--accent)]"
                                      />
                                      {choice}
                                    </label>
                                  ))}
                                </fieldset>
                              ) : (
                                <label className="block text-xs font-medium text-amber-100">
                                  Answer
                                  <textarea
                                    value={interactionAnswer}
                                    onChange={(event) => setInteractionAnswer(event.target.value)}
                                    disabled={Boolean(busyAction)}
                                    rows={3}
                                    className="mt-1.5 w-full resize-y rounded-md border border-amber-700/40 bg-[var(--surface-0)] px-3 py-2 text-sm font-normal text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
                                  />
                                </label>
                              )}
                              <button
                                type="button"
                                disabled={Boolean(busyAction) || !interactionAnswer.trim()}
                                onClick={() => void resolveInteraction(interaction, 'answered')}
                                className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--accent-600)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:opacity-50"
                              >
                                {busyAction === 'interaction-answered'
                                  ? <Loader2 size={13} className="animate-spin" />
                                  : <Send size={13} />}
                                Send answer
                              </button>
                            </div>
                          )}
                          {interaction.kind === 'approval' && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={Boolean(busyAction)}
                                onClick={() => void resolveInteraction(interaction, 'approved')}
                                className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--accent-600)] px-3 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:opacity-50"
                              >
                                {busyAction === 'interaction-approved'
                                  ? <Loader2 size={13} className="animate-spin" />
                                  : <CheckCircle2 size={13} />}
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(busyAction)}
                                onClick={() => void resolveInteraction(interaction, 'rejected')}
                                className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-red-500/40 px-3 text-xs font-medium text-red-200 hover:bg-red-950/40 disabled:opacity-50"
                              >
                                <X size={13} />
                                Reject
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                  )}

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

                  {(assignment.pullRequestUrl || assignment.providerTaskUrl || assignment.branchRef || assignment.commitSha || references.length > 0) && (
                    <section>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Outputs</h3>
                      <div className="mt-2 space-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-2">
                        {assignment.pullRequestUrl && (
                          <RunReference href={assignment.pullRequestUrl} icon={GitPullRequest}>
                            Pull request
                            {assignment.pullRequestNumber ? ` #${assignment.pullRequestNumber}` : ''}
                            {pullRequestStatusLabel(assignment)
                              ? ` · ${pullRequestStatusLabel(assignment)}`
                              : ''}
                          </RunReference>
                        )}
                        {assignment.providerTaskUrl && (
                          <RunReference href={assignment.providerTaskUrl} icon={ExternalLink}>
                            {assignment.targetType === 'copilot-cloud'
                              ? 'Open Cloud Agent session'
                              : 'Open provider task'}
                          </RunReference>
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
                        ['Provider state', assignment.providerState],
                        ['Pull request', pullRequestStatusLabel(assignment)],
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
                      onClick={() => void load(true)}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
                      Request refresh
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
