'use client';

import Link from 'next/link';
import { CalendarDays, ExternalLink } from 'lucide-react';
import { formatToolDate } from '@/lib/ai/chatFormatters';
import type { TaskReference } from '@/lib/ai/toolResultSchemas';
import { getTaskPriorityVisual } from '@/lib/constants/task-formatting';
import { TaskStatusIndicator } from '@/components/task-list/TaskStatusIndicator';

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
      <TaskStatusIndicator
        status={task.status ?? 'todo'}
        microStatus={task.microStatus}
        idleContent={index ? <span className="text-[10px] font-semibold">{index}</span> : null}
        className="mt-0.5"
      />
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
        <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize ${getTaskPriorityVisual(task.priority).badgeClass}`}>
          {task.priority}
        </span>
      ) : null}
      <ExternalLink size={13} className="mt-1 shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--accent-300)]" aria-hidden="true" />
    </Link>
  );
}
