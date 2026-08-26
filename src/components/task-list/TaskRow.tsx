'use client';

import type { ReactNode } from 'react';
import { ArrowLeftRight, Bell, ChartNetwork, Clock, Repeat, RotateCcw, Timer } from 'lucide-react';
import { IconRenderer } from '@/components/ui/icon-picker';
import { Tooltip } from '@/components/ui/Tooltip';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import type { LocalDisposition } from '@/types';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import type {
  DashboardProjectViewModel as HubProject,
  DashboardTaskViewModel as Task,
} from '@/types/dashboard';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { TaskRowActions } from '@/components/task-row/TaskRowActions';
import { TaskStatusIndicator } from '@/components/task-list/TaskStatusIndicator';
import { TaskRowIdentity } from '@/components/task-list/TaskRowIdentity';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';
import {
  isReminderRelativeRule,
  REMINDER_RELATIVE_RULES,
} from '@/lib/tasks/relative-reminder';
import { createTaskRowInteractionHandlers } from '@/lib/tasks/task-row-interactions';
import { cn } from '@/lib/utils';

/**
 * Responsive visibility priority for task row attribute badges.
 * Uses container queries so badges progressively hide as the list narrows.
 *
 * Priority tiers (hidden first → last):
 *   attr-p1 — lowest priority, hidden below 960px
 *   attr-p2 — hidden below 720px
 */
const ATTR_P1 = 'hidden @min-[960px]:flex'; // recurrence, estimated duration
const ATTR_P2 = 'hidden @min-[720px]:flex'; // effort, status, snoozed, reminder

function ProjectBadge({ projectIds, projects, projectFilter, onToggleProject }: {
  projectIds: string[];
  projects: HubProject[];
  projectFilter: string | null;
  onToggleProject: (projectId: string) => void;
}) {
  if (!projectIds.length) return null;
  const matched = projects.filter((p) => projectIds.includes(p.id));
  if (!matched.length) return null;

  const tooltipLabel = matched.length > 1 ? 'Projects:' : 'Project:';
  const tooltipContent = (
    <span className="inline-flex items-center gap-1">
      <ChartNetwork size={12} />
      {tooltipLabel} {matched.map((p) => p.name).join(', ')}
    </span>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span className="inline-flex items-center gap-1">
        {matched.map((project) => (
          <button
            key={project.id}
            onClick={(e) => {
              e.stopPropagation();
              onToggleProject(project.id);
            }}
            className={`text-xs inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-indigo-800/30 bg-indigo-900/20 text-indigo-400 flex-shrink-0 cursor-pointer transition-opacity hover:opacity-80 ${
              projectFilter === project.id ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]' : ''
            }`}
            aria-label={`Filter by project: ${project.name}`}
          >
            {project.icon ? (
              <IconRenderer value={project.icon} size={12} color={project.color} />
            ) : (
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: project.color }}
              />
            )}
            <span className="max-w-[6rem] truncate">{project.name}</span>
          </button>
        ))}
      </span>
    </Tooltip>
  );
}

function formatSnoozeUntil(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);

  if (date >= tomorrow && date < dayAfter) return 'tomorrow';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatReminderAt(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  if (date >= todayStart && date < tomorrow) return `today ${timeStr}`;
  if (date >= tomorrow && date < dayAfter) return `tomorrow ${timeStr}`;
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ` ${timeStr}`;
}

export interface TaskRowFilterController {
  tagSlugs: string[];
  projectId: string | null;
  onToggleTag: (slug: string) => void;
  onToggleProject?: (projectId: string) => void;
  onFilterPriority: (priority: string) => void;
  onFilterStatus: (status: string) => void;
}

interface TaskRowProps {
  task: Task;
  projects?: HubProject[];
  leading?: ReactNode;
  surface?: 'dashboard' | 'plan';
  variant?: 'list' | 'card' | 'compact';
  className?: string;
  onComplete: () => void;
  onSnoozeUntil?: (until: string | null) => void | Promise<void>;
  onSetDueDate: (date: string | null) => void | Promise<void>;
  onSetPriority: (priority: string) => void | Promise<void>;
  onSetStatus: (status: string) => void | Promise<void>;
  onSetLocalDisposition: (disposition: LocalDisposition) => void | Promise<void>;
  onOpenNotes: (mode: 'read' | 'edit') => void;
  onOpenSubtasks?: () => void;
  onAddToMyDay: () => void;
  onRemoveFromMyDay: () => void;
  isInMyDay?: boolean;
  hideSourceListName?: boolean;
  showDivider?: boolean;
  compact?: boolean;
  bulkMode?: boolean;
  bulkSelected?: boolean;
  onBulkToggle?: () => void;
  isCompleting?: boolean;
  isSelected?: boolean;
  secondaryMetadata?: ReactNode;
  onSelect?: (taskId: string) => void;
  onDoubleClickTask?: (taskId: string) => void;
  onModifierClick?: (
    taskId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void;
  filterController?: false | TaskRowFilterController;
}

export function TaskRow({
  task,
  projects = [],
  leading,
  surface = 'dashboard',
  variant = 'list',
  className,
  onComplete,
  onSnoozeUntil,
  onSetDueDate,
  onSetPriority,
  onSetStatus,
  onSetLocalDisposition,
  onOpenNotes,
  onOpenSubtasks,
  onAddToMyDay,
  onRemoveFromMyDay,
  isInMyDay = false,
  hideSourceListName = false,
  showDivider,
  compact = false,
  bulkMode = false,
  bulkSelected = false,
  onBulkToggle,
  isCompleting = false,
  isSelected = false,
  secondaryMetadata,
  onSelect,
  onDoubleClickTask,
  onModifierClick,
  filterController,
}: TaskRowProps) {
  const {
    tagFilter,
    setTagFilter,
    setPriorityFilter,
    setStatusFilter,
    projectFilter,
    setProjectFilter,
  } = useDashboardViewStore();
  const rowFilters = filterController === false ? null : filterController ?? {
    tagSlugs: tagFilter,
    projectId: projectFilter,
    onToggleTag: (slug: string) => {
      setTagFilter(
        tagFilter.includes(slug)
          ? tagFilter.filter((tag) => tag !== slug)
          : [...tagFilter, slug],
      );
    },
    onToggleProject: (nextProjectId: string) => {
      setProjectFilter(projectFilter === nextProjectId ? null : nextProjectId);
    },
    onFilterPriority: (priority: string) => setPriorityFilter([priority]),
    onFilterStatus: (status: string) => setStatusFilter([status]),
  };
  const isDone = task.status === 'done' || isCompleting;
  const isInactive = isInactiveTaskStatus(task.status) || isCompleting;
  const taskMeta = task.metadata ? (() => { try { return JSON.parse(task.metadata); } catch { return null; } })() : null;
  const recurrence = taskMeta?.recurrence;
  const isSnoozed = task.snoozedUntil && new Date(task.snoozedUntil) > new Date();
  const hasFutureReminder = Boolean(task.reminderAt && new Date(task.reminderAt) > new Date());
  const relativeReminder = task.reminderRelative
    && isReminderRelativeRule(task.reminderRelative)
    ? task.reminderRelative
    : null;
  const hasReminder = hasFutureReminder || Boolean(relativeReminder);
  const reminderLabel = hasFutureReminder && task.reminderAt
    ? relativeReminder
      ? `${REMINDER_RELATIVE_RULES[relativeReminder].label} (${formatReminderAt(task.reminderAt)})`
      : formatReminderAt(task.reminderAt)
    : relativeReminder
      ? `${REMINDER_RELATIVE_RULES[relativeReminder].label} needs attention`
      : '';
  const canComplete = canEditTaskField(task.editPolicy, 'status');
  const completionBlockedReason = taskFieldBlockedReason(task.editPolicy, 'status');

  return (
    <div
      data-task-row-surface={surface}
      data-task-row-variant={variant}
      data-task-id={task.id}
      className={cn(
        '@container group flex items-center gap-3 px-4 transition-[background-color,opacity] duration-300 hover:bg-[var(--surface-0)]',
        compact ? 'py-1.5' : 'py-3',
        isInactive && 'opacity-50',
        isCompleting && 'bg-green-900/10',
        showDivider && 'border-b border-[var(--border-subtle)]',
        bulkSelected && 'bg-blue-900/20',
        isSelected && 'rounded-sm bg-[var(--accent-500)]/8 ring-1 ring-inset ring-[var(--accent-400)]',
        (onSelect || onDoubleClickTask) && 'cursor-pointer',
        className,
      )}
      {...(
        onSelect || onDoubleClickTask || (bulkMode && onBulkToggle)
          ? createTaskRowInteractionHandlers({
              taskId: task.id,
              bulkMode,
              onSelect: onSelect ?? (() => {}),
              onDoubleClick: onDoubleClickTask,
              onModifierClick,
              onBulkClick: onBulkToggle,
            })
          : {}
      )}
    >
      {bulkMode ? (
        <input
          type="checkbox"
          checked={bulkSelected}
          onChange={onBulkToggle}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${task.title}`}
          className="w-4 h-4 rounded border-[var(--border-strong)] accent-[var(--accent-500)] flex-shrink-0 cursor-pointer"
        />
      ) : (
        <>
          {leading}
          <CompletionBurst celebrating={isCompleting}>
            <Tooltip content={canComplete ? 'Mark complete' : completionBlockedReason}
            >
              <button
                onClick={(e) => { e.stopPropagation(); onComplete(); }}
                disabled={isCompleting || !canComplete}
                aria-label={canComplete ? (isDone ? 'Completed' : 'Mark task complete') : completionBlockedReason}
                className="group/status flex h-5 w-5 shrink-0 items-center justify-center"
              >
                <TaskStatusIndicator
                  status={task.status}
                  microStatus={task.microStatus}
                  isCompleting={isCompleting}
                />
              </button>
            </Tooltip>
          </CompletionBurst>
        </>
      )}

      <TaskRowIdentity
        task={task}
        isDone={isDone}
        onOpenSubtasks={onOpenSubtasks}
        afterConnector={(task.linkedSourceCount ?? 0) > 0 ? (
          <Tooltip content="Also tracked in another source">
            <span className="flex shrink-0 items-center gap-0.5 rounded border border-cyan-800/30 bg-cyan-900/20 px-1 py-0.5 text-[10px] font-medium text-cyan-400">
              <ArrowLeftRight size={9} />
              <span className="hidden @lg:inline">linked</span>
            </span>
          </Tooltip>
        ) : null}
        secondary={!compact ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden">
            {secondaryMetadata}
            {task.sourceListName && !hideSourceListName && (
              <span className="max-w-[120px] min-w-0 truncate text-xs text-[var(--text-muted)]">{task.sourceListName}</span>
            )}
            {task.tags?.filter(tag => !isSyntheticTag(tag.name)).map((tag) => {
              const tagClassName = cn(
                'rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-secondary)]',
                rowFilters && 'cursor-pointer transition-colors hover:opacity-80',
                rowFilters?.tagSlugs.includes(tag.slug) && 'border border-[var(--accent)] ring-2 ring-[var(--accent)]',
              );
              const tagStyle = tag.color ? {
                backgroundColor: `${tag.color}30`,
                color: `color-mix(in oklch, ${tag.color} 60%, white)`,
              } : undefined;

              return rowFilters ? (
                <button
                  key={tag.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    rowFilters.onToggleTag(tag.slug);
                  }}
                  className={tagClassName}
                  style={tagStyle}
                  title={`Filter by "${tag.name}"`}
                >
                  {tag.name}
                </button>
              ) : (
                <span key={tag.id} className={tagClassName} style={tagStyle}>
                  {tag.name}
                </span>
              );
            })}
            {rowFilters && task.hubProjectIds && task.hubProjectIds.length > 0 && (
              <ProjectBadge
                projectIds={task.hubProjectIds}
                projects={projects}
                projectFilter={rowFilters.projectId}
                onToggleProject={(projectId) => rowFilters.onToggleProject?.(projectId)}
              />
            )}
            {recurrence && (
              <Tooltip content={`Repeats: ${recurrence}`}>
                <span className={`text-xs flex-shrink-0 ${ATTR_P1} items-center text-blue-400`}>
                  <Repeat size={10} />
                </span>
              </Tooltip>
            )}
            {(task.pushCount ?? 0) >= 2 && (
              <span
                className={`text-xs flex-shrink-0 ${ATTR_P2} items-center gap-0.5 rounded border border-amber-800/30 bg-amber-900/20 px-1.5 py-0.5 text-amber-400`}
                title={`Rescheduled ${task.pushCount ?? 0} times`}
              >
                <RotateCcw size={10} aria-hidden="true" /> {task.pushCount ?? 0}
              </span>
            )}
            {isSnoozed && (
              <span className={`text-xs flex-shrink-0 ${ATTR_P2} items-center gap-1 rounded border border-amber-800/30 bg-amber-900/20 px-1.5 py-0.5 text-amber-400`}>
                <Clock size={10} />
                <span className="hidden @lg:inline">snoozed until {formatSnoozeUntil(task.snoozedUntil!)}</span>
              </span>
            )}
            {hasReminder && (
              <span
                className={`text-xs flex-shrink-0 ${ATTR_P2} items-center gap-1 rounded border border-purple-800/30 bg-purple-900/20 px-1.5 py-0.5 text-purple-400`}
                title={`Reminder: ${reminderLabel}`}
              >
                <Bell size={10} />
                <span className="hidden @lg:inline">{reminderLabel}</span>
              </span>
            )}
            {task.estimatedDuration && (
              <span
                className={`text-xs flex-shrink-0 ${ATTR_P1} items-center gap-0.5 rounded border border-blue-800/30 bg-blue-900/20 px-1.5 py-0.5 text-blue-400 tabular-nums`}
                title={`Estimated: ${task.estimatedDuration}min`}
              >
                <Timer size={10} />
                <span className="hidden @lg:inline">
                  {task.estimatedDuration >= 60 ? `${Math.floor(task.estimatedDuration / 60)}h${task.estimatedDuration % 60 ? ` ${task.estimatedDuration % 60}m` : ''}` : `${task.estimatedDuration}m`}
                </span>
              </span>
            )}
          </div>
        ) : null}
      />

      <TaskRowActions
        smartScore={task.smartScore}
        scoreBreakdown={task.scoreBreakdown ?? undefined}
        planningHorizon={task.planningHorizon}
        effort={task.effort}
        dueDate={task.dueDate}
        hasDescription={task.hasDescription}
        isInMyDay={isInMyDay}
        priority={task.priority}
        status={task.status}
        localDisposition={task.localDisposition}
        editPolicy={task.editPolicy}
        surface="dashboard"
        snoozedUntil={task.snoozedUntil}
        onSetDueDate={onSetDueDate}
        onSetPriority={onSetPriority}
        onSetStatus={onSetStatus}
        onFilterPriority={rowFilters?.onFilterPriority}
        onFilterStatus={rowFilters?.onFilterStatus}
        onSetLocalDisposition={onSetLocalDisposition}
        onSnoozeUntil={onSnoozeUntil}
        showMoreActions
        onToggleMyDay={isInMyDay ? onRemoveFromMyDay : onAddToMyDay}
        onOpenNotes={onOpenNotes}
      />
    </div>
  );
}
