'use client';

import { motion } from 'motion/react';
import {
  CheckCircle2,
  ChevronDown,
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
const NATIVE_WIDGET_RESOURCE_BY_TOOL = {
  searchTriage: TRIAGE_SUMMARY_RESOURCE_URI,
} as const;

export function ToolCard({ part }: { part: ToolPart }) {
  const toolName = getToolName(part);

  if (Object.hasOwn(NATIVE_WIDGET_RESOURCE_BY_TOOL, toolName)) {
    return <TriageToolCard part={part} />;
  }

  if (NATIVE_TASK_TOOLS.has(toolName)) {
    return <NativeTaskToolCard part={part} toolName={toolName} />;
  }

  return <GenericToolCard part={part} toolName={toolName} />;
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
