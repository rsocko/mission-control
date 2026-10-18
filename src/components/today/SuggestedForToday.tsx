'use client';

import { useId } from 'react';
import { CalendarX2, Plus, Sparkles } from 'lucide-react';
import { ConnectorIcon } from './SortableTaskRow';
import { TaskBlockedBadge, TaskStatusIndicator } from '@/components/task-list/TaskStatusIndicator';
import { Tooltip } from '@/components/ui/Tooltip';
import { formatDueDate } from '@/lib/utils/date-format';
import { getLocalToday } from '@/lib/utils/client-date';
import { cn } from '@/lib/utils';
import type { SuggestionTask } from './types';

const DISPLAY_LIMIT = 3;

function suggestionReason(task: SuggestionTask): string {
  const today = getLocalToday();
  if (task.dueDate && task.dueDate < today) return `Overdue · ${formatDueDate(task.dueDate)}`;
  if (task.dueDate === today) return 'Due today';
  if (task.priority === 'critical') return 'Critical priority';
  if (task.priority === 'high') return 'High priority';
  if ((task.pushCount ?? 0) >= 2) return `Rescheduled ${task.pushCount} times`;
  if (task.planningHorizon === 'next') return 'Planned for next';
  if (task.dueDate) return `Due ${formatDueDate(task.dueDate)}`;
  return 'Strong fit for today';
}

export function SuggestedForToday({
  tasks,
  onAdd,
  onNotToday,
  onSelect,
  className,
}: {
  tasks: SuggestionTask[];
  onAdd: (taskId: string) => void;
  onNotToday?: (taskId: string) => void;
  onSelect: (taskId: string) => void;
  className?: string;
}) {
  const headingId = useId();
  const visibleTasks = tasks.slice(0, DISPLAY_LIMIT);
  if (visibleTasks.length === 0) return null;

  return (
    <section
      className={cn(
        'overflow-hidden rounded-[var(--radius-lg)] border border-purple-800/40 bg-purple-950/20',
        className,
      )}
      aria-labelledby={headingId}
    >
      <div className="border-b border-purple-800/25 px-3 py-2.5">
        <h4
          id={headingId}
          className="flex items-center gap-1.5 text-xs font-semibold text-purple-300"
        >
          <Sparkles size={12} aria-hidden="true" />
          Suggested for Today
        </h4>
        <p className="mt-1 text-xs leading-relaxed text-purple-200/70">
          Best current fits based on due date, priority, and planning signals.
        </p>
      </div>
      <div className="divide-y divide-purple-800/20">
        {visibleTasks.map((task) => (
          <div key={task.id} className="flex min-h-12 items-center gap-2 px-2">
            <button
              type="button"
              onClick={() => onSelect(task.id)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-purple-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              <TaskStatusIndicator status={task.status} microStatus={task.microStatus} size="sm" />
              <ConnectorIcon type={task.connectorType} size={12} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                  {task.title}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-purple-200/70">
                  {suggestionReason(task)}
                  <TaskBlockedBadge status={task.status} microStatus={task.microStatus} />
                </span>
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-1">
              {onNotToday && (
                <Tooltip content="Not today">
                  <button
                    type="button"
                    onClick={() => onNotToday(task.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-purple-200/70 transition-colors hover:bg-purple-400/10 hover:text-purple-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                    aria-label={`Hide "${task.title}" from today's suggestions`}
                  >
                    <CalendarX2 size={13} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
              <Tooltip content="Add to My Day">
                <button
                  type="button"
                  onClick={() => onAdd(task.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-purple-700/40 text-purple-300 transition-colors hover:border-purple-500/60 hover:bg-purple-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                  aria-label={`Add "${task.title}" to My Day`}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
