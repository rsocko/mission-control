'use client';

import {
  type ButtonHTMLAttributes,
  type ComponentType,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  Archive,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
  XCircle,
  AlertTriangle,
  Eye,
  FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  fadeSlideUp,
  modalContent,
  modalOverlay,
  scaleIn,
  staggerContainer,
} from '@/lib/motion';

type AgentType =
  | 'dismiss-old-notifications'
  | 'bulk-prioritize'
  | 'cleanup-done'
  | 'snooze-low-priority'
  | 'intake-document'
  | 'custom';

type AgentStatus = 'success' | 'partial' | 'failed';

interface AgentResult {
  agent: AgentType;
  status: AgentStatus;
  summary: string;
  actionsPerformed: number;
  details: Array<{ action: string; target: string; result: string }>;
  startedAt: string;
  completedAt: string;
}

interface AgentHistoryEntry extends AgentResult {
  id: string;
  dryRun: boolean;
  customInstruction?: string;
}

interface AgentDefinition {
  type: AgentType;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

type DispatchPhase = 'confirm' | 'running' | 'dry-run-results' | 'results';

interface DispatchState {
  agent: AgentDefinition;
  phase: DispatchPhase;
  dryRunResult?: AgentHistoryEntry;
  result?: AgentHistoryEntry;
  customInstruction?: string;
}

const AGENTS: AgentDefinition[] = [
  {
    type: 'dismiss-old-notifications',
    name: 'Dismiss old notifications',
    description: 'Mark stale low-severity notifications as read.',
    icon: Trash2,
  },
  {
    type: 'bulk-prioritize',
    name: 'Bulk prioritize',
    description: 'Re-rank tasks using due date urgency.',
    icon: ArrowUpDown,
  },
  {
    type: 'cleanup-done',
    name: 'Cleanup done',
    description: 'Archive tasks completed more than 30 days ago.',
    icon: Archive,
  },
  {
    type: 'snooze-low-priority',
    name: 'Snooze low priority',
    description: 'Reschedule overdue low-priority items forward by a week.',
    icon: Clock,
  },
  {
    type: 'intake-document',
    name: 'Document intake',
    description: 'Opens the Document Intake wizard to parse docs into projects.',
    icon: FileText,
  },
  {
    type: 'custom',
    name: 'Custom agent',
    description: 'Analyze tasks and notifications from your own instruction.',
    icon: Sparkles,
  },
];

const STATUS_META: Record<
  AgentStatus,
  {
    badge: 'success' | 'warning' | 'danger';
    label: string;
    icon: ComponentType<{ className?: string }>;
    iconClassName: string;
  }
> = {
  success: {
    badge: 'success',
    label: 'Success',
    icon: CheckCircle2,
    iconClassName: 'text-[var(--success)]',
  },
  partial: {
    badge: 'warning',
    label: 'Partial',
    icon: AlertTriangle,
    iconClassName: 'text-[var(--warning)]',
  },
  failed: {
    badge: 'danger',
    label: 'Failed',
    icon: XCircle,
    iconClassName: 'text-[var(--danger)]',
  },
};

export default function AgentPanel() {
  const router = useRouter();
  const [customInstruction, setCustomInstruction] = useState('');
  const [history, setHistory] = useState<AgentHistoryEntry[]>([]);
  const [latestResults, setLatestResults] = useState<Partial<Record<AgentType, AgentHistoryEntry>>>({});
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [dispatchState, setDispatchState] = useState<DispatchState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const standardAgents = useMemo(() => AGENTS.filter(agent => agent.type !== 'custom'), []);
  const customAgent = useMemo(() => AGENTS.find(agent => agent.type === 'custom')!, []);

  const openConfirmation = useCallback((agent: AgentDefinition) => {
    if (agent.type === 'intake-document') {
      router.push('/intake');
      return;
    }
    const instruction = agent.type === 'custom' ? customInstruction.trim() : undefined;
    if (agent.type === 'custom' && !instruction) {
      toast.error('Enter a custom instruction first.');
      return;
    }
    setDispatchState({ agent, phase: 'confirm', customInstruction: instruction });
  }, [customInstruction, router]);

  const cancelDispatch = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setDispatchState(null);
  }, []);

  const executeDispatch = useCallback(async (dryRun: boolean) => {
    if (!dispatchState) return;

    const { agent } = dispatchState;
    const instruction = dispatchState.customInstruction;
    const controller = new AbortController();
    abortRef.current = controller;

    setDispatchState(prev => prev ? { ...prev, phase: 'running' } : null);

    const startedAt = new Date().toISOString();

    try {
      const response = await fetch('/api/ai/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agent.type,
          dryRun,
          customInstruction: instruction,
        }),
        signal: controller.signal,
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'Unable to dispatch agent.');
      }

      const entry: AgentHistoryEntry = {
        id: createRunId(agent.type),
        dryRun,
        customInstruction: instruction,
        ...payload,
      };

      setLatestResults(current => ({ ...current, [agent.type]: entry }));
      setHistory(current => [entry, ...current].slice(0, 5));
      setExpandedRuns(current => ({ ...current, [entry.id]: true }));

      if (dryRun) {
        setDispatchState(prev => prev ? { ...prev, phase: 'dry-run-results', dryRunResult: entry } : null);
      } else {
        setDispatchState(prev => prev ? { ...prev, phase: 'results', result: entry } : null);
        toast.success(`Agent finished: ${entry.summary}`);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;

      const message = error instanceof Error ? error.message : 'Agent dispatch failed.';
      const failedEntry: AgentHistoryEntry = {
        id: createRunId(agent.type),
        agent: agent.type,
        status: 'failed',
        summary: message,
        actionsPerformed: 0,
        details: [],
        startedAt,
        completedAt: new Date().toISOString(),
        dryRun,
        customInstruction: instruction,
      };

      setLatestResults(current => ({ ...current, [agent.type]: failedEntry }));
      setHistory(current => [failedEntry, ...current].slice(0, 5));
      setExpandedRuns(current => ({ ...current, [failedEntry.id]: true }));
      setDispatchState(prev => prev ? { ...prev, phase: 'results', result: failedEntry } : null);
      toast.error(message);
    } finally {
      abortRef.current = null;
    }
  }, [dispatchState]);

  function toggleExpanded(id: string) {
    setExpandedRuns(current => ({ ...current, [id]: !current[id] }));
  }

  return (
    <>
      <motion.div
        className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6"
        variants={staggerContainer}
        initial="hidden"
        animate="show"
      >
        <motion.section variants={fadeSlideUp} className="space-y-2">
          <p className="text-sm font-medium text-[var(--text-secondary)]">Agent dispatch</p>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)] [text-wrap:balance]">
            Run focused AI automations and inspect exactly what they changed.
          </h2>
          <p className="max-w-3xl text-sm text-[var(--text-tertiary)] [text-wrap:pretty]">
            Trigger built-in agents, compare dry runs before applying changes, and review the last five runs.
          </p>
        </motion.section>

        <motion.section
          variants={staggerContainer}
          className="grid gap-4 lg:grid-cols-2"
        >
          {standardAgents.map(agent => (
            <motion.div
              key={agent.type}
              variants={scaleIn}
              className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4 shadow-[var(--shadow-sm)]"
            >
              <AgentCardHeader agent={agent} />

              <div className="mt-4 flex flex-wrap gap-2">
                <ActionButton
                  onClick={() => openConfirmation(agent)}
                  primary
                >
                  {agent.type === 'intake-document' ? <FileText className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {agent.type === 'intake-document' ? 'Open Wizard' : 'Run'}
                </ActionButton>
              </div>

              {latestResults[agent.type] ? (
                <div className="mt-4">
                  <ResultCard
                    result={latestResults[agent.type]!}
                    expanded={Boolean(expandedRuns[latestResults[agent.type]!.id])}
                    onToggleExpanded={() => toggleExpanded(latestResults[agent.type]!.id)}
                  />
                </div>
              ) : null}
            </motion.div>
          ))}

          <motion.div
            variants={scaleIn}
            className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4 shadow-[var(--shadow-sm)] lg:col-span-2"
          >
            <AgentCardHeader agent={customAgent} />

            <div className="mt-4 space-y-3">
              <textarea
                value={customInstruction}
                onChange={event => setCustomInstruction(event.target.value)}
                placeholder="Example: Review overdue tasks and propose the top three actions I should take next."
                className="min-h-28 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none transition-[border-color,box-shadow] [text-wrap:pretty]"
              />
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  onClick={() => openConfirmation(customAgent)}
                  disabled={!customInstruction.trim()}
                  primary
                >
                  <Play className="h-4 w-4" />
                  Execute
                </ActionButton>
              </div>
            </div>

            {latestResults.custom ? (
              <div className="mt-4">
                <ResultCard
                  result={latestResults.custom}
                  expanded={Boolean(expandedRuns[latestResults.custom.id])}
                  onToggleExpanded={() => toggleExpanded(latestResults.custom!.id)}
                />
              </div>
            ) : null}
          </motion.div>
        </motion.section>

        <motion.section
          variants={fadeSlideUp}
          className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4 shadow-[var(--shadow-sm)]"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              Recent history <span className="text-sm font-normal text-[var(--text-tertiary)]">· all agents</span>
            </h3>
            <Badge variant="secondary">{history.length}/5 saved</Badge>
          </div>

          {history.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-0)] px-4 py-6 text-sm text-[var(--text-tertiary)]">
              Pick an agent above and let it do the heavy lifting.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {history.map(entry => (
                <ResultCard
                  key={entry.id}
                  result={entry}
                  expanded={Boolean(expandedRuns[entry.id])}
                  onToggleExpanded={() => toggleExpanded(entry.id)}
                  showAgentLabel
                />
              ))}
            </div>
          )}
        </motion.section>
      </motion.div>

      {/* Dispatch Confirmation Overlay */}
      <AnimatePresence>
        {dispatchState ? (
          <DispatchOverlay
            state={dispatchState}
            onCancel={cancelDispatch}
            onDryRun={() => executeDispatch(true)}
            onRun={() => executeDispatch(false)}
            onDismiss={() => setDispatchState(null)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

// ─── Dispatch Confirmation Overlay ───────────────────────────────────────────

function DispatchOverlay({
  state,
  onCancel,
  onDryRun,
  onRun,
  onDismiss,
}: {
  state: DispatchState;
  onCancel: () => void;
  onDryRun: () => void;
  onRun: () => void;
  onDismiss: () => void;
}) {
  const { agent, phase, dryRunResult, result } = state;
  const Icon = agent.icon;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      variants={modalOverlay}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      {/* Backdrop */}
      <motion.div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={phase !== 'running' ? onCancel : undefined}
      />

      {/* Panel */}
      <motion.div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl"
        variants={modalContent}
        initial="hidden"
        animate="show"
        exit="exit"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-0)]">
            <Icon className="h-5 w-5 text-[var(--text-primary)]" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">{agent.name}</h3>
            <p className="text-sm text-[var(--text-tertiary)]">{agent.description}</p>
          </div>
          {phase !== 'running' ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] active:scale-[0.96]"
            >
              <X className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        {/* Body — different per phase */}
        <div className="px-5 py-4">
          <AnimatePresence mode="wait">
            {phase === 'confirm' ? (
              <ConfirmPhase
                key="confirm"
                agent={agent}
                customInstruction={state.customInstruction}
                onDryRun={onDryRun}
                onRun={onRun}
                onCancel={onCancel}
              />
            ) : phase === 'running' ? (
              <RunningPhase
                key="running"
                agent={agent}
                onCancel={onCancel}
              />
            ) : phase === 'dry-run-results' && dryRunResult ? (
              <DryRunResultsPhase
                key="dry-run-results"
                result={dryRunResult}
                onConfirmExecute={onRun}
                onDismiss={onDismiss}
              />
            ) : phase === 'results' && result ? (
              <ResultsPhase
                key="results"
                result={result}
                onDismiss={onDismiss}
              />
            ) : null}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ConfirmPhase({
  agent,
  customInstruction,
  onDryRun,
  onRun,
  onCancel,
}: {
  agent: AgentDefinition;
  customInstruction?: string;
  onDryRun: () => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      variants={fadeSlideUp}
      initial="hidden"
      animate="show"
      exit="exit"
      className="space-y-4"
    >
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
          This agent will
        </p>
        <p className="mt-1 text-sm text-[var(--text-primary)] [text-wrap:pretty]">
          {agent.description}
        </p>
      </div>

      {customInstruction ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
            Custom instruction
          </p>
          <p className="mt-1 text-sm text-[var(--text-primary)] [text-wrap:pretty]">
            &ldquo;{customInstruction}&rdquo;
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <ActionButton onClick={onDryRun}>
          <Eye className="h-4 w-4" />
          Dry Run
        </ActionButton>
        <ActionButton onClick={onRun} primary>
          <Play className="h-4 w-4" />
          Run
        </ActionButton>
        <ActionButton onClick={onCancel} className="ml-auto">
          Cancel
        </ActionButton>
      </div>
    </motion.div>
  );
}

function RunningPhase({
  agent,
  onCancel,
}: {
  agent: AgentDefinition;
  onCancel: () => void;
}) {
  return (
    <motion.div
      variants={fadeSlideUp}
      initial="hidden"
      animate="show"
      exit="exit"
      className="flex flex-col items-center gap-4 py-6"
    >
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
      >
        <Loader2 className="h-8 w-8 text-blue-500" />
      </motion.div>
      <div className="text-center">
        <p className="text-sm font-semibold text-[var(--text-primary)]">
          Running {agent.name}&hellip;
        </p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          This may take a few seconds.
        </p>
      </div>
      <ActionButton onClick={onCancel} className="mt-2">
        <X className="h-4 w-4" />
        Cancel
      </ActionButton>
    </motion.div>
  );
}

function DryRunResultsPhase({
  result,
  onConfirmExecute,
  onDismiss,
}: {
  result: AgentHistoryEntry;
  onConfirmExecute: () => void;
  onDismiss: () => void;
}) {
  const statusMeta = STATUS_META[result.status];
  const StatusIcon = statusMeta.icon;

  return (
    <motion.div
      variants={fadeSlideUp}
      initial="hidden"
      animate="show"
      exit="exit"
      className="space-y-4"
    >
      <div className="flex items-center gap-2">
        <StatusIcon className={cn('h-4 w-4', statusMeta.iconClassName)} />
        <span className="text-sm font-semibold text-[var(--text-primary)]">Dry run complete</span>
        <Badge variant={statusMeta.badge}>{statusMeta.label}</Badge>
        <Badge variant="outline">Preview</Badge>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3">
        <p className="text-sm text-[var(--text-primary)] [text-wrap:pretty]">{result.summary}</p>
        <p className="mt-2 text-xs text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">
          Would affect {result.actionsPerformed} item{result.actionsPerformed !== 1 ? 's' : ''}
        </p>
      </div>

      {result.details.length > 0 ? (
        <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--border)]">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-[var(--surface-1)]">
              <tr className="text-left text-xs uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.details.map((detail, index) => (
                <tr
                  key={`dry-${detail.action}-${detail.target}-${index}`}
                  className="border-t border-[var(--border)] text-[var(--text-secondary)]"
                >
                  <td className="px-3 py-2 align-top font-medium text-[var(--text-primary)]">{detail.action}</td>
                  <td className="px-3 py-2 align-top">&ldquo;{detail.target}&rdquo;</td>
                  <td className="px-3 py-2 align-top">{detail.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <ActionButton onClick={onConfirmExecute} primary>
          <Play className="h-4 w-4" />
          Confirm &amp; Execute
        </ActionButton>
        <ActionButton onClick={onDismiss} className="ml-auto">
          Dismiss
        </ActionButton>
      </div>
    </motion.div>
  );
}

function ResultsPhase({
  result,
  onDismiss,
}: {
  result: AgentHistoryEntry;
  onDismiss: () => void;
}) {
  const statusMeta = STATUS_META[result.status];
  const StatusIcon = statusMeta.icon;
  const duration = formatDuration(result.startedAt, result.completedAt);

  return (
    <motion.div
      variants={fadeSlideUp}
      initial="hidden"
      animate="show"
      exit="exit"
      className="space-y-4"
    >
      <div className="flex items-center gap-2">
        <StatusIcon className={cn('h-4 w-4', statusMeta.iconClassName)} />
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          {result.status === 'failed' ? 'Execution failed' : 'Execution complete'}
        </span>
        <Badge variant={statusMeta.badge}>{statusMeta.label}</Badge>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3">
        <p className="text-sm text-[var(--text-primary)] [text-wrap:pretty]">{result.summary}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">
          <span>Duration: {duration}</span>
          <span>Actions: {result.actionsPerformed}</span>
        </div>
      </div>

      {result.details.length > 0 ? (
        <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--border)]">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-[var(--surface-1)]">
              <tr className="text-left text-xs uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.details.map((detail, index) => (
                <tr
                  key={`result-${detail.action}-${detail.target}-${index}`}
                  className="border-t border-[var(--border)] text-[var(--text-secondary)]"
                >
                  <td className="px-3 py-2 align-top font-medium text-[var(--text-primary)]">{detail.action}</td>
                  <td className="px-3 py-2 align-top">&ldquo;{detail.target}&rdquo;</td>
                  <td className="px-3 py-2 align-top">{detail.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {result.status !== 'failed' ? (
          <ActionButton disabled>
            <RotateCcw className="h-4 w-4" />
            Undo (coming soon)
          </ActionButton>
        ) : null}
        <ActionButton onClick={onDismiss} primary className="ml-auto">
          Done
        </ActionButton>
      </div>
    </motion.div>
  );
}

// ─── Shared Sub-Components ──────────────────────────────────────────────────

function AgentCardHeader({ agent }: { agent: AgentDefinition }) {
  const Icon = agent.icon;

  return (
    <div className="flex items-start gap-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-0)] shadow-[inset_0_0_0_1px_rgb(255_255_255_/_0.04)]">
        <Icon className="h-5 w-5 text-[var(--text-primary)]" />
      </div>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-[var(--text-primary)]">{agent.name}</h3>
        <p className="mt-1 text-sm text-[var(--text-tertiary)] [text-wrap:pretty]">{agent.description}</p>
      </div>
    </div>
  );
}

function ResultCard({
  result,
  expanded,
  onToggleExpanded,
  showAgentLabel = false,
}: {
  result: AgentHistoryEntry;
  expanded: boolean;
  onToggleExpanded: () => void;
  showAgentLabel?: boolean;
}) {
  const statusMeta = STATUS_META[result.status];
  const StatusIcon = statusMeta.icon;
  const duration = formatDuration(result.startedAt, result.completedAt);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusIcon className={cn('h-4 w-4 shrink-0', statusMeta.iconClassName)} />
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {showAgentLabel ? result.agent : result.dryRun ? 'Dry run complete' : 'Run complete'}
            </span>
            <Badge variant={statusMeta.badge}>{statusMeta.label}</Badge>
            {result.dryRun ? <Badge variant="outline">Dry run</Badge> : null}
          </div>
          <p className="mt-2 text-sm text-[var(--text-primary)] [text-wrap:pretty]">{result.summary}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-tertiary)]">
            <span>Duration: {duration}</span>
            <span>Actions: {result.actionsPerformed}</span>
            <span>{formatTimestamp(result.completedAt)}</span>
          </div>
          {result.customInstruction ? (
            <p className="mt-2 text-xs text-[var(--text-muted)] [text-wrap:pretty]">
              “{result.customInstruction}”
            </p>
          ) : null}
        </div>

        {result.details.length > 0 ? (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-1)]"
          >
            {expanded ? 'Hide details' : 'Details'}
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>

      {expanded && result.details.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-[var(--border)]">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-[var(--surface-1)]">
              <tr className="text-left text-xs uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.details.map((detail, index) => (
                <tr
                  key={`${result.id}-${detail.action}-${detail.target}-${index}`}
                  className="border-t border-[var(--border)] text-[var(--text-secondary)]"
                >
                  <td className="px-3 py-2 align-top font-medium text-[var(--text-primary)]">{detail.action}</td>
                  <td className="px-3 py-2 align-top">“{detail.target}”</td>
                  <td className="px-3 py-2 align-top">{detail.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({
  children,
  className,
  primary = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-[background-color,transform,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.96]',
        primary
          ? 'bg-blue-600 text-white hover:bg-blue-700'
          : 'border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-1)]',
        className
      )}
      {...props}
    />
  );
}

function createRunId(agent: AgentType) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatDuration(startedAt: string, completedAt: string) {
  const durationMs = Math.max(new Date(completedAt).getTime() - new Date(startedAt).getTime(), 0);
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
