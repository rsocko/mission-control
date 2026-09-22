'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ListTodo,
  Loader2,
  Search,
  Sparkles,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { MetricChip } from '@/components/ai/ChatWidgets';
import { TaskReferenceRow } from '@/components/ai/TaskReferenceRow';
import {
  parseTriageSummaryData,
  TriageSummaryCard,
} from '@/components/triage/TriageSummaryCard';
import { formatInlineInput, formatJson } from '@/lib/ai/chatFormatters';
import { getToolName, type ToolPart } from '@/lib/ai/chatMessageFactory';
import {
  FINANCE_TOOL_NAMES,
  FINANCE_MUTATION_TOOL_NAMES,
  assignFinanceTransactionKidInputSchema,
  assignFinanceTransactionKidOutputSchema,
  financeToolOutputSchema,
  updateFinanceTransactionCategoryInputSchema,
  updateFinanceTransactionCategoryOutputSchema,
  type FinanceToolOutput,
} from '@/lib/finance/houston-contracts';
import {
  dayPlanResultSchema,
  taskMutationResultSchema,
  taskSearchResultSchema,
  taskSummaryResultSchema,
} from '@/lib/ai/toolResultSchemas';
import { scaleIn } from '@/lib/motion';
import { TRIAGE_SUMMARY_RESOURCE_URI } from '@/lib/triage/summary-contract';

const NATIVE_TASK_TOOLS = new Set([
  'searchTasks',
  'getTaskSummary',
  'suggestDayPlan',
  'completeTask',
  'updateTaskPriority',
]);
const FINANCE_TOOLS = new Set<string>([
  ...FINANCE_TOOL_NAMES,
  ...FINANCE_MUTATION_TOOL_NAMES,
]);
const NATIVE_WIDGET_RESOURCE_BY_TOOL = {
  searchTriage: TRIAGE_SUMMARY_RESOURCE_URI,
} as const;

export type ToolApprovalHandler = (
  part: ToolPart,
  approved: boolean,
) => Promise<void>;

export function ToolCard({
  part,
  onApprovalResponse,
}: {
  part: ToolPart;
  onApprovalResponse?: ToolApprovalHandler;
}) {
  const toolName = getToolName(part);

  if (Object.hasOwn(NATIVE_WIDGET_RESOURCE_BY_TOOL, toolName)) {
    return <TriageToolCard part={part} />;
  }

  if (NATIVE_TASK_TOOLS.has(toolName)) {
    return <NativeTaskToolCard part={part} toolName={toolName} />;
  }

  if (FINANCE_TOOLS.has(toolName)) {
    return FINANCE_MUTATION_TOOL_NAMES.includes(
      toolName as typeof FINANCE_MUTATION_TOOL_NAMES[number],
    )
      ? (
          <FinanceMutationToolCard
            part={part}
            toolName={toolName}
            onApprovalResponse={onApprovalResponse}
          />
        )
      : <FinanceToolCard part={part} toolName={toolName} />;
  }

  return <GenericToolCard part={part} toolName={toolName} />;
}

const FINANCE_PRESENTATION: Record<string, { label: string; loading: string }> = {
  getHouseholdFinanceSummary: { label: 'Household finance summary', loading: 'Calculating household totals' },
  searchFinanceTransactions: { label: 'Finance transactions', loading: 'Searching persisted transactions' },
  getPendingFinanceExceptions: { label: 'Finance exceptions', loading: 'Loading attribution exceptions' },
  getKidSpending: { label: 'Kid spending', loading: 'Calculating household member spending' },
  getFinanceObligations: { label: 'Finance obligations', loading: 'Loading recurring obligations' },
  getFinanceConnectorHealth: { label: 'Finance connector health', loading: 'Checking projection freshness' },
};

const FINANCE_MUTATION_PRESENTATION = {
  assignFinanceTransactionKid: {
    label: 'Assign transaction to household member',
    applying: 'Applying approved kid assignment',
  },
  updateFinanceTransactionCategory: {
    label: 'Update transaction category',
    applying: 'Applying approved category update',
  },
} as const;

function FinanceMutationToolCard({
  part,
  toolName,
  onApprovalResponse,
}: {
  part: ToolPart;
  toolName: string;
  onApprovalResponse?: ToolApprovalHandler;
}) {
  const [submitting, setSubmitting] = useState(false);
  const presentation = FINANCE_MUTATION_PRESENTATION[
    toolName as keyof typeof FINANCE_MUTATION_PRESENTATION
  ];
  const respond = async (approved: boolean) => {
    if (!onApprovalResponse || submitting) return;
    setSubmitting(true);
    try {
      await onApprovalResponse(part, approved);
    } finally {
      setSubmitting(false);
    }
  };

  if (part.state === 'approval-requested') {
    const proposal = mutationProposal(part, toolName);
    if (!proposal) return <InvalidResultState />;
    return (
      <section
        className="overflow-hidden rounded-lg border border-amber-400/40 bg-[var(--surface-1)]"
        aria-label={`${presentation.label} approval required`}
      >
        <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5">
          <TriangleAlert size={17} className="mt-0.5 text-amber-300" aria-hidden="true" />
          <span>
            <span className="block text-sm font-semibold text-[var(--text-primary)]">
              Approval required
            </span>
            <span className="block text-xs text-[var(--text-muted)]">{presentation.label}</span>
          </span>
        </header>
        <div className="space-y-3 p-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {proposal.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-[var(--text-muted)]">{label}</dt>
                <dd className="min-w-0 truncate text-[var(--text-primary)]">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-[var(--text-muted)]">
            This financial change will execute only after you approve this exact proposal.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void respond(true)}
              disabled={submitting || !onApprovalResponse}
              className="min-h-10 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-50"
              aria-label={`Approve ${presentation.label.toLowerCase()}`}
            >
              {submitting ? 'Submitting...' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => void respond(false)}
              disabled={submitting || !onApprovalResponse}
              className="min-h-10 rounded-md border border-[var(--border)] px-3 text-sm font-medium text-[var(--text-primary)] disabled:opacity-50"
              aria-label={`Deny ${presentation.label.toLowerCase()}`}
            >
              Deny
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (part.state === 'output-denied') {
    return (
      <StateMessage title={`${presentation.label} denied`}>
        No finance mutation was executed.
      </StateMessage>
    );
  }
  if (part.state === 'output-error') {
    return (
      <StateMessage tone="error" title={`${presentation.label} failed`}>
        {part.errorText || 'The approved finance mutation failed.'}
      </StateMessage>
    );
  }
  if (part.state !== 'output-available') {
    return (
      <StateMessage title={presentation.label}>
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        <span>{presentation.applying}...</span>
      </StateMessage>
    );
  }

  const result = toolName === 'assignFinanceTransactionKid'
    ? assignFinanceTransactionKidOutputSchema.safeParse(part.output)
    : updateFinanceTransactionCategoryOutputSchema.safeParse(part.output);
  if (!result.success) return <InvalidResultState />;
  if (result.data.status === 'failed') {
    return (
      <StateMessage tone="error" title={`${presentation.label} failed`}>
        {result.data.error.message}
        {result.data.error.retryable ? ' You can review current state and make a new proposal.' : ''}
      </StateMessage>
    );
  }
  const detail = result.data.kind === 'finance-kid-assignment'
    ? `Assigned to ${result.data.missionControlConfirmed.kidName}`
    : `Category confirmed as ${result.data.factsViaTyrionBridge.category}`;
  return (
    <StateMessage title={`${presentation.label} complete`}>
      <CheckCircle2 size={14} className="text-emerald-300" aria-hidden="true" />
      <span>{detail}{result.data.replayed ? ' (already applied)' : ''}</span>
    </StateMessage>
  );
}

function mutationProposal(part: ToolPart, toolName: string): Array<[string, string]> | null {
  if (part.state !== 'approval-requested') return null;
  if (toolName === 'assignFinanceTransactionKid') {
    const parsed = assignFinanceTransactionKidInputSchema.safeParse(part.input);
    if (!parsed.success) return null;
    return [
      ['Transaction', `${parsed.data.expected.merchant} on ${parsed.data.expected.date}`],
      ['Amount', formatCurrency(parsed.data.expected.amount)],
      ['Current kid', parsed.data.expected.kidName ?? 'Unassigned'],
      ['New kid', parsed.data.kidName],
    ];
  }
  const parsed = updateFinanceTransactionCategoryInputSchema.safeParse(part.input);
  if (!parsed.success) return null;
  return [
    ['Transaction', `${parsed.data.expected.merchant} on ${parsed.data.expected.date}`],
    ['Amount', formatCurrency(parsed.data.expected.amount)],
    ['Current category', parsed.data.expected.category ?? 'Uncategorized'],
    ['New category', parsed.data.categoryName],
  ];
}

function FinanceToolCard({ part, toolName }: { part: ToolPart; toolName: string }) {
  const presentation = FINANCE_PRESENTATION[toolName];
  if (part.state === 'output-error') {
    return (
      <StateMessage tone="error" title={`${presentation.label} failed`}>
        {part.errorText || 'The finance result is unavailable.'}
      </StateMessage>
    );
  }
  if (part.state !== 'output-available') {
    return (
      <StateMessage title={presentation.label}>
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        <span>{presentation.loading}...</span>
      </StateMessage>
    );
  }
  const parsed = financeToolOutputSchema.safeParse(part.output);
  if (!parsed.success) return <InvalidResultState />;
  const result = parsed.data;
  return (
    <motion.section
      initial="hidden"
      animate="show"
      variants={scaleIn}
      className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
      aria-label={presentation.label}
    >
      <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <CircleDollarSign size={17} className="mt-0.5 text-emerald-300" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[var(--text-primary)]">{presentation.label}</span>
          <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
            {financeSubtitle(result)}
          </span>
        </span>
        <FreshnessBadge freshness={result.meta.freshness} />
      </header>
      <div className="space-y-3 p-3">
        {renderFinanceBody(result)}
        <FinanceProvenance result={result} />
        <Link
          href={result.meta.deepLink}
          className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-[var(--accent-400)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Open Finance <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </div>
    </motion.section>
  );
}

function financeSubtitle(result: FinanceToolOutput): string {
  switch (result.kind) {
    case 'household-finance-summary':
      return `${formatCurrency(result.missionControlCalculated.totalSpending)} across ${result.missionControlCalculated.transactionCount} transactions`;
    case 'finance-transaction-search':
      return `${result.transactions.length} transaction${result.transactions.length === 1 ? '' : 's'}`;
    case 'pending-finance-exceptions':
      return `${result.exceptions.length} exception${result.exceptions.length === 1 ? '' : 's'} needing review`;
    case 'kid-spending':
      return `${result.kidName}: ${formatCurrency(result.missionControlCalculated.totalSpending)}`;
    case 'finance-obligations':
      return `${result.obligations.length} obligation${result.obligations.length === 1 ? '' : 's'} within ${result.horizonDays} days`;
    case 'finance-connector-health':
      return `Projection is ${result.missionControlCalculated.overall}`;
  }
}

function renderFinanceBody(result: FinanceToolOutput) {
  switch (result.kind) {
    case 'household-finance-summary':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <MetricChip label="Spending" value={formatCurrency(result.missionControlCalculated.totalSpending)} />
            <MetricChip label="Transactions" value={result.missionControlCalculated.transactionCount} />
          </div>
          <FinanceRows rows={result.missionControlCalculated.byCategory.map(row => ({
            primary: row.category,
            secondary: `${row.transactionCount} transaction${row.transactionCount === 1 ? '' : 's'}`,
            value: formatCurrency(row.amount),
          }))} empty="No spending in this period." />
        </div>
      );
    case 'finance-transaction-search':
      return <FinanceRows rows={transactionRows(result.transactions)} empty="No matching transactions." />;
    case 'pending-finance-exceptions':
      return <FinanceRows rows={result.exceptions.map(item => ({
        primary: item.merchant,
        secondary: `${item.date} · Tyrion-derived: ${item.reason}`,
        value: item.confidence ?? 'review',
      }))} empty="No attribution exceptions need review." />;
    case 'kid-spending':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <MetricChip label="Spending" value={formatCurrency(result.missionControlCalculated.totalSpending)} />
            <MetricChip label="Transactions" value={result.missionControlCalculated.transactionCount} />
          </div>
          <FinanceRows rows={transactionRows(result.recentTransactions)} empty="No spending in this period." />
        </div>
      );
    case 'finance-obligations':
      return (
        <div className="space-y-2">
          <MetricChip label="Estimated monthly" value={formatCurrency(result.missionControlCalculated.estimatedMonthlyAmount)} />
          <FinanceRows rows={result.obligations.map(({ factsViaTyrionBridge: item }) => ({
            primary: item.merchant,
            secondary: [item.frequency, item.nextExpectedDate].filter(Boolean).join(' · '),
            value: formatCurrency(item.amount),
          }))} empty="No recurring obligations in this horizon." />
        </div>
      );
    case 'finance-connector-health':
      return <FinanceRows rows={[
        {
          primary: 'Persisted Bridge projection',
          secondary: result.bridgeProjection.lastSuccessfulSyncAt
            ? `Last successful sync ${formatTimestamp(result.bridgeProjection.lastSuccessfulSyncAt)}`
            : 'No successful sync recorded',
          value: result.bridgeProjection.status,
        },
        {
          primary: 'Tyrion attribution',
          secondary: result.tyrionAttribution.lastSuccessfulAt
            ? `Last successful run ${formatTimestamp(result.tyrionAttribution.lastSuccessfulAt)}`
            : 'No successful attribution run recorded',
          value: result.tyrionAttribution.status,
        },
        ...result.datasets.map(dataset => ({
          primary: dataset.name,
          secondary: `${dataset.itemCount} projected item${dataset.itemCount === 1 ? '' : 's'}`,
          value: dataset.freshness,
        })),
      ]} empty="Finance health is unavailable." />;
  }
}

function transactionRows(transactions: Array<{
  factsViaTyrionBridge: { merchant: string; date: string; amount: number; category: string | null };
  tyrionDerived: { kidName: string | null };
}>) {
  return transactions.map(({ factsViaTyrionBridge: facts, tyrionDerived }) => ({
    primary: facts.merchant,
    secondary: [facts.date, facts.category, tyrionDerived.kidName && `Tyrion: ${tyrionDerived.kidName}`].filter(Boolean).join(' · '),
    value: formatCurrency(facts.amount),
  }));
}

function FinanceRows({
  rows,
  empty,
}: {
  rows: Array<{ primary: string; secondary: string; value: string }>;
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="divide-y divide-[var(--border-subtle)] rounded-md border border-[var(--border-subtle)]">
      {rows.map((row, index) => (
        <div key={`${row.primary}-${index}`} className="flex items-start justify-between gap-3 px-2.5 py-2 text-xs">
          <span className="min-w-0">
            <span className="block truncate font-medium text-[var(--text-primary)]">{row.primary}</span>
            <span className="mt-0.5 block text-[var(--text-muted)]">{row.secondary}</span>
          </span>
          <span className="shrink-0 font-medium tabular-nums text-[var(--text-secondary)]">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function FinanceProvenance({ result }: { result: FinanceToolOutput }) {
  return (
    <div className="space-y-1 text-[11px] text-[var(--text-muted)]">
      <p>
        Source as of {result.meta.sourceAsOf ? formatTimestamp(result.meta.sourceAsOf) : 'unavailable'}
        {result.meta.coverage ? ` · coverage ${result.meta.coverage.start} to ${result.meta.coverage.end}` : ''}
        {result.meta.truncated ? ' · result truncated' : ''}
      </p>
      <p>{result.meta.provenance.filter(item => item.included).map(item => item.label).join(' · ')}</p>
    </div>
  );
}

function FreshnessBadge({ freshness }: { freshness: FinanceToolOutput['meta']['freshness'] }) {
  const tone = freshness === 'fresh'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
    : freshness === 'unavailable'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>{freshness}</span>;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function TriageToolCard({ part }: { part: ToolPart }) {
  if (part.state === 'output-error') {
    return (
      <StateMessage tone="error" title="Triage search failed">
        {part.errorText || 'The tool did not return a result.'}
      </StateMessage>
    );
  }

  if (part.state !== 'output-available') {
    return (
      <StateMessage title="Searching triage">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        <span>Waiting for saved items...</span>
      </StateMessage>
    );
  }

  const parsed = parseTriageSummaryData(part.output);
  return parsed.success ? <TriageSummaryCard data={parsed.data} /> : <InvalidResultState />;
}

function NativeTaskToolCard({ part, toolName }: { part: ToolPart; toolName: string }) {
  const presentation = getNativePresentation(toolName);

  return (
    <motion.section
      initial="hidden"
      animate="show"
      variants={scaleIn}
      className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
      aria-label={presentation.label}
    >
      <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <span className={`mt-0.5 ${part.state === 'output-error' ? 'text-rose-300' : presentation.iconClass}`}>
          {part.state === 'output-error' ? <TriangleAlert size={16} /> : presentation.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[var(--text-primary)]">{presentation.label}</span>
          <span className="mt-0.5 block text-xs text-[var(--text-muted)]">{getNativeSubtitle(part, toolName)}</span>
        </span>
      </header>
      <div className="p-3">
        {renderNativeTaskBody(part, toolName)}
      </div>
    </motion.section>
  );
}

function renderNativeTaskBody(part: ToolPart, toolName: string) {
  if (part.state === 'output-error') {
    return <StateMessage tone="error" title="Tool failed">{part.errorText || 'The tool did not return a result.'}</StateMessage>;
  }

  if (part.state !== 'output-available') {
    return (
      <StateMessage title={part.state === 'input-streaming' ? 'Collecting input' : 'Working on it'}>
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        <span>{part.state === 'input-streaming' ? 'Houston is preparing the request…' : 'Waiting for the task result…'}</span>
      </StateMessage>
    );
  }

  switch (toolName) {
    case 'searchTasks': {
      const parsed = taskSearchResultSchema.safeParse(part.output);
      if (!parsed.success) return <InvalidResultState />;
      if (parsed.data.length === 0) return <EmptyState>No matching tasks found.</EmptyState>;
      return (
        <div className="space-y-2">
          {parsed.data.slice(0, 8).map(task => <TaskReferenceRow key={task.id} task={task} />)}
          {parsed.data.length > 8 ? <TruncatedLabel count={parsed.data.length - 8} /> : null}
        </div>
      );
    }
    case 'getTaskSummary': {
      const parsed = taskSummaryResultSchema.safeParse(part.output);
      if (!parsed.success) return <InvalidResultState />;
      const summary = parsed.data;
      const sources = Object.entries(summary.bySource).sort((a, b) => b[1] - a[1]);
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 [font-variant-numeric:tabular-nums] sm:grid-cols-4">
            <MetricChip label="Open" value={summary.open} />
            <MetricChip label="Overdue" value={summary.overdue} />
            <MetricChip label="Critical/high" value={summary.critical} />
            <MetricChip label="Done" value={summary.done} />
          </div>
          {sources.length > 0 ? (
            <div>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">By source</h4>
              <div className="flex flex-wrap gap-1.5">
                {sources.map(([source, count]) => (
                  <span key={source} className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-0)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                    {source} <span className="font-semibold text-[var(--text-primary)]">{count}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Overdue items</h4>
            {summary.overdueItems && summary.overdueItems.length > 0 ? (
              <div className="space-y-2">
                {summary.overdueItems.slice(0, 6).map(task => <TaskReferenceRow key={task.id} task={task} />)}
                {summary.overdueItems.length > 6 ? <TruncatedLabel count={summary.overdueItems.length - 6} /> : null}
              </div>
            ) : (
              <EmptyState>No overdue tasks in this result.</EmptyState>
            )}
          </div>
        </div>
      );
    }
    case 'suggestDayPlan': {
      const parsed = dayPlanResultSchema.safeParse(part.output);
      if (!parsed.success) return <InvalidResultState />;
      const plan = parsed.data;
      if (plan.suggestions.length === 0) return <EmptyState>No focus tasks were suggested.</EmptyState>;
      return (
        <div className="space-y-3">
          <p className="text-xs text-[var(--text-secondary)]">
            Based on {plan.totalOpen} open task{plan.totalOpen === 1 ? '' : 's'} and {plan.totalOverdue} overdue.
            {plan.availableMinutes ? ` Planned for ${plan.availableMinutes} minutes.` : ''}
          </p>
          <div className="space-y-2">
            {plan.suggestions.slice(0, 8).map((task, index) => <TaskReferenceRow key={task.id} task={task} index={index + 1} />)}
          </div>
        </div>
      );
    }
    case 'completeTask':
    case 'updateTaskPriority': {
      const parsed = taskMutationResultSchema.safeParse(part.output);
      if (!parsed.success) return <InvalidResultState />;
      if (!parsed.data.success) {
        return <StateMessage tone="error" title="Task was not updated">{parsed.data.error}</StateMessage>;
      }
      const result = parsed.data;
      return (
        <div className="space-y-2">
          <p className="text-xs text-[var(--text-secondary)]">
            {toolName === 'completeTask'
              ? `${result.title} was marked complete${result.completedAt ? ` at ${new Date(result.completedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`
              : `${result.title} is now ${result.newPriority || result.priority} priority.`}
          </p>
          <TaskReferenceRow task={{
            id: result.taskId,
            title: result.title,
            status: result.status,
            microStatus: result.microStatus,
            priority: result.priority,
            dueDate: result.dueDate,
            source: result.source,
            sourceList: result.sourceList,
          }} />
        </div>
      );
    }
    default:
      return null;
  }
}

function GenericToolCard({ part, toolName }: { part: ToolPart; toolName: string }) {
  const isError = part.state === 'output-error';
  return (
    <motion.div initial="hidden" animate="show" variants={scaleIn}>
      <details className="group rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3" open={part.state !== 'output-available'}>
        <summary className="flex list-none cursor-pointer items-start gap-3">
          <span className={`mt-0.5 ${isError ? 'text-rose-300' : 'text-[var(--text-secondary)]'}`}>
            {isError ? <TriangleAlert size={16} /> : <Wrench size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-[var(--text-primary)]">Tool: {toolName}</span>
              <ChevronDown className="h-4 w-4 text-[var(--text-muted)] transition-transform group-open:rotate-180" />
            </span>
            <span className="mt-1 block text-xs text-[var(--text-secondary)]">
              {isError ? `${toolName} failed` : part.state === 'output-available' ? `${toolName} completed` : `${toolName} is running`}
            </span>
          </span>
        </summary>
        <div className="mt-3 pl-7 text-xs text-[var(--text-secondary)]">
          {isError ? (
            <p className="text-rose-300">{part.errorText}</p>
          ) : part.state === 'output-available' ? (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] p-2 text-xs">{formatJson(part.output)}</pre>
          ) : (
            <div className="space-y-2">
              {part.input ? <pre className="whitespace-pre-wrap break-words rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] p-2 text-xs">{formatJson(part.input)}</pre> : null}
              <p>{part.input ? `Input: ${formatInlineInput(part.input)}` : 'Preparing tool input…'}</p>
            </div>
          )}
        </div>
      </details>
    </motion.div>
  );
}

function getNativePresentation(toolName: string) {
  switch (toolName) {
    case 'searchTasks':
      return { label: 'Task search', icon: <Search size={16} />, iconClass: 'text-blue-300' };
    case 'getTaskSummary':
      return { label: 'Task summary', icon: <ListTodo size={16} />, iconClass: 'text-violet-300' };
    case 'suggestDayPlan':
      return { label: 'Suggested focus', icon: <Sparkles size={16} />, iconClass: 'text-amber-300' };
    default:
      return { label: 'Task updated', icon: <CheckCircle2 size={16} />, iconClass: 'text-emerald-300' };
  }
}

function getNativeSubtitle(part: ToolPart, toolName: string) {
  if (part.state === 'output-error') return `${toolName} failed`;
  if (part.state !== 'output-available') return part.input ? formatInlineInput(part.input) : 'Preparing tool request';
  if (toolName === 'searchTasks') {
    const parsed = taskSearchResultSchema.safeParse(part.output);
    const query = typeof part.input === 'object' && part.input && 'query' in part.input
      ? String((part.input as Record<string, unknown>).query || '')
      : '';
    return parsed.success
      ? `${parsed.data.length} task${parsed.data.length === 1 ? '' : 's'}${query ? ` matching "${query}"` : ''}`
      : 'Result unavailable';
  }
  if (toolName === 'getTaskSummary') {
    const parsed = taskSummaryResultSchema.safeParse(part.output);
    return parsed.success ? `${parsed.data.open} open, ${parsed.data.overdue} overdue` : 'Result unavailable';
  }
  if (toolName === 'suggestDayPlan') {
    const parsed = dayPlanResultSchema.safeParse(part.output);
    return parsed.success ? `${parsed.data.suggestions.length}-item plan` : 'Result unavailable';
  }
  const parsed = taskMutationResultSchema.safeParse(part.output);
  if (!parsed.success) return 'Result unavailable';
  if (!parsed.data.success) return 'Update failed';
  return toolName === 'completeTask' ? 'Completion saved' : 'Priority saved';
}

function StateMessage({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-md border p-2.5 text-xs ${tone === 'error' ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-[var(--border-subtle)] bg-[var(--surface-0)] text-[var(--text-secondary)]'}`}>
      <span className="font-medium">{title}:</span>
      {children}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--surface-0)] p-3 text-center text-xs text-[var(--text-muted)]">{children}</p>;
}

function InvalidResultState() {
  return <StateMessage tone="error" title="Result unavailable">Houston received an unexpected tool result.</StateMessage>;
}

function TruncatedLabel({ count }: { count: number }) {
  return <p className="pt-1 text-center text-[11px] text-[var(--text-muted)]">{count} more result{count === 1 ? '' : 's'} not shown</p>;
}
