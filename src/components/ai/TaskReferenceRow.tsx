'use client';

import Link from 'next/link';
import { CalendarDays, Check, Circle, ExternalLink } from 'lucide-react';
import { formatToolDate } from '@/lib/ai/chatFormatters';
import type { TaskReference } from '@/lib/ai/toolResultSchemas';

const PRIORITY_STYLES: Record<NonNullable<TaskReference['priority']>, string> = {
  critical: 'border-red-500/30 bg-red-500/10 text-red-300',
  high: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  medium: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  low: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  none: 'border-[var(--border-subtle)] bg-[var(--surface-2)] text-[var(--text-muted)]',
};

export function TaskReferenceRow({
  task,
  index,
}: {
  task: TaskReference;
  index?: number;
}) {
  const href = `/?taskId=${encodeURIComponent(task.id)}`;
  const done = task.status === 'done';

  return (
    <Link
      href={href}
      scroll={false}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const selectEvent = new CustomEvent('mc:select-task', {
          cancelable: true,
          detail: { taskId: task.id },
        });
        if (!window.dispatchEvent(selectEvent)) event.preventDefault();
      }}
      className="group flex min-h-11 items-start gap-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-0)] p-2.5 text-left transition-colors hover:border-[var(--accent-400)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
      aria-label={`Open task: ${task.title}`}
    >
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${done ? 'border-emerald-400 bg-emerald-400 text-white' : 'border-[var(--border-strong)] text-[var(--text-muted)]'}`}>
        {done ? <Check size={12} /> : index ? <span className="text-[10px] font-semibold">{index}</span> : <Circle size={9} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm font-medium ${done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'}`}>
          {task.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-muted)]">
          {task.sourceList || task.source ? <span>{task.sourceList || task.source}</span> : null}
          {task.dueDate ? (
            <span className="inline-flex items-center gap-1">
              <CalendarDays size={11} />
              {formatToolDate(task.dueDate)}
            </span>
          ) : null}
          {task.reason ? <span className="capitalize">{task.reason}</span> : null}
        </span>
      </span>
      {task.priority ? (
        <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize ${PRIORITY_STYLES[task.priority]}`}>
          {task.priority}
        </span>
      ) : null}
      <ExternalLink size={13} className="mt-1 shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--accent-300)]" aria-hidden="true" />
    </Link>
  );
}
