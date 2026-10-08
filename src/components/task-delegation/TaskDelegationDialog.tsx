'use client';

import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import {
  AlertTriangle,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudCog,
  Clock,
  Loader2,
  Lock,
  Search,
  Send,
  Settings2,
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

type WizardStep = 'destination' | 'configure' | 'plan' | 'review';
type DispatchStrategy = 'separate' | 'combined' | 'auto';
type DelegationProvider = Extract<
  TaskDelegationTarget['type'],
  'paperclip' | 'copilot-cloud' | 'pull-queue'
>;

interface DelegationPreview {
  taskId: string;
  taskIds?: string[];
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
  dispatchCount?: number;
  strategy?: DispatchStrategy;
}

interface AutoPlanGroup {
  id: string;
  taskIds: string[];
  strategy: 'separate' | 'combined';
  repository: string;
  rationale: string;
  confidence: number;
}

interface AutoPlan {
  groups: AutoPlanGroup[];
  blocked: TaskDelegationTarget['eligibility'];
  taskTitles: Record<string, string>;
  routing: {
    provider: string;
    model: string;
  };
}

interface ConfirmationProgress {
  active: number;
  completed: number;
  total: number;
}

interface DelegationDraft {
  selectedTargetId: string;
  instruction: string;
  repository: string;
  baseRef: string;
  model: string;
  createPullRequest: boolean;
  dispatchStrategy: DispatchStrategy;
  markInProgress: boolean;
  maxAttempts: number;
  timeoutHours: number;
  allowedActions: string[];
  paperclipBinding: PaperclipProviderConfig | null;
}

interface FailedDelegation {
  preview: DelegationPreview;
  message: string;
}

interface FailedStatusUpdate {
  taskId: string;
  message: string;
}

const STEP_ORDER: WizardStep[] = ['destination', 'configure', 'plan', 'review'];
const STEP_LABELS: Record<WizardStep, string> = {
  destination: 'Choose provider',
  configure: 'Configure',
  plan: 'Proposal',
  review: 'Review',
};

const PROVIDER_OPTIONS: Array<{
  type: DelegationProvider;
  name: string;
  description: string;
  badge: string;
}> = [
  {
    type: 'paperclip',
    name: 'Paperclip',
    description: 'Route work to an eligible agent in a registered Paperclip company.',
    badge: 'Company agent routing',
  },
  {
    type: 'copilot-cloud',
    name: 'GitHub Copilot Cloud',
    description: 'Start GitHub-hosted coding work in an isolated cloud environment.',
    badge: 'Cloud coding session',
  },
  {
    type: 'pull-queue',
    name: 'Microsoft Scout',
    description: 'Handle work using authorized Microsoft 365 resources.',
    badge: 'M365 / work-related tasks',
  },
];

const DRAFT_STORAGE_PREFIX = 'mission-control:delegation-draft:';

function draftStorageKey(taskIds: string[]) {
  return `${DRAFT_STORAGE_PREFIX}${JSON.stringify([...taskIds].sort())}`;
}

function isPaperclipBinding(value: unknown): value is PaperclipProviderConfig | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Partial<PaperclipProviderConfig>;
  return typeof binding.companyId === 'string'
    && typeof binding.assigneeAgentId === 'string'
    && (binding.companyName === undefined || typeof binding.companyName === 'string')
    && (binding.projectId === undefined || typeof binding.projectId === 'string')
    && (
      binding.requiredAdapterType === undefined
      || typeof binding.requiredAdapterType === 'string'
    );
}

function readDraft(taskIds: string[]): DelegationDraft | null {
  try {
    const raw = window.sessionStorage.getItem(draftStorageKey(taskIds));
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<DelegationDraft>;
    if (
      typeof draft.selectedTargetId !== 'string'
      || typeof draft.instruction !== 'string'
      || typeof draft.repository !== 'string'
      || typeof draft.baseRef !== 'string'
      || typeof draft.model !== 'string'
      || typeof draft.createPullRequest !== 'boolean'
      || !['separate', 'combined', 'auto'].includes(draft.dispatchStrategy ?? '')
      || typeof draft.markInProgress !== 'boolean'
      || typeof draft.maxAttempts !== 'number'
      || !Number.isInteger(draft.maxAttempts)
      || draft.maxAttempts < 1
      || draft.maxAttempts > 20
      || typeof draft.timeoutHours !== 'number'
      || !Number.isInteger(draft.timeoutHours)
      || draft.timeoutHours < 1
      || draft.timeoutHours > 720
      || !Array.isArray(draft.allowedActions)
      || !draft.allowedActions.every((action) => typeof action === 'string')
      || !isPaperclipBinding(draft.paperclipBinding)
    ) {
      window.sessionStorage.removeItem(draftStorageKey(taskIds));
      return null;
    }
    return draft as DelegationDraft;
  } catch {
    return null;
  }
}

function writeDraft(taskIds: string[], draft: DelegationDraft) {
  try {
    window.sessionStorage.setItem(draftStorageKey(taskIds), JSON.stringify(draft));
  } catch {
    // Draft persistence is best-effort when browser storage is unavailable.
  }
}

function clearDraft(taskIds: string[]) {
  try {
    window.sessionStorage.removeItem(draftStorageKey(taskIds));
  } catch {
    // Draft persistence is best-effort when browser storage is unavailable.
  }
}

function paperclipAgentState(status: string | null) {
  if (status === 'pending_approval') {
    return {
      assignable: false,
      label: 'Pending hire approval',
      detail: 'Paperclip does not allow assignment until this agent hire is approved.',
    };
  }
  if (status === 'terminated') {
    return {
      assignable: false,
      label: 'Terminated',
      detail: 'This agent is no longer assignable in Paperclip.',
    };
  }
  if (status === 'paused') {
    return {
      assignable: true,
      label: 'Paused',
      detail: 'Work can be assigned, but it will not run until the agent is resumed.',
    };
  }
  return {
    assignable: true,
    label: status ? status.replaceAll('_', ' ') : 'Available',
    detail: null,
  };
}

function preferredTarget(targets: TaskDelegationTarget[]) {
  return [...targets].sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id))[0] ?? null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Delegation request failed';
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function payloadText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function humanizeAction(action: string) {
  return action.replaceAll('_', ' ');
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as {
    error?: string;
    message?: string;
  } | null;
  return body?.error ?? body?.message ?? `Request failed (${response.status})`;
}

export function TaskDelegationDialog() {
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>('destination');
  const [context, setContext] = useState<TaskDelegationContext | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [taskBriefs, setTaskBriefs] = useState<Record<string, string>>({});
  const [repository, setRepository] = useState('');
  const [baseRef, setBaseRef] = useState('main');
  const [model, setModel] = useState('');
  const [createPullRequest, setCreatePullRequest] = useState(true);
  const [dispatchStrategy, setDispatchStrategy] =
    useState<DispatchStrategy>('separate');
  const [markInProgress, setMarkInProgress] = useState(true);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [timeoutHours, setTimeoutHours] = useState(24);
  const [allowedActions, setAllowedActions] = useState<string[]>([]);
  const [operationId, setOperationId] = useState('');
  const [previewBatch, setPreviewBatch] = useState<PreviewBatch | null>(null);
  const [autoPlan, setAutoPlan] = useState<AutoPlan | null>(null);
  const [confirmationProgress, setConfirmationProgress] =
    useState<ConfirmationProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paperclipOptions, setPaperclipOptions] = useState<PaperclipOptions | null>(null);
  const [paperclipBinding, setPaperclipBinding] = useState<PaperclipProviderConfig | null>(null);
  const [loadingPaperclipOptions, setLoadingPaperclipOptions] = useState(false);
  const [paperclipOptionsError, setPaperclipOptionsError] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [failedDelegations, setFailedDelegations] = useState<FailedDelegation[]>([]);
  const [failedStatusUpdates, setFailedStatusUpdates] = useState<FailedStatusUpdate[]>([]);
  const contextRequestRef = useRef(0);
  const paperclipRequestRef = useRef(0);
  const wasOpenRef = useRef(false);
  const pendingDraftRef = useRef<DelegationDraft | null>(null);
  const restoredTargetIdRef = useRef('');
  const restoredPaperclipBindingRef = useRef<PaperclipProviderConfig | null>(null);
  const resumeRecoveryRef = useRef(false);
  const taskIdsRef = useRef<string[]>([]);
  const recoveryRef = useRef<{
    delegationFailures: FailedDelegation[];
    statusFailures: FailedStatusUpdate[];
    previewBatch: PreviewBatch | null;
  }>({
    delegationFailures: [],
    statusFailures: [],
    previewBatch: null,
  });

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

  const reset = useCallback((ids: string[], draft: DelegationDraft | null) => {
    taskIdsRef.current = ids;
    recoveryRef.current = {
      delegationFailures: [],
      statusFailures: [],
      previewBatch: null,
    };
    setTaskIds(ids);
    setStep(draft?.selectedTargetId ? 'configure' : 'destination');
    setContext(null);
    setSelectedTargetId(draft?.selectedTargetId ?? '');
    setInstruction(draft?.instruction ?? '');
    setTaskBriefs({});
    setRepository(draft?.repository ?? '');
    setBaseRef(draft?.baseRef ?? 'main');
    setModel(draft?.model ?? '');
    setCreatePullRequest(draft?.createPullRequest ?? true);
    setDispatchStrategy(draft?.dispatchStrategy ?? 'separate');
    setMarkInProgress(draft?.markInProgress ?? true);
    setMaxAttempts(draft?.maxAttempts ?? 3);
    setTimeoutHours(draft?.timeoutHours ?? 24);
    setAllowedActions(draft?.allowedActions ?? []);
    setOperationId(crypto.randomUUID());
    setPreviewBatch(null);
    setAutoPlan(null);
    setConfirmationProgress(null);
    setError(null);
    setPaperclipOptions(null);
    setPaperclipBinding(draft?.paperclipBinding ?? null);
    setPaperclipOptionsError(null);
    setDraftRestored(false);
    setFailedDelegations([]);
    setFailedStatusUpdates([]);
    pendingDraftRef.current = draft;
    restoredTargetIdRef.current = '';
    restoredPaperclipBindingRef.current = draft?.paperclipBinding ?? null;
    resumeRecoveryRef.current = false;
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
      const currentTaskIds = taskIdsRef.current;
      const recovery = recoveryRef.current;
      const sameSelection = normalized.length === currentTaskIds.length
        && normalized.every((taskId) => currentTaskIds.includes(taskId));
      if (
        sameSelection
        && (recovery.delegationFailures.length > 0 || recovery.statusFailures.length > 0)
        && recovery.previewBatch
      ) {
        resumeRecoveryRef.current = true;
        setStep('review');
        setOpen(true);
        return;
      }
      reset(normalized, readDraft(normalized));
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
      setTaskBriefs(Object.fromEntries(
        next.tasks.map((task) => [task.id, task.description ?? '']),
      ));
      const eligibleTargets = next.targets.filter((target) =>
        target.eligibility.some(({ ready }) => ready));
      const eligibleProviders = [...new Set(eligibleTargets.map(({ type }) => type))];
      const draft = pendingDraftRef.current;
      const restoredTarget = draft
        ? eligibleTargets.find(({ id }) => id === draft.selectedTargetId) ?? null
        : null;
      const initial = restoredTarget ?? (eligibleProviders.length === 1
        ? preferredTarget(eligibleTargets.filter(({ type }) => type === eligibleProviders[0]))
        : null);
      if (initial) {
        setSelectedTargetId(initial.id);
        if (restoredTarget && draft) {
          restoredTargetIdRef.current = restoredTarget.id;
          setAllowedActions(draft.allowedActions.filter((action) =>
            restoredTarget.allowedActions.includes(action)));
          setDraftRestored(true);
        } else {
          setStep('destination');
          setAllowedActions(initial.allowedActions);
        }
      } else if (draft) {
        clearDraft(ids);
        setStep('destination');
        setSelectedTargetId('');
        setInstruction('');
        setRepository('');
        setBaseRef('main');
        setModel('');
        setCreatePullRequest(true);
        setDispatchStrategy('separate');
        setMarkInProgress(true);
        setMaxAttempts(3);
        setTimeoutHours(24);
        setAllowedActions([]);
        setPaperclipBinding(null);
      }
      pendingDraftRef.current = null;
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
    if (resumeRecoveryRef.current) {
      resumeRecoveryRef.current = false;
      return;
    }
    const controller = new AbortController();
    void loadContext(taskIds, requestId, controller.signal);
    return () => controller.abort();
  }, [loadContext, open, taskIds]);

  const selectedTarget = useMemo(
    () => context?.targets.find(({ id }) => id === selectedTargetId) ?? null,
    [context?.targets, selectedTargetId],
  );
  const paperclipTargets = useMemo(
    () => context?.targets.filter(({ type }) => type === 'paperclip') ?? [],
    [context?.targets],
  );
  const ready = selectedTarget?.eligibility.filter(({ ready: value }) => value) ?? [];
  const blocked = selectedTarget?.eligibility.filter(({ ready: value }) => !value) ?? [];
  const readyLockedRepositories = [...new Set(ready
    .filter(({ repositoryLocked }) => repositoryLocked)
    .map(({ repository: value }) => value?.toLowerCase())
    .filter((value): value is string => Boolean(value)))];
  const needsRepository = selectedTarget?.type === 'copilot-cloud'
    && ready.some(({ repositoryLocked }) => !repositoryLocked)
    && !(dispatchStrategy === 'combined' && readyLockedRepositories.length === 1);
  const visibleSteps = useMemo(
    () => dispatchStrategy === 'auto'
      ? STEP_ORDER
      : STEP_ORDER.filter((candidate) => candidate !== 'plan'),
    [dispatchStrategy],
  );
  const currentStepIndex = visibleSteps.indexOf(step);

  useEffect(() => {
    if (!open || !context || !taskIds.length || submitting || step === 'destination') return;
    writeDraft(taskIds, {
      selectedTargetId,
      instruction,
      repository,
      baseRef,
      model,
      createPullRequest,
      dispatchStrategy,
      markInProgress,
      maxAttempts,
      timeoutHours,
      allowedActions,
      paperclipBinding,
    });
  }, [
    allowedActions,
    baseRef,
    context,
    createPullRequest,
    dispatchStrategy,
    instruction,
    markInProgress,
    maxAttempts,
    model,
    open,
    paperclipBinding,
    repository,
    selectedTargetId,
    submitting,
    taskIds,
    timeoutHours,
    step,
  ]);

  const loadPaperclipOptions = useCallback(async (targetId: string, companyId: string) => {
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
  }, []);

  useEffect(() => {
    if (!selectedTarget) return;
    const restoringDraft = restoredTargetIdRef.current === selectedTarget.id;
    const restoredPaperclipBinding = restoredPaperclipBindingRef.current;
    restoredTargetIdRef.current = '';
    restoredPaperclipBindingRef.current = null;
    if (!restoringDraft) {
      setAllowedActions(selectedTarget.allowedActions);
    }
    setPreviewBatch(null);
    setAutoPlan(null);
    if (
      !restoringDraft
      &&
      selectedTarget.type === 'copilot-cloud'
      && selectedTarget.repositories.length === 1
    ) {
      setRepository(selectedTarget.repositories[0].repository);
    }
    if (selectedTarget.type === 'paperclip' && selectedTarget.paperclipBinding) {
      const defaultBinding = {
        companyId: selectedTarget.paperclipBinding.companyId,
        ...(selectedTarget.paperclipBinding.companyName
          ? { companyName: selectedTarget.paperclipBinding.companyName }
          : {}),
        assigneeAgentId: selectedTarget.paperclipBinding.assigneeAgentId,
        ...(selectedTarget.paperclipBinding.projectId
          ? { projectId: selectedTarget.paperclipBinding.projectId }
          : {}),
      };
      const binding = restoringDraft
        && restoredPaperclipBinding?.companyId === selectedTarget.paperclipBinding.companyId
        ? restoredPaperclipBinding
        : defaultBinding;
      setPaperclipBinding(binding);
      void loadPaperclipOptions(selectedTarget.id, binding.companyId);
    } else {
      paperclipRequestRef.current += 1;
      setPaperclipBinding(null);
      setPaperclipOptions(null);
    }
  }, [loadPaperclipOptions, selectedTarget]);

  const createPreviews = async () => {
    if (!selectedTarget) return;
    setSubmitting(true);
    setError(null);
    setFailedDelegations([]);
    setFailedStatusUpdates([]);
    try {
      if (dispatchStrategy === 'auto') {
        const response = await fetch('/api/tasks/delegation/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskIds,
            agentId: selectedTarget.id,
            repository: needsRepository ? repository : undefined,
          }),
        });
        if (!response.ok) throw new Error(await responseError(response));
        setAutoPlan(await response.json() as AutoPlan);
        setStep('plan');
        return;
      }
      const response = await fetch('/api/tasks/delegation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIds,
          strategy: dispatchStrategy,
          agentId: selectedTarget.id,
          instruction: instruction.trim() || undefined,
          taskBriefs,
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

  const createAutoPreviews = async () => {
    if (!selectedTarget || !autoPlan) return;
    setSubmitting(true);
    setError(null);
    setFailedDelegations([]);
    setFailedStatusUpdates([]);
    try {
      const batches: PreviewBatch[] = [];
      for (const group of autoPlan.groups) {
        const response = await fetch('/api/tasks/delegation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskIds: group.taskIds,
            strategy: group.strategy,
            agentId: selectedTarget.id,
            instruction: instruction.trim() || undefined,
            taskBriefs,
            operationId: `${operationId}:${group.id}`,
            allowedActions,
            repository: group.repository,
            baseRef: baseRef.trim(),
            model: model || undefined,
            createPullRequest,
            maxAttempts,
            timeoutMs: timeoutHours * 60 * 60_000,
          }),
        });
        if (!response.ok) throw new Error(await responseError(response));
        batches.push(await response.json() as PreviewBatch);
      }
      setPreviewBatch({
        previews: batches.flatMap(({ previews }) => previews),
        blocked: autoPlan.blocked,
        readyCount: batches.reduce((count, batch) => count + batch.readyCount, 0),
        blockedCount: autoPlan.blocked.length,
        dispatchCount: batches.reduce(
          (count, batch) => count + (batch.dispatchCount ?? batch.previews.length),
          0,
        ),
        strategy: 'auto',
      });
      setStep('review');
    } catch (previewError) {
      setError(errorMessage(previewError));
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = async (previews = previewBatch?.previews ?? []) => {
    if (!previews.length) return;
    setSubmitting(true);
    setConfirmationProgress({
      active: 1,
      completed: 0,
      total: previews.length,
    });
    setError(null);
    const attemptedDispatchIds = new Set(previews.map(({ dispatchId }) => dispatchId));
    const delegationFailures: FailedDelegation[] = failedDelegations.filter(
      ({ preview }) => !attemptedDispatchIds.has(preview.dispatchId),
    );
    const statusFailures: FailedStatusUpdate[] = [];
    const confirmedTaskIds = new Set<string>();
    let confirmed = 0;
    for (const [index, preview] of previews.entries()) {
      setConfirmationProgress({
        active: index + 1,
        completed: index,
        total: previews.length,
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
        for (const taskId of preview.taskIds ?? [preview.taskId]) {
          confirmedTaskIds.add(taskId);
          if (markInProgress) {
            try {
              const statusResponse = await fetch(`/api/tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'in_progress' }),
              });
              if (!statusResponse.ok) {
                throw new Error(await responseError(statusResponse));
              }
            } catch (statusError) {
              statusFailures.push({ taskId, message: errorMessage(statusError) });
            }
          }
        }
      } catch (confirmError) {
        delegationFailures.push({
          preview,
          message: errorMessage(confirmError),
        });
      } finally {
        setConfirmationProgress({
          active: Math.min(index + 2, previews.length),
          completed: index + 1,
          total: previews.length,
        });
      }
    }
    setSubmitting(false);
    setConfirmationProgress(null);
    const statusFailureByTaskId = new Map(
      [...failedStatusUpdates, ...statusFailures].map((failure) => [failure.taskId, failure]),
    );
    const remainingStatusFailures = [...statusFailureByTaskId.values()];
    setFailedDelegations(delegationFailures);
    setFailedStatusUpdates(remainingStatusFailures);
    recoveryRef.current = {
      delegationFailures,
      statusFailures: remainingStatusFailures,
      previewBatch,
    };
    if (delegationFailures.length || remainingStatusFailures.length) {
      if (confirmedTaskIds.size) {
        notifyTaskDelegationUpdated([...confirmedTaskIds]);
      }
      return;
    }
    recoveryRef.current = {
      delegationFailures: [],
      statusFailures: [],
      previewBatch: null,
    };
    clearDraft(taskIds);
    setOpen(false);
    requestAnimationFrame(() => {
      notifyTaskDelegationUpdated([...confirmedTaskIds]);
      toast.success(
        `${confirmedTaskIds.size} task${confirmedTaskIds.size === 1 ? '' : 's'} queued in `
        + `${confirmed} assignment${confirmed === 1 ? '' : 's'} for ${selectedTarget?.name}`,
      );
    });
  };

  const retryStatusUpdates = async (taskIdsToRetry = failedStatusUpdates.map(
    ({ taskId }) => taskId,
  )) => {
    if (!taskIdsToRetry.length) return;
    setSubmitting(true);
    setError(null);
    const attemptedTaskIds = new Set(taskIdsToRetry);
    const remaining = failedStatusUpdates.filter(
      ({ taskId }) => !attemptedTaskIds.has(taskId),
    );
    for (const taskId of taskIdsToRetry) {
      try {
        const response = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'in_progress' }),
        });
        if (!response.ok) throw new Error(await responseError(response));
      } catch (statusError) {
        remaining.push({ taskId, message: errorMessage(statusError) });
      }
    }
    setSubmitting(false);
    setFailedStatusUpdates(remaining);
    recoveryRef.current = {
      delegationFailures: failedDelegations,
      statusFailures: remaining,
      previewBatch,
    };
    if (remaining.length || failedDelegations.length) return;
    recoveryRef.current = {
      delegationFailures: [],
      statusFailures: [],
      previewBatch: null,
    };
    clearDraft(taskIds);
    setOpen(false);
    requestAnimationFrame(() => {
      notifyTaskDelegationUpdated(taskIdsToRetry);
      toast.success(
        `${taskIdsToRetry.length} task status update${taskIdsToRetry.length === 1 ? '' : 's'} recovered`,
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
  const dialogTitle = context?.tasks.length === 1
    ? `Delegate task: ${context.tasks[0].title}`
    : `Delegate ${taskIds.length} tasks`;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/70 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[121] flex max-h-[min(820px,calc(100dvh-24px))] w-[min(960px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-2xl focus:outline-none"
          aria-describedby="task-delegation-description"
          aria-busy={submitting}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold tracking-[-0.02em] text-[var(--text-primary)] sm:text-xl">
                {dialogTitle}
              </Dialog.Title>
              <Dialog.Description
                id="task-delegation-description"
                className="sr-only"
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

          <ol
            className={cn(
              'grid border-b border-[var(--border-subtle)]',
              visibleSteps.length === 4 ? 'grid-cols-4' : 'grid-cols-3',
            )}
            aria-label="Delegation steps"
          >
            {visibleSteps.map((item, index) => (
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
            {!loading && context && (
              <SelectedTasksSummary
                tasks={context.tasks}
                targetName={selectedTarget?.name ?? null}
              />
            )}
            {!loading && draftRestored && step === 'configure' && (
              <div
                className="mt-4 flex gap-2 rounded-lg border border-[var(--accent-500)]/25 bg-[var(--accent-500)]/8 px-3 py-2 text-xs text-[var(--text-secondary)]"
                role="status"
              >
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--accent-300)]" />
                Your unfinished delegation settings were restored for these tasks.
              </div>
            )}
            <div className={!loading && context ? 'mt-4' : undefined}>
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
                    if (target.type !== 'copilot-cloud') {
                      setDispatchStrategy('separate');
                    }
                    setError(null);
                  }}
                />
              ) : step === 'configure' && selectedTarget ? (
                <ConfigureStep
                target={selectedTarget}
                tasks={context?.tasks ?? []}
                taskBriefs={taskBriefs}
                onTaskBriefChange={(taskId, value) => setTaskBriefs((current) => ({
                  ...current,
                  [taskId]: value,
                }))}
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
                dispatchStrategy={dispatchStrategy}
                onDispatchStrategyChange={setDispatchStrategy}
                taskCount={taskIds.length}
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
                paperclipTargets={paperclipTargets}
                onPaperclipTargetChange={(target) => {
                  setSelectedTargetId(target.id);
                  setAllowedActions(target.allowedActions);
                }}
                />
              ) : step === 'plan' && autoPlan ? (
                <AutoPlanStep
                plan={autoPlan}
                onStrategyChange={(groupId, strategy) => {
                  setAutoPlan({
                    ...autoPlan,
                    groups: autoPlan.groups.map((group) => (
                      group.id === groupId ? { ...group, strategy } : group
                    )),
                  });
                }}
                />
              ) : step === 'review' && selectedTarget && previewBatch ? (
                <ReviewStep
                target={selectedTarget}
                batch={previewBatch}
                baseRef={baseRef}
                model={model}
                createPullRequest={createPullRequest}
                dispatchStrategy={dispatchStrategy}
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

              {step === 'review'
                && (failedDelegations.length > 0 || failedStatusUpdates.length > 0) && (
                <DelegationRecovery
                  context={context}
                  delegationFailures={failedDelegations}
                  statusFailures={failedStatusUpdates}
                  submitting={submitting}
                  onRetryDelegation={(preview) => void confirm([preview])}
                  onRetryStatus={(taskId) => void retryStatusUpdates([taskId])}
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
                  disabled={
                    submitting
                    || failedDelegations.length > 0
                    || failedStatusUpdates.length > 0
                  }
                  onClick={() => {
                    setError(null);
                    setStep(
                      step === 'review' && dispatchStrategy === 'auto'
                        ? 'plan'
                        : step === 'review' || step === 'plan'
                          ? 'configure'
                          : 'destination',
                    );
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
                  {dispatchStrategy === 'auto'
                    ? 'Propose delegation plan'
                    : `Review ${dispatchStrategy === 'combined' ? 'combined delegation' : (
                      `${ready.length} delegation${ready.length === 1 ? '' : 's'}`
                    )}`}
                </button>
              )}
              {step === 'plan' && (
                <button
                  type="button"
                  disabled={!autoPlan?.groups.length || submitting}
                  onClick={() => void createAutoPreviews()}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--accent-600)] px-4 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Review proposed sessions
                </button>
              )}
              {step === 'review' && (
                <button
                  type="button"
                  disabled={
                    (!previewBatch?.previews.length
                      && !failedDelegations.length
                      && !failedStatusUpdates.length)
                    || submitting
                  }
                  onClick={() => {
                    if (failedDelegations.length) {
                      void confirm(failedDelegations.map(({ preview }) => preview));
                    } else if (failedStatusUpdates.length) {
                      void retryStatusUpdates();
                    } else {
                      void confirm();
                    }
                  }}
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
                    : failedDelegations.length
                      ? `Retry ${failedDelegations.length} failed delegation${
                        failedDelegations.length === 1 ? '' : 's'
                      }`
                      : failedStatusUpdates.length
                        ? `Retry ${failedStatusUpdates.length} status update${
                          failedStatusUpdates.length === 1 ? '' : 's'
                        }`
                    : dispatchStrategy === 'combined'
                      ? `Confirm and delegate ${previewBatch?.readyCount ?? 0} tasks together`
                      : dispatchStrategy === 'auto'
                        ? `Confirm ${previewBatch?.dispatchCount ?? 0} proposed sessions`
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

function SelectedTasksSummary({
  tasks,
  targetName,
}: {
  tasks: TaskDelegationContext['tasks'];
  targetName: string | null;
}) {
  const visibleTasks = tasks.slice(0, 2);
  const hiddenCount = Math.max(tasks.length - visibleTasks.length, 0);
  return (
    <section
      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2.5"
      aria-label="Selected work"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-semibold text-[var(--text-primary)]">
          {tasks.length} selected task{tasks.length === 1 ? '' : 's'}
        </h2>
        {targetName && (
          <span className="text-[11px] text-[var(--text-muted)]">
            Destination: {targetName}
          </span>
        )}
      </div>
      <p className="mt-1 truncate text-xs text-[var(--text-secondary)]">
        {visibleTasks.map(({ title }) => title).join(' · ')}
        {hiddenCount > 0 && ` · +${hiddenCount} more`}
      </p>
    </section>
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

function DelegationRecovery({
  context,
  delegationFailures,
  statusFailures,
  submitting,
  onRetryDelegation,
  onRetryStatus,
}: {
  context: TaskDelegationContext | null;
  delegationFailures: FailedDelegation[];
  statusFailures: FailedStatusUpdate[];
  submitting: boolean;
  onRetryDelegation: (preview: DelegationPreview) => void;
  onRetryStatus: (taskId: string) => void;
}) {
  const taskTitle = (taskId: string) =>
    context?.tasks.find(({ id }) => id === taskId)?.title ?? taskId;
  return (
    <section
      className="mt-4 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3"
      aria-labelledby="delegation-recovery-title"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
        <div>
          <h3
            id="delegation-recovery-title"
            className="text-xs font-semibold text-amber-200"
          >
            Some delegation work needs attention
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-100/80">
            Successful assignments will not be sent again. Retry only the failed action below.
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {delegationFailures.map(({ preview, message }) => (
          <li
            key={preview.dispatchId}
            className="flex flex-col gap-2 rounded-md border border-amber-700/30 bg-[var(--surface-0)] px-3 py-2 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-[var(--text-primary)]">
                {taskTitle(preview.taskId)}
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                Assignment failed: {message}
              </p>
            </div>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onRetryDelegation(preview)}
              className="min-h-9 rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              Retry assignment
            </button>
          </li>
        ))}
        {statusFailures.map(({ taskId, message }) => (
          <li
            key={taskId}
            className="flex flex-col gap-2 rounded-md border border-amber-700/30 bg-[var(--surface-0)] px-3 py-2 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-[var(--text-primary)]">
                {taskTitle(taskId)}
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                Assignment queued, but status was not updated: {message}
              </p>
            </div>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onRetryStatus(taskId)}
              className="min-h-9 rounded-md border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              Retry status update
            </button>
          </li>
        ))}
      </ul>
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
  const selectedProvider = context.targets.find(({ id }) => id === selectedTargetId)?.type;
  return (
    <div>
      <div role="radiogroup" aria-label="Execution provider" className="grid gap-2">
        {PROVIDER_OPTIONS.map((provider) => {
          const targets = context.targets.filter(({ type }) => type === provider.type);
          if (!targets.length) return null;
          const readyTaskIds = new Set(targets.flatMap((target) =>
            target.eligibility.filter(({ ready }) => ready).map(({ taskId }) => taskId)));
          const selectableTargets = targets.filter((target) =>
            target.eligibility.some(({ ready }) => ready));
          const unavailable = selectableTargets.length === 0;
          const selected = selectedProvider === provider.type;
          const unavailableReason = targets
            .flatMap(({ eligibility }) => eligibility)
            .find(({ blocker }) => blocker)?.blocker
            ?? 'No selected tasks are eligible for this provider';
          return (
            <label
              key={provider.type}
              title={unavailable ? unavailableReason : undefined}
              className={cn(
                'relative flex min-h-24 items-center gap-4 rounded-lg border p-4 text-left transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]',
                selected
                  ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/10'
                  : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)]',
                unavailable && 'cursor-not-allowed opacity-55 hover:bg-[var(--surface-0)]',
              )}
            >
              <input
                type="radio"
                name="delegation-provider"
                value={provider.type}
                checked={selected}
                disabled={unavailable}
                title={unavailable ? unavailableReason : undefined}
                onChange={() => {
                  const current = selectableTargets.find(({ id }) => id === selectedTargetId);
                  const target = current ?? preferredTarget(selectableTargets);
                  if (target) onSelect(target);
                }}
                className="sr-only"
              />
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
                <ExecutionDestinationIcon type={provider.type} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {provider.name}
                  </span>
                  <span className="rounded-full border border-[var(--border-strong)] bg-[var(--surface-1)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">
                    {provider.badge}
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                  {provider.description}
                </span>
                <span className={cn(
                  'mt-1.5 block text-[11px] font-medium',
                  readyTaskIds.size ? 'text-emerald-300' : 'text-amber-300',
                )}>
                  {readyTaskIds.size} of {context.taskIds.length} ready
                  {targets.length > 1 && ` · ${targets.length} registered routes`}
                </span>
                {unavailable && (
                  <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-muted)]">
                    {unavailableReason}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <Link
        href="/settings/ai-provider?setting=Execution%20Destinations"
        className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Settings2 size={14} />
        Manage execution destinations
      </Link>
    </div>
  );
}

function ConfigureStep({
  target,
  tasks,
  taskBriefs,
  onTaskBriefChange,
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
  dispatchStrategy,
  onDispatchStrategyChange,
  taskCount,
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
  paperclipTargets,
  onPaperclipTargetChange,
}: {
  target: TaskDelegationTarget;
  tasks: TaskDelegationContext['tasks'];
  taskBriefs: Record<string, string>;
  onTaskBriefChange: (taskId: string, value: string) => void;
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
  dispatchStrategy: DispatchStrategy;
  onDispatchStrategyChange: (value: DispatchStrategy) => void;
  taskCount: number;
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
  paperclipTargets: TaskDelegationTarget[];
  onPaperclipTargetChange: (target: TaskDelegationTarget) => void;
}) {
  const [agentSearch, setAgentSearch] = useState('');
  const [adapterFilter, setAdapterFilter] = useState('__all__');
  const ready = target.eligibility.filter(({ ready }) => ready);
  const blocked = target.eligibility.filter(({ ready }) => !ready);
  const lockedRepositories = [...new Set(ready
    .filter(({ repositoryLocked }) => repositoryLocked)
    .map(({ repository: value }) => value?.toLowerCase())
    .filter((value): value is string => Boolean(value)))];
  const combinedBlocker = blocked.length
    ? 'Every selected task must be ready before they can be combined.'
    : lockedRepositories.length > 1
      ? 'Combined work must target one repository.'
      : null;
  const paperclipCompanies = [...new Map(paperclipTargets.flatMap((candidate) => {
    const binding = candidate.paperclipBinding;
    return binding
      ? [[binding.companyId, {
        id: binding.companyId,
        name: binding.companyName ?? candidate.name,
      }] as const]
      : [];
  })).values()];
  const currentCompanyRoutes = target.paperclipBinding
    ? paperclipTargets.filter((candidate) =>
      candidate.paperclipBinding?.companyId === target.paperclipBinding?.companyId)
    : [];
  const adapterOptions = [...new Set((paperclipOptions?.agents ?? [])
    .map(({ adapterType }) => adapterType)
    .filter((value): value is string => Boolean(value)))].sort();
  const normalizedAgentSearch = agentSearch.trim().toLowerCase();
  const visibleAgents = (paperclipOptions?.agents ?? []).filter((agent) => {
    if (adapterFilter !== '__all__' && agent.adapterType !== adapterFilter) return false;
    if (!normalizedAgentSearch) return true;
    return [
      agent.name,
      agent.title,
      agent.role,
      agent.adapterType,
    ].some((value) => value?.toLowerCase().includes(normalizedAgentSearch));
  });
  const taskTerms = [...new Set(target.eligibility
    .flatMap(({ title }) => title.toLowerCase().split(/[^a-z0-9]+/))
    .filter((term) => term.length > 2))];
  const suggestedAgentId = [...(paperclipOptions?.agents ?? [])]
    .filter((agent) => paperclipAgentState(agent.status).assignable)
    .map((agent) => {
      const searchable = [
        agent.name,
        agent.title,
        agent.role,
        agent.adapterType,
      ].filter(Boolean).join(' ').toLowerCase();
      const taskMatchScore = taskTerms.filter((term) => searchable.includes(term)).length * 2;
      const availabilityScore = agent.status === 'idle' || agent.status === 'active'
        ? 3
        : agent.status === 'running' ? 2 : agent.status === 'paused' ? 0 : 1;
      const defaultScore = agent.id === target.paperclipBinding?.assigneeAgentId ? 1 : 0;
      return { id: agent.id, score: taskMatchScore + availabilityScore + defaultScore };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))[0]?.id;
  return (
    <div className="space-y-5">
      {target.type === 'copilot-cloud' && taskCount > 1 && (
        <fieldset>
          <legend className="text-xs font-semibold text-[var(--text-primary)]">
            Execution strategy
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <label className="flex cursor-pointer gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
              <input
                type="radio"
                name="dispatch-strategy"
                value="separate"
                checked={dispatchStrategy === 'separate'}
                onChange={() => onDispatchStrategyChange('separate')}
                className="mt-0.5 h-4 w-4 accent-[var(--accent-500)]"
              />
              <span>
                <span className="block text-xs font-medium text-[var(--text-primary)]">
                  Separate
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-muted)]">
                  Create one cloud session and assignment per ready task.
                </span>
              </span>
            </label>
            <label
              title={combinedBlocker ?? undefined}
              className={cn(
                'flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3',
                combinedBlocker ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              )}
            >
              <input
                type="radio"
                name="dispatch-strategy"
                value="combined"
                checked={dispatchStrategy === 'combined'}
                disabled={Boolean(combinedBlocker)}
                onChange={() => onDispatchStrategyChange('combined')}
                className="mt-0.5 h-4 w-4 accent-[var(--accent-500)]"
              />
              <span>
                <span className="block text-xs font-medium text-[var(--text-primary)]">
                  Combined
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-muted)]">
                  Send one prompt, create one cloud session, and deliver one cohesive change.
                </span>
                {combinedBlocker && (
                  <span className="mt-1 block text-[11px] leading-relaxed text-amber-300">
                    {combinedBlocker}
                  </span>
                )}
              </span>
            </label>
            <label className="flex cursor-pointer gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
              <input
                type="radio"
                name="dispatch-strategy"
                value="auto"
                checked={dispatchStrategy === 'auto'}
                onChange={() => onDispatchStrategyChange('auto')}
                className="mt-0.5 h-4 w-4 accent-[var(--accent-500)]"
              />
              <span>
                <span className="block text-xs font-medium text-[var(--text-primary)]">
                  Auto
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[var(--text-muted)]">
                  Propose visible session groups and rationale before anything is dispatched.
                </span>
              </span>
            </label>
          </div>
        </fieldset>
      )}
      {target.type === 'paperclip' && target.paperclipBinding && (
        <section className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {paperclipCompanies.length > 1 && (
              <div className="text-xs font-medium text-[var(--text-secondary)]">
                Paperclip company
                <Select
                  value={target.paperclipBinding.companyId}
                  onValueChange={(companyId) => {
                    const companyTargets = paperclipTargets.filter((candidate) =>
                      candidate.paperclipBinding?.companyId === companyId);
                    const nextTarget = preferredTarget(companyTargets.filter((candidate) =>
                      candidate.eligibility.some(({ ready: value }) => value)))
                      ?? preferredTarget(companyTargets);
                    if (nextTarget) onPaperclipTargetChange(nextTarget);
                  }}
                >
                  <SelectTrigger aria-label="Paperclip company" className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {paperclipCompanies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>
                        {company.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {currentCompanyRoutes.length > 1 && (
              <div className="text-xs font-medium text-[var(--text-secondary)]">
                Connection route
                <Select value={target.id} onValueChange={(targetId) => {
                  const nextTarget = currentCompanyRoutes.find(({ id }) => id === targetId);
                  if (nextTarget) onPaperclipTargetChange(nextTarget);
                }}>
                  <SelectTrigger aria-label="Paperclip connection route" className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {currentCompanyRoutes.map((candidate) => (
                      <SelectItem
                        key={candidate.id}
                        value={candidate.id}
                        disabled={!candidate.eligibility.some(({ ready: value }) => value)}
                      >
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {currentCompanyRoutes.length > 1 && (
            <div className="flex gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs leading-5 text-amber-200">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              Multiple Mission Control routes connect this company. The selected route supplies
              the credential and saved defaults; the agent and project below control this dispatch.
            </div>
          )}
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
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Choose an agent
                </h3>
                <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">
                  {paperclipOptions.agents.filter((agent) =>
                    paperclipAgentState(agent.status).assignable).length}{' '}
                  assignable of {paperclipOptions.agents.length} roster agents
                  {' · '}{paperclipOptions.projects.length} project{
                    paperclipOptions.projects.length === 1 ? '' : 's'
                  }
                </p>
                </div>
                <div className="flex w-full gap-2 sm:w-auto">
                <label className="relative min-w-0 flex-1 sm:w-64">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                  />
                  <span className="sr-only">Search Paperclip agents</span>
                  <input
                    type="search"
                    value={agentSearch}
                    onChange={(event) => setAgentSearch(event.target.value)}
                    placeholder="Search role, title, or adapter"
                    className="input-glow min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] pl-9 pr-3 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  />
                </label>
                <Select value={adapterFilter} onValueChange={setAdapterFilter}>
                  <SelectTrigger aria-label="Filter agents by adapter" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All adapters</SelectItem>
                    {adapterOptions.map((adapter) => (
                      <SelectItem key={adapter} value={adapter}>{adapter}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                </div>
              </div>
              <fieldset>
                <legend className="sr-only">Paperclip agent</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                {visibleAgents.map((agent) => {
                const state = paperclipAgentState(agent.status);
                const selected = paperclipBinding.assigneeAgentId === agent.id;
                return (
                  <label
                    key={agent.id}
                    title={state.detail ?? undefined}
                    className={cn(
                      'relative rounded-lg border p-3 text-left transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]',
                      selected
                        ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/10'
                        : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)]',
                      !state.assignable && 'cursor-not-allowed opacity-55 hover:bg-[var(--surface-0)]',
                    )}
                  >
                    <input
                      type="radio"
                      name="paperclip-agent"
                      value={agent.id}
                      checked={selected}
                      disabled={!state.assignable}
                      onChange={() => onPaperclipBindingChange({
                        ...paperclipBinding,
                        assigneeAgentId: agent.id,
                        requiredAdapterType: undefined,
                      })}
                      className="sr-only"
                    />
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">
                          {agent.name}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">
                          {agent.title ?? agent.role ?? 'Paperclip agent'}
                        </span>
                      </span>
                      {agent.id === suggestedAgentId && state.assignable && (
                        <span className="rounded-full bg-[var(--accent-500)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--accent-300)]">
                          Suggested
                        </span>
                      )}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--text-tertiary)]">
                        {state.label}
                      </span>
                      {agent.adapterType && (
                        <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                          {agent.adapterType}
                        </span>
                      )}
                      {agent.role && agent.role !== agent.title && (
                        <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
                          {agent.role}
                        </span>
                      )}
                    </span>
                    {state.detail && (
                      <span className={cn(
                        'mt-2 block text-[10px] leading-4',
                        state.assignable ? 'text-amber-300' : 'text-[var(--text-muted)]',
                      )}>
                        {state.detail}
                      </span>
                    )}
                  </label>
                );
                })}
                </div>
              </fieldset>
              {visibleAgents.length === 0 && (
                <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-0)] px-4 py-6 text-center text-xs text-[var(--text-muted)]">
                No agents match this search and adapter filter.
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2">
                <p className="text-[11px] text-[var(--text-muted)]">Company</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                  <Building2 size={13} />
                  {paperclipOptions.companies.find(({ id }) =>
                    id === paperclipBinding.companyId)?.name
                    ?? target.paperclipBinding.companyName
                    ?? paperclipBinding.companyId}
                </p>
                </div>
                <div className="text-xs font-medium text-[var(--text-secondary)]">
                Paperclip project
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
                <span className="mt-1 block text-[10px] font-normal leading-4 text-[var(--text-muted)]">
                  Optional unless the company requires project-scoped work.
                </span>
                </div>
              </div>
            </>
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

      {target.type === 'copilot-cloud' && (
        <details className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
            Task details sent to Copilot
          </summary>
          <div className="space-y-3 border-t border-[var(--border-subtle)] p-3">
            <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
              Edit this copy for the agent. The original Mission Control task will not change.
            </p>
            {tasks.map((task) => (
              <label
                key={task.id}
                className="block text-xs font-medium text-[var(--text-secondary)]"
              >
                {task.title}
                <div className="input-glow mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
                  <textarea
                    aria-label={`Agent brief for ${task.title}`}
                    value={taskBriefs[task.id] ?? ''}
                    onChange={(event) => onTaskBriefChange(task.id, event.target.value)}
                    rows={4}
                    maxLength={32_000}
                    placeholder="Add the details Copilot needs to complete this task."
                    className="w-full resize-y bg-transparent px-3 py-2 text-sm font-normal text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  />
                </div>
              </label>
            ))}
          </div>
        </details>
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

      <section>
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">After queueing</h3>
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

      <details className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
          Destination instructions
          <span className="ml-2 font-normal text-[var(--text-muted)]">
            {target.alwaysInstructions ? 'Configured' : 'None configured'}
          </span>
        </summary>
        <div className="border-t border-[var(--border-subtle)] p-3">
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
            Applied to every eligible dispatch to this destination.
          </p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-1)] p-2 text-xs leading-relaxed text-[var(--text-secondary)]">
            {target.alwaysInstructions || 'No destination instructions configured.'}
          </pre>
        </div>
      </details>

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
      {blocked.length > 0 && (
        <ul className="mt-2 overflow-hidden rounded-lg border border-amber-700/30">
          {blocked.map((item) => <EligibilityItem key={item.taskId} item={item} />)}
        </ul>
      )}
      {ready.length > 0 && (
        <details className="mt-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
            {ready.length} ready task{ready.length === 1 ? '' : 's'}
          </summary>
          <ul className="border-t border-[var(--border-subtle)]">
            {ready.map((item) => <EligibilityItem key={item.taskId} item={item} />)}
          </ul>
        </details>
      )}
    </section>
  );
}

function EligibilityItem({
  item,
}: {
  item: TaskDelegationTarget['eligibility'][number];
}) {
  return (
    <li className="flex items-start gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2 last:border-b-0">
      {item.ready
        ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-300" />
        : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
          {item.title}
        </span>
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
  );
}

function AutoPlanStep({
  plan,
  onStrategyChange,
}: {
  plan: AutoPlan;
  onStrategyChange: (
    groupId: string,
    strategy: AutoPlanGroup['strategy'],
  ) => void;
}) {
  const sessionCount = plan.groups.reduce(
    (count, group) => count + (
      group.strategy === 'combined' ? 1 : group.taskIds.length
    ),
    0,
  );
  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Proposed execution plan
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
          {sessionCount} cloud session{sessionCount === 1 ? '' : 's'} proposed by {
            plan.routing.provider
          } · {plan.routing.model}. Review every group before disclosure preview.
        </p>
      </section>

      <div className="space-y-3">
        {plan.groups.map((group) => (
          <section
            key={group.id}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-xs font-semibold text-[var(--text-primary)]">
                  {group.strategy === 'combined'
                    ? `1 combined session · ${group.taskIds.length} tasks`
                    : `${group.taskIds.length} separate session${
                      group.taskIds.length === 1 ? '' : 's'
                    }`}
                </h4>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  {group.repository} · {Math.round(group.confidence * 100)}% confidence
                </p>
              </div>
              {group.taskIds.length > 1 && (
                <div className="inline-flex rounded-lg border border-[var(--border)] p-0.5">
                  {(['combined', 'separate'] as const).map((strategy) => (
                    <button
                      key={strategy}
                      type="button"
                      aria-pressed={group.strategy === strategy}
                      onClick={() => onStrategyChange(group.id, strategy)}
                      className={cn(
                        'min-h-8 rounded-md px-2.5 text-[11px] font-medium capitalize',
                        group.strategy === strategy
                          ? 'bg-[var(--accent-600)] text-white'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      {strategy}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ul className="mt-3 space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
              {group.taskIds.map((taskId) => (
                <li key={taskId} className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                  <Check size={12} className="mt-0.5 shrink-0 text-emerald-300" />
                  {plan.taskTitles[taskId] ?? taskId}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {group.rationale}
            </p>
          </section>
        ))}
      </div>

      {plan.blocked.length > 0 && (
        <EligibilityList ready={[]} blocked={plan.blocked} />
      )}
      <div className="flex gap-2 rounded-lg border border-[var(--accent-500)]/25 bg-[var(--accent-500)]/8 px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--accent-300)]" />
        This is a proposal only. No cloud sessions or durable assignments exist yet.
      </div>
    </div>
  );
}

function ReviewStep({
  target,
  batch,
  baseRef,
  model,
  createPullRequest,
  dispatchStrategy,
  markInProgress,
  paperclipBinding,
  paperclipOptions,
}: {
  target: TaskDelegationTarget;
  batch: PreviewBatch;
  baseRef: string;
  model: string;
  createPullRequest: boolean;
  dispatchStrategy: DispatchStrategy;
  markInProgress: boolean;
  paperclipBinding: PaperclipProviderConfig | null;
  paperclipOptions: PaperclipOptions | null;
}) {
  const actions = [...new Set(batch.previews.flatMap(({ allowedActions }) => allowedActions))];
  const classifications = [...new Set(
    batch.previews.map(({ dataClassification }) => dataClassification),
  )];
  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">
          What will be sent
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Review the instructions and task context {
            dispatchStrategy === 'combined'
              ? 'for the combined cloud session'
              : dispatchStrategy === 'auto'
                ? 'for each proposed cloud session'
                : `that will be sent to ${target.name}`
          }.
        </p>
        <div className="mt-2 space-y-2">
          {batch.previews.map((preview) => {
            const tasks = Array.isArray(preview.payloadPreview.tasks)
              ? preview.payloadPreview.tasks
                .map(payloadRecord)
                .filter((task): task is Record<string, unknown> => task !== null)
              : [];
            const taskCount = preview.taskIds?.length ?? tasks.length;
            const title = taskCount > 1
              ? `${taskCount} tasks combined`
              : payloadText(tasks[0]?.title) ?? preview.taskId;
            const instruction = payloadText(preview.payloadPreview.instruction);
            const alwaysInstructions = payloadText(preview.payloadPreview.alwaysInstructions);
            return (
              <article
                key={preview.dispatchId}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-3"
              >
                <h4 className="text-sm font-medium text-[var(--text-primary)]">{title}</h4>
                {instruction && (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-[var(--text-muted)]">Request</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">
                      {instruction}
                    </p>
                  </div>
                )}
                {alwaysInstructions && (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-[var(--text-muted)]">
                      Destination instructions
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">
                      {alwaysInstructions}
                    </p>
                  </div>
                )}
                {tasks.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[11px] font-medium text-[var(--text-muted)]">Task context</p>
                    <div className="mt-1 space-y-2">
                      {tasks.map((task, index) => {
                        const taskTitle = payloadText(task.title) ?? `Task ${index + 1}`;
                        const description = payloadText(task.description);
                        return (
                          <div key={payloadText(task.id) ?? `${preview.dispatchId}-${index}`}>
                            {taskCount > 1 && (
                              <p className="text-xs font-medium text-[var(--text-secondary)]">
                                {taskTitle}
                              </p>
                            )}
                            {description && (
                              <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">
                                {description}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <details className="mt-3 border-t border-[var(--border-subtle)] pt-2">
                  <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                    View technical dispatch data
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--background)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {JSON.stringify(preview.payloadPreview, null, 2)}
                  </pre>
                </details>
              </article>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
            <ExecutionDestinationIcon type={target.type} />
          </span>
          <div>
            <h3 className="text-sm font-medium text-[var(--text-primary)]">{target.name}</h3>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {batch.dispatchCount ?? batch.previews.length} durable assignment{
                (batch.dispatchCount ?? batch.previews.length) === 1 ? '' : 's'
              } for {batch.readyCount} task{batch.readyCount === 1 ? '' : 's'} · {target.executionLocality.replaceAll('-', ' ')}
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
        <h3 className="text-xs font-semibold text-[var(--text-primary)]">Data and permissions</h3>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
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
            <div className="mt-2 space-y-1">
              {batch.previews.map((preview) => (
                <p
                  key={preview.dispatchId}
                  className="text-[11px] leading-relaxed text-[var(--text-muted)]"
                >
                  {preview.classificationExplanation
                    ?? `${preview.dataClassification.replace('-', ' ')} source policy`}
                </p>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-[var(--text-muted)]">
              What {target.name} can do
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {actions.map((action) => (
                <span key={action} className="inline-flex items-center gap-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">
                  <Check size={9} />
                  {humanizeAction(action)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {batch.blocked.length > 0 && (
        <EligibilityList ready={[]} blocked={batch.blocked} />
      )}
      <div className="flex gap-2 rounded-lg border border-[var(--accent-500)]/25 bg-[var(--accent-500)]/8 px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--accent-300)]" />
        Nothing has been sent to the destination. Confirming creates {
          dispatchStrategy === 'combined'
            ? 'one durable assignment shared by every selected Mission Control task.'
            : dispatchStrategy === 'auto'
              ? 'the durable assignments shown in the proposed execution plan.'
            : 'one durable assignment per ready Mission Control task.'
        }
      </div>
    </div>
  );
}
