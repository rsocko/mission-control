'use client';

import React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { motion } from 'motion/react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { differenceInCalendarDays } from 'date-fns';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CircleHelp,
  Clock3,
  FilePlus2,
  Lightbulb,
  Minus,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { SubtaskPill } from '@/components/ui/SubtaskPill';
import { EffortBadge } from '@/components/EffortBadge';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { getTaskStatusVisual } from '@/lib/constants/task-formatting';
import type { ProjectPulseState, ProjectStatus, TaskPriority, TaskStatus } from '@/types';
import { getPriorityDotColor } from './utils';
import { GANTT_HEADER_HEIGHT, GANTT_ROW_HEIGHT, PHASE_STATUS_LABELS, STATUS_LABELS, TASK_STATUS_LABELS } from './constants';
import type {
  GanttPhaseRow,
  HealthSummary,
  ProgressSummary,
  ProjectTaskViewModel as ProjectTask,
} from './types';

// ─── DependencyArrows (Gantt) ───────────────────────────────────────

export function DependencyArrows({
  ganttRows,
  timelineRange,
  cellWidth,
}: {
  ganttRows: GanttPhaseRow[];
  timelineRange: { start: Date; end: Date };
  cellWidth: number;
}) {
  const arrows: Array<{ fromX: number; fromY: number; toX: number; toY: number; color: string }> = [];
  const phaseRowIndex = new Map(ganttRows.map((row, index) => [row.phase.id, index]));

  for (const row of ganttRows) {
    if (!row.phase.startAfterPhaseId) continue;
    const sourceIndex = phaseRowIndex.get(row.phase.startAfterPhaseId);
    if (sourceIndex === undefined) continue;

    const sourceRow = ganttRows[sourceIndex];
    const targetIndex = phaseRowIndex.get(row.phase.id);
    if (targetIndex === undefined) continue;

    const sourceEndOffset = differenceInCalendarDays(sourceRow.end, timelineRange.start) * cellWidth + cellWidth;
    const targetStartOffset = differenceInCalendarDays(row.start, timelineRange.start) * cellWidth;

    const fromY = GANTT_HEADER_HEIGHT + sourceIndex * GANTT_ROW_HEIGHT + 28;
    const toY = GANTT_HEADER_HEIGHT + targetIndex * GANTT_ROW_HEIGHT + 28;

    arrows.push({ fromX: sourceEndOffset, fromY, toX: targetStartOffset, toY, color: 'var(--accent)' });
  }

  if (arrows.length === 0) return null;

  const totalWidth = (differenceInCalendarDays(timelineRange.end, timelineRange.start) + 1) * cellWidth;
  const totalHeight = GANTT_HEADER_HEIGHT + ganttRows.length * GANTT_ROW_HEIGHT;

  return (
    <svg className="pointer-events-none absolute left-[220px] top-0 z-5" width={totalWidth} height={totalHeight}>
      <defs>
        <marker id="dep-arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6" fill="var(--accent)" opacity="0.7" />
        </marker>
      </defs>
      {arrows.map((arrow, index) => {
        const midX = (arrow.fromX + arrow.toX) / 2;
        const d = arrow.fromY === arrow.toY
          ? `M${arrow.fromX},${arrow.fromY} L${arrow.toX},${arrow.toY}`
          : `M${arrow.fromX},${arrow.fromY} C${midX},${arrow.fromY} ${midX},${arrow.toY} ${arrow.toX},${arrow.toY}`;
        return (
          <path key={index} d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.55" markerEnd="url(#dep-arrowhead)" />
        );
      })}
    </svg>
  );
}

// ─── Loading / Layout ───────────────────────────────────────────────

export function LoadingSkeleton() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5 shadow-[var(--shadow-sm)]">
        <div className="h-4 w-28 animate-pulse rounded-full bg-[var(--surface-2)]" />
        <div className="h-8 w-64 animate-pulse rounded-full bg-[var(--surface-2)]" />
        <div className="h-4 w-48 animate-pulse rounded-full bg-[var(--surface-2)]" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-32 animate-pulse rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--shadow-sm)]" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--shadow-sm)]" />
    </div>
  );
}

const PULSE_VISUALS: Record<ProjectPulseState, { color: string; label: string }> = {
  on_track: { color: 'var(--success)', label: 'On track' },
  watch: { color: 'var(--warning)', label: 'Watch' },
  off_track: { color: 'var(--danger)', label: 'Off track' },
  unknown: { color: 'var(--text-muted)', label: 'Unknown' },
};

export function ProjectOverviewKpis({
  progress,
  pulse,
}: {
  progress: ProgressSummary;
  pulse: HealthSummary;
}) {
  const inProgressPercent = progress.totalTasks > 0
    ? (progress.inProgressTasks / progress.totalTasks) * 100
    : 0;
  const completedEnd = progress.totalTasks > 0
    ? (progress.completedTasks / progress.totalTasks) * 100
    : 0;
  const inProgressEnd = completedEnd + inProgressPercent;
  const todoEnd = progress.totalTasks > 0
    ? inProgressEnd + (progress.todoTasks / progress.totalTasks) * 100
    : 0;
  const ringBackground = progress.totalTasks > 0
    ? `conic-gradient(var(--success) 0 ${completedEnd}%, var(--accent-500) ${completedEnd}% ${inProgressEnd}%, var(--surface-3) ${inProgressEnd}% ${todoEnd}%, var(--warning) ${todoEnd}% 100%)`
    : 'var(--surface-3)';
  const pulseVisual = PULSE_VISUALS[pulse.state];
  const supportingReasons = pulse.reasons
    .filter((reason) => reason.detail !== pulse.summary)
    .slice(0, 2);
  const TrendIcon = pulse.trend.state === 'improving'
    ? ArrowUpRight
    : pulse.trend.state === 'worsening'
      ? ArrowDownRight
      : pulse.trend.state === 'unknown'
        ? CircleHelp
        : Minus;
  const taskStates = [
    { label: 'Done', value: progress.completedTasks, color: 'var(--success)' },
    { label: 'Active', value: progress.inProgressTasks, color: 'var(--accent-500)' },
    { label: 'To do', value: progress.todoTasks, color: 'var(--surface-3)' },
    ...(progress.cancelledTasks > 0
      ? [{ label: 'Cancelled', value: progress.cancelledTasks, color: 'var(--warning)' }]
      : []),
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.85fr)]">
      <Card className="overflow-hidden border-[var(--border-subtle)]">
        <CardContent className="grid h-full gap-6 p-5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center sm:p-6">
          <div
            role="img"
            aria-label={`${progress.percentComplete}% of project tasks complete`}
            className="relative mx-auto h-28 w-28 shrink-0 rounded-full"
            style={{ background: ringBackground }}
          >
            <div className="absolute inset-[10px] flex flex-col items-center justify-center rounded-full bg-[var(--surface-1)]">
              <span className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">
                {progress.percentComplete}%
              </span>
              <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                complete
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">Project progress</p>
              <p className="text-xs tabular-nums text-[var(--text-tertiary)]">
                {progress.totalTasks > 0
                  ? `${progress.completedTasks} of ${progress.totalTasks} complete`
                  : 'No tasks assigned yet'}
              </p>
            </div>
            <div className={cn(
              'mt-4 grid gap-x-4 gap-y-3 border-y border-[var(--border-subtle)] py-3',
              taskStates.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3',
            )}>
              {taskStates.map((item) => (
                <div key={item.label} className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="truncate text-xs font-medium text-[var(--text-muted)]">{item.label}</span>
                  </div>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-[var(--text-primary)]">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-[var(--text-secondary)]">
                  {progress.inProgressTasks > 0 ? 'Work in motion' : 'No active tasks right now.'}
                </span>
                <span className="tabular-nums text-[var(--text-muted)]">
                  {progress.totalTasks > 0 ? `${Math.round(inProgressPercent)}% of tasks` : 'No tasks'}
                </span>
              </div>
              <div
                role="img"
                aria-label={`${progress.inProgressTasks} of ${progress.totalTasks} tasks in progress`}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]"
              >
                <div
                  className="h-full rounded-full bg-[var(--accent-500)]"
                  style={{ width: `${Math.min(100, inProgressPercent)}%` }}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[var(--border-subtle)]">
        <CardContent className="flex h-full flex-col p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--text-primary)]">Project pulse</p>
            <PulseBadge state={pulse.state} />
          </div>

          <p className="mt-4 max-w-[52ch] text-sm leading-6 text-[var(--text-secondary)]">{pulse.summary}</p>

          <dl className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-[var(--border-subtle)] py-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="sr-only">Freshness</dt>
              <dd
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]"
                title={pulse.freshness.label}
              >
                <Clock3 size={12} aria-hidden="true" />
                {pulse.freshness.state === 'fresh' ? 'Fresh' : pulse.freshness.state === 'aging' ? 'Aging' : pulse.freshness.state === 'stale' ? 'Stale' : 'Unknown'}
              </dd>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="sr-only">Trend</dt>
              <dd
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]"
                title={pulse.trend.label}
              >
                <TrendIcon size={12} aria-hidden="true" />
                {pulse.trend.state === 'improving' ? 'Improving' : pulse.trend.state === 'worsening' ? 'Worsening' : pulse.trend.state === 'stable' ? 'Stable' : 'Unknown'}
              </dd>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="sr-only">Confidence</dt>
              <dd
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]"
                title={pulse.confidence.label}
              >
                <ShieldCheck size={12} aria-hidden="true" />
                {pulse.confidence.level === 'high' ? 'High confidence' : pulse.confidence.level === 'medium' ? 'Medium confidence' : 'Low confidence'}
              </dd>
            </div>
          </dl>

          {supportingReasons.length > 0 && (
            <ul className="mt-4 space-y-2" aria-label="Pulse reasons">
              {supportingReasons.map((reason) => (
                <li key={reason.code} className="flex gap-2 text-xs leading-5 text-[var(--text-tertiary)]">
                  <Activity size={13} className="mt-1 shrink-0" style={{ color: pulseVisual.color }} aria-hidden="true" />
                  <span>{reason.detail}</span>
                </li>
              ))}
            </ul>
          )}

          {pulse.suggestion && (
            <div className="mt-auto flex gap-2 pt-5 text-xs leading-5 text-[var(--text-primary)]">
              <Lightbulb size={14} className="mt-0.5 shrink-0 text-[var(--accent-400)]" aria-hidden="true" />
              <p><span className="font-semibold">Next:</span> {pulse.suggestion}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Badge Components ───────────────────────────────────────────────

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const variant = status === 'completed' ? 'success' : status === 'on_hold' || status === 'cancelled' ? 'warning' : 'secondary';
  return <Badge variant={variant}>{STATUS_LABELS[status]}</Badge>;
}

export function PulseBadge({ state }: { state: ProjectPulseState }) {
  const variant = state === 'on_track' ? 'success' : state === 'watch' ? 'warning' : state === 'off_track' ? 'danger' : 'secondary';
  return <Badge variant={variant}>{PULSE_VISUALS[state].label}</Badge>;
}

export function PhaseStatusBadge({ status }: { status: 'pending' | 'in_progress' | 'completed' }) {
  const variant = status === 'completed' ? 'success' : status === 'in_progress' ? 'default' : 'secondary';
  return <Badge variant={variant}>{PHASE_STATUS_LABELS[status]}</Badge>;
}

export function TaskStatusBadge({ status, statusReason }: { status: TaskStatus; statusReason?: string | null }) {
  const label = status === 'cancelled' && statusReason === 'moved' ? 'Moved' : TASK_STATUS_LABELS[status];
  return <Badge variant="outline" className={getTaskStatusVisual(status).badgeClass}>{label}</Badge>;
}

export function PriorityDot({ priority }: { priority: TaskPriority }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getPriorityDotColor(priority) }} aria-hidden="true" />;
}

/**
 * Renders the external display ID for a task (e.g. #123 for GitHub issues).
 * Returns null when the task has no meaningful external ID.
 */
export function TaskDisplayId({ task }: { task: ProjectTask }) {
  const displayId = getTaskDisplayId(task.connectorType, task.metadata, task.sourceId);
  if (!displayId) return null;
  return (
    <span className="text-xs text-[var(--text-muted)] flex-shrink-0 font-mono tabular-nums">{displayId}</span>
  );
}

/**
 * Inline badges for effort and subtask progress shown on project task rows.
 */
export function TaskInfoBadges({ task }: { task: ProjectTask }) {
  return (
    <>
      <EffortBadge effort={task.effort ?? null} size="sm" />
      <SubtaskPill done={task.subtaskDone ?? 0} total={task.subtaskTotal ?? 0} />
    </>
  );
}

// ─── DnD Components ─────────────────────────────────────────────────

export function SortablePhaseItem({ phaseId, isMenuOpen, children }: { phaseId: string; isMenuOpen?: boolean; children: (dragHandleProps: Record<string, unknown>) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `phase:${phaseId}`,
    data: { type: 'phase' },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <motion.div variants={fadeSlideUp} style={{ zIndex: isMenuOpen ? 50 : undefined, position: 'relative' }}>
      <div ref={setNodeRef} style={style}>
        {children({ ...attributes, ...listeners })}
      </div>
    </motion.div>
  );
}

export function DraggableTaskItem({ taskId, children }: { taskId: string; children: (dragHandleProps: Record<string, unknown>) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `task:${taskId}`,
    data: { type: 'task' },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

export function DroppablePhaseZone({ phaseId, children }: { phaseId: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `phase-drop:${phaseId}`,
    data: { type: 'phase-drop' },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-[var(--radius-lg)] transition-[background-color,border-color] duration-150',
        isOver && 'bg-[var(--accent-500)]/5 ring-2 ring-[var(--accent-500)]/30',
      )}
    >
      {children}
    </div>
  );
}

// ─── Phase Add Task Menu ────────────────────────────────────────────

export function PhaseAddTaskMenu({
  open,
  onOpenChange,
  trigger,
  onCreateNew,
  onLinkExisting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactElement;
  onCreateNew: () => void;
  onLinkExisting: () => void;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Add task"
          align="center"
          side="bottom"
          sideOffset={6}
          avoidCollisions
          collisionPadding={12}
          sticky="partial"
          className="z-50 w-52 origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_8px_24px_rgba(0,0,0,0.3)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <DropdownMenu.Item
            onSelect={onCreateNew}
            className="flex cursor-default items-center gap-2.5 px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors duration-100 focus:bg-[var(--surface-2)]"
          >
            <FilePlus2 size={14} className="text-[var(--accent)]" />
            Create new task
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onLinkExisting}
            className="flex cursor-default items-center gap-2.5 px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors duration-100 focus:bg-[var(--surface-2)]"
          >
            <Search size={14} className="text-[var(--text-secondary)]" />
            Link existing task
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
