'use client';

import Image from 'next/image';
import { ArrowLeftRight, Bell, ChartNetwork, Clock, Globe, Repeat, RotateCcw, Timer } from 'lucide-react';
import { IconRenderer } from '@/components/ui/icon-picker';
import { Tooltip } from '@/components/ui/Tooltip';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import { SubtaskPill } from '@/components/ui/SubtaskPill';
import { SmartScoreBadge } from '@/components/smart-score/SmartScoreBadge';
import { MICRO_STATUS_CONFIG } from '@/types';
import type { MicroStatus } from '@/types';
import type { LocalDisposition } from '@/types';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import type {
  DashboardProjectViewModel as HubProject,
  DashboardTaskViewModel as Task,
} from '@/types/dashboard';
import { CONNECTOR_ICONS, PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS, STATUS_LABELS } from '@/types/dashboard';
import { EFFORT_BADGE_COLORS, EFFORT_MEASURE_LABELS, DEFAULT_EFFORT_MEASURE, isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { TaskRowActions } from '@/components/task-row/TaskRowActions';
import { TaskBlockedBadge, TaskStatusIndicator, isTaskBlocked } from '@/components/task-list/TaskStatusIndicator';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';
import {
  isReminderRelativeRule,
  REMINDER_RELATIVE_RULES,
} from '@/lib/tasks/relative-reminder';

const EFFORT_LABELS = EFFORT_MEASURE_LABELS[DEFAULT_EFFORT_MEASURE];

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

function ProjectBadge({ projectIds, projects, projectFilter, setProjectFilter }: {
  projectIds: string[];
  projects: HubProject[];
  projectFilter: string | null;
  setProjectFilter: (v: string | null) => void;
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
              setProjectFilter(projectFilter === project.id ? null : project.id);
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

interface TaskRowProps {
  task: Task;
  projects?: HubProject[];
  onComplete: () => void;
  onSnoozeUntil: (until: string | null) => void | Promise<void>;
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
}

export function TaskRow({
  task,
  projects = [],
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
}: TaskRowProps) {
  const { tagFilter, setTagFilter, priorityFilter, setPriorityFilter, statusFilter, setStatusFilter, projectFilter, setProjectFilter, groupBy } = useDashboardViewStore();
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
      className={`@container px-4 ${compact ? 'py-1.5' : 'py-3'} flex items-center gap-3 hover:bg-[var(--surface-0)] transition-[background-color,opacity] duration-300 group ${isInactive ? 'opacity-50' : ''} ${isCompleting ? 'bg-green-900/10' : ''} ${showDivider ? 'border-b border-[var(--border-subtle)]' : ''} ${bulkSelected ? 'bg-blue-900/20' : ''} ${isSelected ? 'ring-1 ring-inset ring-[var(--accent-400)] bg-[var(--accent-500)]/8 rounded-sm' : ''}`}
    >
      {bulkMode ? (
        <input
          type="checkbox"
          checked={bulkSelected}
          onChange={onBulkToggle}
          className="w-4 h-4 rounded border-[var(--border-strong)] accent-[var(--accent-500)] flex-shrink-0 cursor-pointer"
        />
      ) : (
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
      )}

      <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center" title={task.connectorType}>
        {CONNECTOR_ICONS[task.connectorType]
          ? <Image src={CONNECTOR_ICONS[task.connectorType]} alt={task.connectorType} width={14} height={14} />
          : <Globe size={14} className="text-[var(--text-muted)]" />
        }
      </span>

      {(task.linkedSourceCount ?? 0) > 0 && (
        <Tooltip content="Also tracked in another source">
          <span className="flex-shrink-0 flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium bg-cyan-900/20 text-cyan-400 border border-cyan-800/30">
            <ArrowLeftRight size={9} />
            <span className="hidden @lg:inline">linked</span>
          </span>
        </Tooltip>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium truncate ${isDone ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
            {task.title}
          </span>
          {(() => {
            const displayId = getTaskDisplayId(task.connectorType, task.metadata, task.sourceId);
            return displayId ? (
              <span className="text-xs text-[var(--text-muted)] flex-shrink-0 font-mono tabular-nums">{displayId}</span>
            ) : null;
          })()}
          {task.microStatus && isTaskBlocked(task.status, task.microStatus) ? (
            <TaskBlockedBadge status={task.status} microStatus={task.microStatus} className="hidden @md:inline-flex" />
          ) : task.microStatus && MICRO_STATUS_CONFIG[task.microStatus as MicroStatus] && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 whitespace-nowrap hidden @md:inline`}
              style={{
                backgroundColor: `${MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].color}20`,
                color: MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].color,
              }}
              title={MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].description}
            >
              {MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].emoji} {MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].label}
            </span>
          )}
          <SubtaskPill
            done={task.subtaskDone ?? 0}
            total={task.subtaskTotal ?? 0}
            onClick={onOpenSubtasks}
          />
        </div>
        {!compact && (
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {task.sourceListName && !hideSourceListName && (
              <span className="text-xs text-[var(--text-muted)]">{task.sourceListName}</span>
            )}
            {task.tags?.filter(tag => !isSyntheticTag(tag.name)).map((tag) => (
              <button
                key={tag.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setTagFilter(
                    tagFilter.includes(tag.slug)
                      ? tagFilter.filter((t) => t !== tag.slug)
                      : [...tagFilter, tag.slug]
                  );
                }}
                className={`rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-xs font-medium text-[var(--text-secondary)] transition-colors cursor-pointer hover:opacity-80 ${
                  tagFilter.includes(tag.slug) ? 'ring-2 ring-[var(--accent)] border border-[var(--accent)]' : ''
                }`}
                style={tag.color ? {
                  backgroundColor: `${tag.color}30`,
                  color: `color-mix(in oklch, ${tag.color} 60%, white)`,
                } : undefined}
                title={`Filter by "${tag.name}"`}
              >
                {tag.name}
              </button>
            ))}
            {task.hubProjectIds && task.hubProjectIds.length > 0 && (
              <ProjectBadge
                projectIds={task.hubProjectIds}
                projects={projects}
                projectFilter={projectFilter}
                setProjectFilter={setProjectFilter}
              />
            )}
          </div>
        )}
      </div>

      {task.priority !== 'none' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPriorityFilter(
              priorityFilter.includes(task.priority)
                ? priorityFilter.filter((p) => p !== task.priority)
                : [...priorityFilter, task.priority]
            );
          }}
          className={`text-xs px-1.5 py-0.5 rounded border font-semibold cursor-pointer transition-opacity hover:opacity-80 flex-shrink-0 ${PRIORITY_COLORS[task.priority]} ${
            priorityFilter.includes(task.priority) ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]' : ''
          }`}
          title={`Filter by ${task.priority} priority`}
        >
          {PRIORITY_LABELS[task.priority]}
        </button>
      )}

      {groupBy !== 'status' && STATUS_LABELS[task.status] && task.status !== 'todo' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setStatusFilter(
              statusFilter.includes(task.status)
                ? statusFilter.filter((s) => s !== task.status)
                : [...statusFilter, task.status]
            );
          }}
          className={`text-xs px-1.5 py-0.5 rounded border font-medium cursor-pointer transition-opacity hover:opacity-80 flex-shrink-0 ${ATTR_P2} ${STATUS_COLORS[task.status] || ''} ${
            statusFilter.includes(task.status) ? 'ring-2 ring-[var(--accent)] border-[var(--accent)]' : ''
          }`}
          title={`Filter by ${STATUS_LABELS[task.status]}`}
        >
          {STATUS_LABELS[task.status]}
        </button>
      )}

      {task.effort != null && task.effort >= 1 && task.effort <= 5 && (
        <span className={`text-xs px-1.5 py-0.5 rounded border font-semibold flex-shrink-0 ${ATTR_P2} ${EFFORT_BADGE_COLORS[task.effort]}`}
              title={`Effort: ${EFFORT_LABELS[task.effort]}`}>
          {EFFORT_LABELS[task.effort]}
        </span>
      )}

      {recurrence && (
        <span className={`text-xs flex-shrink-0 ${ATTR_P1} items-center gap-0.5 text-blue-400`} title={`Repeats: ${recurrence}`}>
          <Repeat size={10} />
        </span>
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
        <span className={`text-xs flex-shrink-0 ${ATTR_P2} items-center gap-1 px-1.5 py-0.5 rounded bg-amber-900/20 text-amber-400 border border-amber-800/30`}>
          <Clock size={10} />
          <span className="hidden @lg:inline">snoozed until {formatSnoozeUntil(task.snoozedUntil!)}</span>
        </span>
      )}

      {hasReminder && (
        <span className={`text-xs flex-shrink-0 ${ATTR_P2} items-center gap-1 px-1.5 py-0.5 rounded bg-purple-900/20 text-purple-400 border border-purple-800/30`}
              title={`Reminder: ${reminderLabel}`}>
          <Bell size={10} />
          <span className="hidden @lg:inline">{reminderLabel}</span>
        </span>
      )}

      {task.estimatedDuration && (
        <span
          className={`text-xs flex-shrink-0 ${ATTR_P1} items-center gap-0.5 px-1.5 py-0.5 rounded border border-blue-800/30 bg-blue-900/20 text-blue-400 tabular-nums`}
          title={`Estimated: ${task.estimatedDuration}min`}
        >
          <Timer size={10} />
          <span className="hidden @lg:inline">
            {task.estimatedDuration >= 60 ? `${Math.floor(task.estimatedDuration / 60)}h${task.estimatedDuration % 60 ? ` ${task.estimatedDuration % 60}m` : ''}` : `${task.estimatedDuration}m`}
          </span>
        </span>
      )}

      {task.smartScore != null && (
        <span className="hidden shrink-0 @min-[640px]:block">
          <SmartScoreBadge score={task.smartScore} breakdown={task.scoreBreakdown ?? undefined} size="sm" />
        </span>
      )}

      <TaskRowActions
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
        onSetLocalDisposition={onSetLocalDisposition}
        onSnoozeUntil={onSnoozeUntil}
        onToggleMyDay={isInMyDay ? onRemoveFromMyDay : onAddToMyDay}
        onOpenNotes={onOpenNotes}
      />
    </div>
  );
}
