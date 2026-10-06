'use client';

import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudCog,
  Clock,
  Loader2,
  Lock,
  Send,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type {
  TaskDelegationContext,
  TaskDelegationTarget,
} from '@/lib/external-agents/task-delegation';
import type { PaperclipProviderConfig } from '@/lib/external-agents/contracts';
import {
  notifyTaskDelegationUpdated,
  TASK_DELEGATION_OPEN_EVENT,
} from './events';
import { ExecutionDestinationIcon } from './ExecutionDestinationIcon';

type WizardStep = 'destination' | 'configure' | 'review';

interface DelegationPreview {
  taskId: string;
  dispatchId: string;
  previewHash: string;
  processingLocation: string;
  dataClassification: string;
  classificationExplanation?: string;
  classificationSources?: NonNullable<
    TaskDelegationTarget['eligibility'][number]['classificationSources']
  >;
  disclosedFields: string[];
  allowedActions: string[];
  payloadPreview: Record<string, unknown>;
}

interface PaperclipOptions {
  companies: Array<{ id: string; name: string; status: string | null }>;
  projects: Array<{ id: string; name: string; status: string | null }>;
  agents: Array<{
    id: string;
    name: string;
    title: string | null;
    role: string | null;
    status: string | null;
    adapterType: string | null;
  }>;
}

interface PreviewBatch {
  previews: DelegationPreview[];
  blocked: TaskDelegationTarget['eligibility'];
  readyCount: number;
  blockedCount: number;
}

interface ConfirmationProgress {
  active: number;
  completed: number;
  total: number;
}

const STEP_ORDER: WizardStep[] = ['destination', 'configure', 'review'];
const STEP_LABELS: Record<WizardStep, string> = {
  destination: 'Destination',
  configure: 'Configure',
  review: 'Review',
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Delegation request failed';
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as {
    error?: string;
    message?: string;
  } | null;
  return body?.error ?? body?.message ?? `Request failed (${response.status})`;
}

function targetSubtitle(target: TaskDelegationTarget) {
  if (target.type === 'copilot-cloud') return 'Direct GitHub-hosted Agent Task';
  if (target.type === 'pull-queue') return 'Scheduled pickup from Mission Control';
  return 'Configured Paperclip execution route';
}

export function TaskDelegationDialog() {
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>('destination');
  const [context, setContext] = useState<TaskDelegationContext | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [repository, setRepository] = useState('');
  const [baseRef, setBaseRef] = useState('main');
  const [model, setModel] = useState('');
  const [createPullRequest, setCreatePullRequest] = useState(true);
  const [markInProgress, setMarkInProgress] = useState(true);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [timeoutHours, setTimeoutHours] = useState(24);
  const [allowedActions, setAllowedActions] = useState<string[]>([]);
  const [operationId, setOperationId] = useState('');
  const [previewBatch, setPreviewBatch] = useState<PreviewBatch | null>(null);
  const [confirmationProgress, setConfirmationProgress] =
    useState<ConfirmationProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paperclipOptions, setPaperclipOptions] = useState<PaperclipOptions | null>(null);
  const [paperclipBinding, setPaperclipBinding] = useState<PaperclipProviderConfig | null>(null);
  const [loadingPaperclipOptions, setLoadingPaperclipOptions] = useState(false);
  const [paperclipOptionsError, setPaperclipOptionsError] = useState<string | null>(null);
  const contextRequestRef = useRef(0);
  const paperclipRequestRef = useRef(0);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;

    wasOpenRef.current = false;
    // Radix can retain its body pointer lock when a global refresh races modal teardown.
    const timeoutId = window.setTimeout(() => {
      const openModal = document.querySelector(
        '[data-state="open"]:is([role="dialog"], [role="alertdialog"], [role="menu"])',
      );
      if (!openModal && document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = '';
      }
    }, 200);
    return () => window.clearTimeout(timeoutId);
  }, [open]);

  const reset = useCallback((ids: string[]) => {
    setTaskIds(ids);
    setStep('destination');
    setContext(null);
    setSelectedTargetId('');
    setInstruction('');
    setRepository('');
    setBaseRef('main');
    setModel('');
    setCreatePullRequest(true);
    setMarkInProgress(true);
    setMaxAttempts(3);
    setTimeoutHours(24);
    setAllowedActions([]);
    setOperationId(crypto.randomUUID());
    setPreviewBatch(null);
    setConfirmationProgress(null);
    setError(null);
    setPaperclipOptions(null);
    setPaperclipBinding(null);
    setPaperclipOptionsError(null);
    paperclipRequestRef.current += 1;
  }, []);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const ids = (event as CustomEvent<{ taskIds?: unknown }>).detail?.taskIds;
      if (!Array.isArray(ids)) return;
      const normalized = [...new Set(ids.filter(
        (value): value is string => typeof value === 'string' && Boolean(value),
      ))];
      if (!normalized.length) return;
      reset(normalized);
      setOpen(true);
    };
    window.addEventListener(TASK_DELEGATION_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(TASK_DELEGATION_OPEN_EVENT, handleOpen);
  }, [reset]);

  const loadContext = useCallback(async (
    ids: string[],
    requestId: number,
    signal: AbortSignal,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      ids.forEach((taskId) => query.append('taskId', taskId));
      const response = await fetch(
        `/api/tasks/delegation?${query.toString()}`,
        { signal },
      );
      if (!response.ok) throw new Error(await responseError(response));
      const next = await response.json() as TaskDelegationContext;
      if (requestId !== contextRequestRef.current || signal.aborted) return;
      setContext(next);
      const eligibleTargets = next.targets.filter((target) =>
        target.eligibility.some(({ ready }) => ready));
      const initial = eligibleTargets.length === 1 ? eligibleTargets[0] : null;
      if (initial) {
        setSelectedTargetId(initial.id);
        setAllowedActions(initial.allowedActions);
      }
    } catch (loadError) {
      if (requestId !== contextRequestRef.current || signal.aborted) return;
      setError(errorMessage(loadError));
    } finally {
      if (requestId === contextRequestRef.current && !signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const requestId = ++contextRequestRef.current;
    if (!open || !taskIds.length) return;
    const controller = new AbortController();
    void loadContext(taskIds, requestId, controller.signal);
    return () => controller.abort();
  }, [loadContext, open, taskIds]);

  const selectedTarget = useMemo(
    () => context?.targets.find(({ id }) => id === selectedTargetId) ?? null,
    [context?.targets, selectedTargetId],
  );
  const ready = selectedTarget?.eligibility.filter(({ ready: value }) => value) ?? [];
  const blocked = selectedTarget?.eligibility.filter(({ ready: value }) => !value) ?? [];
  const needsRepository = selectedTarget?.type === 'copilot-cloud'
    && ready.some(({ repositoryLocked }) => !repositoryLocked);
  const currentStepIndex = STEP_ORDER.indexOf(step);

  useEffect(() => {
    if (!selectedTarget) return;
    setAllowedActions(selectedTarget.allowedActions);
    setPreviewBatch(null);
    if (
      selectedTarget.type === 'copilot-cloud'
      && selectedTarget.repositories.length === 1
    ) {
      setRepository(selectedTarget.repositories[0].repository);
    }
    if (selectedTarget.type === 'paperclip' && selectedTarget.paperclipBinding) {
      const binding = {
        companyId: selectedTarget.paperclipBinding.companyId,
        assigneeAgentId: selectedTarget.paperclipBinding.assigneeAgentId,
        ...(selectedTarget.paperclipBinding.projectId
          ? { projectId: selectedTarget.paperclipBinding.projectId }
          : {}),
        ...(selectedTarget.paperclipBinding.requiredAdapterType
          ? { requiredAdapterType: selectedTarget.paperclipBinding.requiredAdapterType }
          : {}),
      };
      setPaperclipBinding(binding);
      void loadPaperclipOptions(selectedTarget.id, binding.companyId);
    } else {
      paperclipRequestRef.current += 1;
      setPaperclipBinding(null);
      setPaperclipOptions(null);
    }
  }, [selectedTarget]);

  async function loadPaperclipOptions(targetId: string, companyId: string) {
    const requestId = ++paperclipRequestRef.current;
    setLoadingPaperclipOptions(true);
    setPaperclipOptionsError(null);
    try {
      const response = await fetch('/api/external-agents/paperclip/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationId: targetId, companyId }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const options = await response.json() as PaperclipOptions;
      if (requestId !== paperclipRequestRef.current) return;
      setPaperclipOptions(options);
    } catch (optionsError) {
      if (requestId !== paperclipRequestRef.current) return;
      setPaperclipOptionsError(errorMessage(optionsError));
    } finally {
      if (requestId === paperclipRequestRef.current) {
        setLoadingPaperclipOptions(false);
      }
    }
  }

  const createPreviews = async () => {
    if (!selectedTarget) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/tasks/delegation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIds,
          agentId: selectedTarget.id,
          instruction: instruction.trim() || undefined,
          operationId,
          allowedActions,
          ...(selectedTarget.type === 'copilot-cloud'
            ? {
              repository: needsRepository ? repository : undefined,
              baseRef: baseRef.trim(),
              model: model || undefined,
              createPullRequest,
            }
            : {}),
          ...(selectedTarget.type === 'paperclip' && paperclipBinding
            ? { paperclipBinding }
            : {}),
          maxAttempts,
          timeoutMs: timeoutHours * 60 * 60_000,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setPreviewBatch(await response.json() as PreviewBatch);
      setStep('review');
    } catch (previewError) {
      setError(errorMessage(previewError));
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = async () => {
    if (!previewBatch?.previews.length) return;
    setSubmitting(true);
    setConfirmationProgress({
      active: 1,
      completed: 0,
      total: previewBatch.previews.length,
    });
    setError(null);
    const delegationFailures: string[] = [];
    const statusFailures: string[] = [];
    const confirmedTaskIds: string[] = [];
    let confirmed = 0;
    for (const [index, preview] of previewBatch.previews.entries()) {
      setConfirmationProgress({
        active: index + 1,
        completed: index,
        total: previewBatch.previews.length,
      });
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
        const body = await response.json() as {
          dispatch?: { status?: string };
        };
        const status = body.dispatch?.status;
        if (
          !status
          || ['needs_confirmation', 'failed', 'timed_out', 'dead_letter', 'cancelled']
            .includes(status)
        ) {
          throw new Error(`Delegation ended in ${status ?? 'an unknown state'}`);
        }
        confirmed += 1;
        confirmedTaskIds.push(preview.taskId);
        if (markInProgress) {
          try {
            const statusResponse = await fetch(`/api/tasks/${preview.taskId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'in_progress' }),
            });
            if (!statusResponse.ok) {
              throw new Error(await responseError(statusResponse));
            }
          } catch (statusError) {
            statusFailures.push(`${preview.taskId}: ${errorMessage(statusError)}`);
          }
        }
      } catch (confirmError) {
        delegationFailures.push(`${preview.taskId}: ${errorMessage(confirmError)}`);
      } finally {
        setConfirmationProgress({
          active: Math.min(index + 2, previewBatch.previews.length),
          completed: index + 1,
          total: previewBatch.previews.length,
        });
      }
    }
    setSubmitting(false);
    setConfirmationProgress(null);
    if (delegationFailures.length || statusFailures.length) {
      if (confirmedTaskIds.length) {
        notifyTaskDelegationUpdated(confirmedTaskIds);
      }
      const details = [
        delegationFailures.length
          ? `${delegationFailures.length} delegation${delegationFailures.length === 1 ? '' : 's'} failed: ${delegationFailures.join('; ')}`
          : null,
        statusFailures.length
          ? `${statusFailures.length} task status update${statusFailures.length === 1 ? '' : 's'} failed: ${statusFailures.join('; ')}`
          : null,
      ].filter(Boolean).join(' ');
      setError(`${confirmed} delegation${confirmed === 1 ? '' : 's'} confirmed. ${details}`);
      return;
    }
    setOpen(false);
    requestAnimationFrame(() => {
      notifyTaskDelegationUpdated(confirmedTaskIds);
      toast.success(
        `${confirmed} task${confirmed === 1 ? '' : 's'} queued for ${selectedTarget?.name}`,
      );
    });
  };

  const canContinueConfiguration = Boolean(
    selectedTarget
    && ready.length
    && (!needsRepository || repository)
    && (selectedTarget.type !== 'paperclip' || Boolean(
      paperclipBinding?.companyId && paperclipBinding.assigneeAgentId,
    ))
    && (selectedTarget.type !== 'copilot-cloud' || baseRef.trim()),
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/70 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[121] flex max-h-[min(760px,calc(100dvh-24px))] w-[min(760px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl focus:outline-none"
          aria-describedby="task-delegation-description"
          aria-busy={submitting}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-4 sm:px-5">
            <div>
              <Dialog.Title className="text-base font-semibold text-[var(--text-primary)]">
                Delegate {taskIds.length === 1 ? 'task' : `${taskIds.length} tasks`}
              </Dialog.Title>
              <Dialog.Description
                id="task-delegation-description"
                className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]"
              >
                Review the destination, eligibility, and exact disclosure before work is sent.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="flex min-h-10 min-w-10 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              aria-label="Close delegation"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          <ol className="grid grid-cols-3 border-b border-[var(--border-subtle)]" aria-label="Delegation steps">
            {STEP_ORDER.map((item, index) => (
              <li
                key={item}
                className={cn(
                  'border-b-2 px-3 py-2 text-xs font-medium',
                  item === step
                    ? 'border-[var(--accent)] text-[var(--text-primary)]'
                    : index < currentStepIndex
                      ? 'border-transparent text-[var(--accent-300)]'
                      : 'border-transparent text-[var(--text-muted)]',
                )}
                aria-current={item === step ? 'step' : undefined}
              >
                <span className="mr-1.5 font-mono tabular-nums">{index + 1}</span>
                {STEP_LABELS[item]}
              </li>
            ))}
          </ol>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {loading ? (
              <div className="space-y-3" aria-label="Loading delegation destinations">
                <div className="h-16 animate-pulse rounded-lg bg-[var(--surface-2)]" />
                <div className="h-16 animate-pulse rounded-lg bg-[var(--surface-2)]" />
              </div>
            ) : step === 'destination' ? (
              <DestinationStep
                context={context}
                selectedTargetId={selectedTargetId}
                onSelect={(target) => {
                  setSelectedTargetId(target.id);
                  setAllowedActions(target.allowedActions);
                  setError(null);
                }}
              />
            ) : step === 'configure' && selectedTarget ? (
              <ConfigureStep
                target={selectedTarget}
                instruction={instruction}
                onInstructionChange={setInstruction}
                repository={repository}
                onRepositoryChange={setRepository}
                needsRepository={needsRepository}
                baseRef={baseRef}
                onBaseRefChange={setBaseRef}
                model={model}
                onModelChange={setModel}
                createPullRequest={createPullRequest}
                onCreatePullRequestChange={setCreatePullRequest}
                markInProgress={markInProgress}
                onMarkInProgressChange={setMarkInProgress}
                allowedActions={allowedActions}
                onAllowedActionsChange={setAllowedActions}
                maxAttempts={maxAttempts}
                onMaxAttemptsChange={setMaxAttempts}
                timeoutHours={timeoutHours}
                onTimeoutHoursChange={setTimeoutHours}
                paperclipOptions={paperclipOptions}
                paperclipBinding={paperclipBinding}
                onPaperclipBindingChange={setPaperclipBinding}
                loadingPaperclipOptions={loadingPaperclipOptions}
                paperclipOptionsError={paperclipOptionsError}
                onPaperclipCompanyChange={(companyId) => {
                  if (!selectedTarget.paperclipBinding) return;
                  setPaperclipBinding({
                    companyId,
                    assigneeAgentId: '',
                  });
                  void loadPaperclipOptions(selectedTarget.id, companyId);
                }}
              />
            ) : step === 'review' && selectedTarget && previewBatch ? (
              <ReviewStep
                target={selectedTarget}
                batch={previewBatch}
                baseRef={baseRef}
                model={model}
                createPullRequest={createPullRequest}
                markInProgress={markInProgress}
                paperclipBinding={paperclipBinding}
                paperclipOptions={paperclipOptions}
              />
            ) : null}

            {step === 'review' && confirmationProgress && selectedTarget && (
              <DelegationHandoffProgress
                progress={confirmationProgress}
                targetName={selectedTarget.name}
              />
            )}

            {error && (
              <div
                role="alert"
                className="mt-4 flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <footer className="flex flex-col-reverse gap-2 border-t border-[var(--border-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="text-xs text-[var(--text-muted)]">
              {selectedTarget && (
                <>
                  <span className="font-medium text-emerald-300">{ready.length} ready</span>
                  {blocked.length > 0 && (
                    <span className="ml-2 font-medium text-amber-300">
                      {blocked.length} blocked
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="flex justify-end gap-2">
              {step !== 'destination' && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setError(null);
                    setStep(step === 'review' ? 'configure' : 'destination');
                  }}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                >
                  <ChevronLeft size={13} />
                  Back
                </button>
              )}
              {step === 'destination' && (
                <button
                  type="button"
                  disabled={!selectedTarget || loading}
                  onClick={() => setStep('configure')}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--accent-600)] px-4 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Configure
                  <ChevronRight size={13} />
                </button>
              )}
              {step === 'configure' && (
                <button
                  type="button"
                  disabled={!canContinueConfiguration || submitting}
                  onClick={() => void createPreviews()}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--accent-600)] px-4 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:cursor-not-allowed disabled:bg-[var(--surface-2)] disabled:text-[var(--text-muted)]"
                >
                  {submitting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Review {ready.length} delegation{ready.length === 1 ? '' : 's'}
                </button>
              )}
              {step === 'review' && (
                <button
                  type="button"
                  disabled={!previewBatch?.previews.length || submitting}
                  onClick={() => void confirm()}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--accent-600)] px-4 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2
                        size={13}
                        className="animate-spin motion-reduce:hidden"
                        aria-hidden="true"
                      />
                      <Send
                        size={13}
                        className="hidden motion-reduce:block"
                        aria-hidden="true"
                      />
                    </>
                  ) : (
                    <Send size={13} />
                  )}
                  {confirmationProgress
                    ? `Queueing ${confirmationProgress.active} of ${confirmationProgress.total}…`
                    : `Confirm and delegate ${previewBatch?.readyCount ?? 0}`}
                </button>
              )}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DelegationHandoffProgress({
  progress,
  targetName,
}: {
  progress: ConfirmationProgress;
  targetName: string;
}) {
  const percentage = Math.round((progress.completed / progress.total) * 100);
  const message = progress.completed === 0
    ? `Sending delegation ${progress.active} of ${progress.total} to the Mission Control worker.`
    : progress.completed < progress.total
      ? `${progress.completed} queued. Sending ${progress.active} of ${progress.total} to the worker.`
      : `All ${progress.total} delegations are queued for the worker.`;

  return (
    <section
      className="mt-4 rounded-lg border border-[var(--accent-500)]/35 bg-[var(--accent-500)]/8 p-3"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--accent-500)]/15 text-[var(--accent-300)]">
          <CloudCog
            size={16}
            className="animate-pulse motion-reduce:animate-none"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">
              Queueing work with {targetName}
            </h3>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--accent-300)]">
              {progress.completed}/{progress.total}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
            {message}
          </p>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]"
            role="progressbar"
            aria-label="Delegation handoff progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
            aria-valuetext={`${progress.completed} of ${progress.total} queued`}
          >
            <div
              className="h-full rounded-full bg-[var(--accent-400)] transition-[width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${percentage}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            You can close this window. Queued work continues in the background.
          </p>
        </div>
      </div>
    </section>
  );
}

function DestinationStep({
  context,
  selectedTargetId,
  onSelect,
}: {
  context: TaskDelegationContext | null;
  selectedTargetId: string;
  onSelect: (target: TaskDelegationTarget) => void;
}) {
  if (!context?.targets.length) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-5 text-center">
        <Bot size={24} className="mx-auto text-[var(--text-muted)]" />
        <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
          No execution destinations configured
        </p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Add GitHub Copilot Cloud, a Paperclip route, or enable Scout work pickup before delegating work.
        </p>
        <Link
          href="/settings/ai-provider?setting=Execution%20Destinations"
          className="mt-4 inline-flex min-h-9 items-center justify-center rounded-lg bg-[var(--accent-600)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
        >
          Configure AI &amp; Agents
        </Link>
      </div>
    );
  }
  return (
    <fieldset>
      <legend className="mb-3 text-xs font-medium text-[var(--text-secondary)]">
        Choose where this work should run
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {context.targets.map((target) => {
          const readyCount = target.eligibility.filter(({ ready }) => ready).length;
          const unavailable = readyCount === 0;
          const selected = target.id === selectedTargetId;
          const unavailableReason = target.eligibility.find(({ blocker }) => blocker)?.blocker
            ?? 'No selected tasks are eligible for this destination';
          return (
            <button
              key={target.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={unavailable}
              title={unavailable ? unavailableReason : undefined}
              onClick={() => onSelect(target)}
              className={cn(
                'flex min-h-20 items-center gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                selected
                  ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/10'
                  : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)]',
                unavailable && 'cursor-not-allowed opacity-55 hover:bg-[var(--surface-0)]',
              )}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
                <ExecutionDestinationIcon type={target.type} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                  {target.name}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                  {targetSubtitle(target)}
                </span>
                <span className={cn(
                  'mt-1 block text-[11px] font-medium',
                  readyCount ? 'text-emerald-300' : 'text-amber-300',
                )}>
                  {readyCount} of {target.eligibility.length} ready
                </span>
                {unavailable && (
                  <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-muted)]">
                    {unavailableReason}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function ConfigureStep({
  target,
  instruction,
  onInstructionChange,
  repository,
  onRepositoryChange,
  needsRepository,
  baseRef,
  onBaseRefChange,
  model,
  onModelChange,
  createPullRequest,
  onCreatePullRequestChange,
  markInProgress,
  onMarkInProgressChange,
  allowedActions,
  onAllowedActionsChange,
  maxAttempts,
  onMaxAttemptsChange,
  timeoutHours,
  onTimeoutHoursChange,
  paperclipOptions,
  paperclipBinding,
  onPaperclipBindingChange,
  loadingPaperclipOptions,
  paperclipOptionsError,
  onPaperclipCompanyChange,
}: {
  target: TaskDelegationTarget;
  instruction: string;
  onInstructionChange: (value: string) => void;
  repository: string;
  onRepositoryChange: (value: string) => void;
  needsRepository: boolean;
  baseRef: string;
  onBaseRefChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  createPullRequest: boolean;
  onCreatePullRequestChange: (value: boolean) => void;
  markInProgress: boolean;
  onMarkInProgressChange: (value: boolean) => void;
  allowedActions: string[];
  onAllowedActionsChange: (value: string[]) => void;
  maxAttempts: number;
  onMaxAttemptsChange: (value: number) => void;
  timeoutHours: number;
  onTimeoutHoursChange: (value: number) => void;
  paperclipOptions: PaperclipOptions | null;
  paperclipBinding: PaperclipProviderConfig | null;
  onPaperclipBindingChange: (value: PaperclipProviderConfig) => void;
  loadingPaperclipOptions: boolean;
  paperclipOptionsError: string | null;
  onPaperclipCompanyChange: (companyId: string) => void;
}) {
  const ready = target.eligibility.filter(({ ready }) => ready);
  const blocked = target.eligibility.filter(({ ready }) => !ready);
  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">Task status</h3>
        <label className="mt-2 flex min-h-12 items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2">
          <span>
            <span className="block text-xs font-medium text-[var(--text-secondary)]">
              Mark delegated tasks as In Progress
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--text-muted)]">
              Applies after each task is successfully queued.
            </span>
          </span>
          <input
            type="checkbox"
            checked={markInProgress}
            onChange={(event) => onMarkInProgressChange(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--accent-500)]"
          />
        </label>
      </section>

      {target.type === 'paperclip' && target.paperclipBinding && (
        <section className="space-y-3">
          <div>
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">Paperclip route</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              Settings provides the defaults. Changes here apply only to this delegation.
            </p>
          </div>
          {paperclipOptionsError && (
            <div role="alert" className="flex gap-2 rounded-lg border border-red-800/40 bg-red-950/20 p-3 text-xs text-red-300">
              <AlertTriangle size={14} className="shrink-0" />
              {paperclipOptionsError}
            </div>
          )}
          {loadingPaperclipOptions && !paperclipOptions ? (
            <div className="flex min-h-20 items-center justify-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] text-xs text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              Loading Paperclip choices...
            </div>
          ) : paperclipOptions && paperclipBinding ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="text-xs font-medium text-[var(--text-secondary)]">
                Company
                <Select
                  value={paperclipBinding.companyId}
                  onValueChange={onPaperclipCompanyChange}
                >
                  <SelectTrigger aria-label="Paperclip company" className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {paperclipOptions.companies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>
                        {company.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="text-xs font-medium text-[var(--text-secondary)]">
                Project
                <Select
                  value={paperclipBinding.projectId ?? '__none__'}
                  onValueChange={(value) => onPaperclipBindingChange({
                    ...paperclipBinding,
                    ...(value === '__none__' ? { projectId: undefined } : { projectId: value }),
                  })}
                >
                  <SelectTrigger aria-label="Paperclip project" className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No project</SelectItem>
                    {paperclipOptions.projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="text-xs font-medium text-[var(--text-secondary)]">
                Agent
                <Select
                  value={paperclipBinding.assigneeAgentId}
                  onValueChange={(value) => {
                    const agent = paperclipOptions.agents.find(({ id }) => id === value);
                    onPaperclipBindingChange({
                      ...paperclipBinding,
                      assigneeAgentId: value,
                      ...(agent?.adapterType
                        ? { requiredAdapterType: agent.adapterType }
                        : { requiredAdapterType: undefined }),
                    });
                  }}
                >
                  <SelectTrigger aria-label="Paperclip agent" className="mt-1.5 w-full">
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {paperclipOptions.agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}{agent.title ? ` · ${agent.title}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="text-xs font-medium text-[var(--text-secondary)]">
                Adapter guard
                <Select
                  value={paperclipBinding.requiredAdapterType ?? '__any__'}
                  onValueChange={(value) => onPaperclipBindingChange({
                    ...paperclipBinding,
                    ...(value === '__any__'
                      ? { requiredAdapterType: undefined }
                      : { requiredAdapterType: value }),
                  })}
                >
                  <SelectTrigger aria-label="Paperclip adapter guard" className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">Any adapter</SelectItem>
                    {[...new Set(paperclipOptions.agents
                      .map(({ adapterType }) => adapterType)
                      .filter((value): value is string => Boolean(value)))].map((adapter) => (
                        <SelectItem key={adapter} value={adapter}>
                          {adapter}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {target.type === 'copilot-cloud' && (
        <section className="space-y-3">
          <div>
            <label htmlFor="delegation-repository" className="text-xs font-medium text-[var(--text-secondary)]">
              Repository
            </label>
            {needsRepository ? (
              <Select
                value={repository}
                onValueChange={onRepositoryChange}
              >
                <SelectTrigger id="delegation-repository" className="mt-1.5 w-full">
                  <SelectValue placeholder="Choose a configured repository" />
                </SelectTrigger>
                <SelectContent>
                  {target.repositories.map((option) => (
                    <SelectItem key={option.repository} value={option.repository}>
                      {option.repository} · {option.connectorName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div id="delegation-repository" className="mt-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                {[
                  ...new Set(ready.map(({ repository: value }) => value).filter(Boolean)),
                ].join(', ')}
              </div>
            )}

            <p className="mt-1.5 flex gap-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              <Lock size={12} className="mt-0.5 shrink-0" />
              GitHub-origin tasks stay locked to their source repository.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-[var(--text-secondary)]">
              Base ref
              <span className="input-glow mt-1.5 block rounded-lg border border-[var(--border)] bg-[var(--surface-0)]">
                <input
                  value={baseRef}
                  onChange={(event) => onBaseRefChange(event.target.value)}
                  maxLength={255}
                  className="min-h-10 w-full bg-transparent px-3 text-sm text-[var(--text-primary)] outline-none"
                />
              </span>
            </label>
            <div className="text-xs font-medium text-[var(--text-secondary)]">
              Model
              <Select
                value={model || '__auto__'}
                onValueChange={(value) => onModelChange(value === '__auto__' ? '' : value)}
              >
                <SelectTrigger aria-label="Model" className="mt-1.5 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto__">Auto</SelectItem>
                  <SelectItem value="gpt-5.3-codex">GPT-5.3-Codex</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex min-h-10 items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 text-xs text-[var(--text-secondary)]">
            Create a pull request when work completes
            <input
              type="checkbox"
              checked={createPullRequest}
              onChange={(event) => onCreatePullRequestChange(event.target.checked)}
              className="h-4 w-4 accent-[var(--accent-500)]"
            />
          </label>
        </section>
      )}

      {target.type === 'pull-queue' && (
        <div className="flex gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          <Clock size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
          This work stays queued until the destination&apos;s scheduled automation checks Mission Control.
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="delegation-instructions"
            className="text-xs font-medium text-[var(--text-secondary)]"
          >
            Per-dispatch instructions
          </label>
          <span aria-hidden="true" className="text-[11px] font-normal text-[var(--text-muted)]">
            Optional
          </span>
        </div>
        <div className="input-glow mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-0)]">
          <textarea
            id="delegation-instructions"
            value={instruction}
            onChange={(event) => onInstructionChange(event.target.value)}
            rows={4}
            maxLength={32_000}
            aria-describedby="delegation-instructions-help"
            placeholder="Describe the outcome each delegated task should deliver."
            className="w-full resize-y bg-transparent px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
        </div>
        <span
          id="delegation-instructions-help"
          className="mt-1.5 block text-[11px] font-normal leading-relaxed text-[var(--text-muted)]"
        >
          Add guidance only when the task details do not fully describe the desired outcome.
        </span>
      </div>

      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3">
        <h3 className="text-xs font-medium text-[var(--text-secondary)]">
          Destination always instructions
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Configured in Settings and applied to every eligible dispatch to this destination.
        </p>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-1)] p-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          {target.alwaysInstructions || 'No always instructions configured.'}
        </pre>
      </section>

      <details className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
          Advanced controls
        </summary>
        <div className="space-y-4 border-t border-[var(--border-subtle)] p-3">
          <fieldset>
            <legend className="text-xs font-medium text-[var(--text-secondary)]">Allowed actions</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {target.allowedActions.map((action) => {
                const checked = allowedActions.includes(action);
                return (
                  <label key={action} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--border)] px-2 text-xs text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onAllowedActionsChange(
                        checked
                          ? allowedActions.filter((value) => value !== action)
                          : [...allowedActions, action],
                      )}
                      className="accent-[var(--accent-500)]"
                    />
                    {action.replaceAll('_', ' ')}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-[var(--text-secondary)]">
              Maximum attempts
              <input
                type="number"
                min={1}
                max={20}
                value={maxAttempts}
                onChange={(event) => onMaxAttemptsChange(Math.min(
                  20,
                  Math.max(1, Math.trunc(event.target.valueAsNumber || 1)),
                ))}
                className="mt-1.5 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="text-xs font-medium text-[var(--text-secondary)]">
              Timeout hours
              <input
                type="number"
                min={1}
                max={720}
                value={timeoutHours}
                onChange={(event) => onTimeoutHoursChange(Math.min(
                  720,
                  Math.max(1, Math.trunc(event.target.valueAsNumber || 1)),
                ))}
                className="mt-1.5 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)]"
              />
            </label>
          </div>
        </div>
      </details>

      <EligibilityList ready={ready} blocked={blocked} />
    </div>
  );
}

function EligibilityList({
  ready,
  blocked,
}: {
  ready: TaskDelegationTarget['eligibility'];
  blocked: TaskDelegationTarget['eligibility'];
}) {
  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">Eligibility</h3>
        <span className="text-[11px] text-[var(--text-muted)]">Blocked tasks are never skipped silently</span>
      </div>
      <ul className="mt-2 overflow-hidden rounded-lg border border-[var(--border-subtle)]">
        {[...ready, ...blocked].map((item) => (
          <li
            key={item.taskId}
            className="flex items-start gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2 last:border-b-0"
          >
            {item.ready
              ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-300" />
              : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{item.title}</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--text-muted)]">
                {item.ready
                  ? item.repositoryLocked
                    ? `Locked to ${item.repository}`
                    : 'Ready for this destination'
                  : item.blocker}
              </span>
            </span>
            <span className={cn(
              'text-[11px] font-medium',
              item.ready ? 'text-emerald-300' : 'text-amber-300',
            )}>
              {item.ready ? 'Ready' : 'Blocked'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewStep({
  target,
  batch,
  baseRef,
  model,
  createPullRequest,
  markInProgress,
  paperclipBinding,
  paperclipOptions,
}: {
  target: TaskDelegationTarget;
  batch: PreviewBatch;
  baseRef: string;
  model: string;
  createPullRequest: boolean;
  markInProgress: boolean;
  paperclipBinding: PaperclipProviderConfig | null;
  paperclipOptions: PaperclipOptions | null;
}) {
  const fields = [...new Set(batch.previews.flatMap(({ disclosedFields }) => disclosedFields))];
  const actions = [...new Set(batch.previews.flatMap(({ allowedActions }) => allowedActions))];
  const classifications = [...new Set(
    batch.previews.map(({ dataClassification }) => dataClassification),
  )];
  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
            <ExecutionDestinationIcon type={target.type} />
          </span>
          <div>
            <h3 className="text-sm font-medium text-[var(--text-primary)]">{target.name}</h3>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {batch.readyCount} durable assignment{batch.readyCount === 1 ? '' : 's'} · {target.executionLocality.replaceAll('-', ' ')}
            </p>
          </div>
        </div>
        {target.type === 'copilot-cloud' && (
          <dl className="mt-3 grid gap-2 border-t border-[var(--border-subtle)] pt-3 text-xs sm:grid-cols-3">
            <div><dt className="text-[var(--text-muted)]">Base ref</dt><dd className="mt-0.5 text-[var(--text-secondary)]">{baseRef}</dd></div>
            <div><dt className="text-[var(--text-muted)]">Model</dt><dd className="mt-0.5 text-[var(--text-secondary)]">{model || 'Auto'}</dd></div>
            <div><dt className="text-[var(--text-muted)]">Pull request</dt><dd className="mt-0.5 text-[var(--text-secondary)]">{createPullRequest ? 'Create' : 'Do not create'}</dd></div>
          </dl>
        )}
        {target.type === 'paperclip' && paperclipBinding && (
          <dl className="mt-3 grid gap-2 border-t border-[var(--border-subtle)] pt-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-[var(--text-muted)]">Company</dt>
              <dd className="mt-0.5 text-[var(--text-secondary)]">
                {paperclipOptions?.companies.find(({ id }) =>
                  id === paperclipBinding.companyId)?.name ?? paperclipBinding.companyId}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Project</dt>
              <dd className="mt-0.5 text-[var(--text-secondary)]">
                {paperclipBinding.projectId
                  ? paperclipOptions?.projects.find(({ id }) =>
                    id === paperclipBinding.projectId)?.name ?? paperclipBinding.projectId
                  : 'No project'}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Agent</dt>
              <dd className="mt-0.5 text-[var(--text-secondary)]">
                {paperclipOptions?.agents.find(({ id }) =>
                  id === paperclipBinding.assigneeAgentId)?.name
                  ?? paperclipBinding.assigneeAgentId}
              </dd>
            </div>
          </dl>
        )}
        <dl className="mt-3 border-t border-[var(--border-subtle)] pt-3 text-xs">
          <div>
            <dt className="text-[var(--text-muted)]">Task status</dt>
            <dd className="mt-0.5 text-[var(--text-secondary)]">
              {markInProgress ? 'Mark as In Progress' : 'Leave unchanged'}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">Disclosure and authorization</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-[11px] text-[var(--text-muted)]">Data handling</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {classifications.map((classification) => (
                <span
                  key={classification}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-700/40 bg-amber-950/30 px-2 py-0.5 text-xs font-medium capitalize text-amber-300"
                >
                  <Lock size={9} />
                  {classification.replace('-', ' ')}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-[var(--text-muted)]">Disclosed fields</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {fields.map((field) => (
                <span key={field} className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
                  {field}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-[var(--text-muted)]">Allowed actions</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {actions.map((action) => (
                <span key={action} className="inline-flex items-center gap-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
                  <Check size={9} />
                  {action.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 space-y-1.5">
          {batch.previews.map((preview) => (
            <p
              key={preview.dispatchId}
              className="text-[11px] leading-relaxed text-[var(--text-muted)]"
            >
              <span className="font-medium text-[var(--text-secondary)]">
                {preview.classificationExplanation
                  ?? `${preview.dataClassification.replace('-', ' ')} source policy`}.
              </span>{' '}
              {(preview.classificationSources ?? []).map((source) => (
                `${source.connectorName}: ${source.effective.replace('-', ' ')}`
              )).join(' · ')}
            </p>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">
          Effective reviewed context
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
          This is the exact redacted payload sent for each ready task, including destination
          always instructions and separate per-dispatch instructions.
        </p>
        <div className="mt-2 space-y-2">
          {batch.previews.map((preview) => (
            <details
              key={preview.dispatchId}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]"
            >
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
                {String(
                  Array.isArray(preview.payloadPreview.tasks)
                  && preview.payloadPreview.tasks[0]
                  && typeof preview.payloadPreview.tasks[0] === 'object'
                  && !Array.isArray(preview.payloadPreview.tasks[0])
                    ? (preview.payloadPreview.tasks[0] as Record<string, unknown>).title
                    : preview.taskId,
                )}
              </summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--border-subtle)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {JSON.stringify(preview.payloadPreview, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      </section>

      {batch.blocked.length > 0 && (
        <EligibilityList ready={[]} blocked={batch.blocked} />
      )}
      <div className="flex gap-2 rounded-lg border border-[var(--accent-500)]/25 bg-[var(--accent-500)]/8 px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--accent-300)]" />
        Nothing has been sent to the destination. Confirming creates one durable assignment per ready Mission Control task.
      </div>
    </div>
  );
}
