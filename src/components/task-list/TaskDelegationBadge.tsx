import { Bot } from 'lucide-react';
import type { TaskDelegationSummary } from '@/lib/external-agents/task-delegation';
import { cn } from '@/lib/utils';

const STATE_CLASSES: Record<TaskDelegationSummary['displayState'], string> = {
  preview: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  queued: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
  running: 'border-blue-500/25 bg-blue-500/10 text-blue-300',
  idle: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
  waiting_for_user: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  blocked: 'border-orange-500/25 bg-orange-500/10 text-orange-300',
  failed: 'border-red-500/25 bg-red-500/10 text-red-300',
  timed_out: 'border-red-500/25 bg-red-500/10 text-red-300',
  cancelled: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
  completed: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
};

export function TaskDelegationBadge({ delegation }: { delegation: TaskDelegationSummary }) {
  const stateLabel = delegation.pullRequestState === 'merged'
    ? 'Merged'
    : delegation.pullRequestState === 'closed'
      ? 'Closed'
      : delegation.pullRequestState === 'draft'
        ? 'Draft'
        : delegation.pullRequestState === 'open' || delegation.pullRequestUrl
          ? 'Review'
    : delegation.displayState === 'waiting_for_user'
      ? 'Waiting'
      : delegation.displayState === 'preview'
        ? 'Review'
        : delegation.displayState.replaceAll('_', ' ');
  const destinationLabel = delegation.pullRequestState === 'merged'
    || delegation.pullRequestState === 'closed'
    || delegation.pullRequestState === 'draft'
      ? 'PR'
    : delegation.pullRequestState === 'open' || delegation.pullRequestUrl
      ? 'PR ready'
    : delegation.targetType === 'copilot-cloud'
      ? 'GitHub Copilot Cloud'
      : delegation.targetType === 'paperclip'
        ? 'Paperclip'
        : delegation.targetName;
  const label = `${stateLabel} · ${destinationLabel}`;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1 py-0.5 text-xs font-medium',
        STATE_CLASSES[delegation.displayState],
      )}
      title={`${delegation.targetName}: ${label}`}
      aria-label={`Delegation ${label}`}
    >
      <Bot size={9} aria-hidden="true" />
      <span className="capitalize">{label}</span>
    </span>
  );
}
