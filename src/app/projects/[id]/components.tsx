'use client';

import React, { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { differenceInCalendarDays } from 'date-fns';
import { FilePlus2, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { SubtaskPill } from '@/components/ui/SubtaskPill';
import { EffortBadge } from '@/components/EffortBadge';
import { dropdownVariants, fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { getTaskStatusVisual } from '@/lib/constants/task-formatting';
import type { ProjectHealth, ProjectStatus, TaskPriority, TaskStatus } from '@/types';
import { getPriorityDotColor } from './utils';
import { GANTT_HEADER_HEIGHT, GANTT_ROW_HEIGHT, HEALTH_LABELS, PHASE_STATUS_LABELS, STATUS_LABELS, TASK_STATUS_LABELS } from './constants';
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

const HEALTH_VISUALS: Record<ProjectHealth, { color: string; position: number }> = {
  behind: { color: 'var(--danger)', position: 0 },
  at_risk: { color: 'var(--warning)', position: 1 },
  on_track: { color: 'var(--success)', position: 2 },
};

export function ProjectOverviewKpis({
  progress,
  health,
}: {
  progress: ProgressSummary;
  health: HealthSummary;
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
  const healthVisual = HEALTH_VISUALS[health.health];
  const taskStates = [
    { label: 'Done', value: progress.completedTasks, color: 'var(--success)' },
    { label: 'Active', value: progress.inProgressTasks, color: 'var(--accent-500)' },
    { label: 'To do', value: progress.todoTasks, color: 'var(--surface-3)' },
    ...(progress.cancelledTasks > 0
      ? [{ label: 'Cancelled', value: progress.cancelledTasks, color: 'var(--warning)' }]
      : []),
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card className="overflow-hidden border-[var(--border-subtle)] md:col-span-2">
        <CardContent className="grid h-full gap-5 p-5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
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
            <p className="text-xs uppercase tracking-[0.08em] text-[var(--text-tertiary)]">Project progress</p>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              {progress.totalTasks > 0
                ? `${progress.completedTasks} of ${progress.totalTasks} tasks completed`
                : 'No tasks assigned yet'}
            </p>
            <div className={cn(
              'mt-4 grid gap-2',
              taskStates.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3',
            )}>
              {taskStates.map((item) => (
                <div key={item.label} className="min-w-0 rounded-lg bg-[var(--surface-0)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="truncate text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{item.label}</span>
                  </div>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text-primary)]">{item.value}</p>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[var(--border-subtle)]">
        <CardContent className="flex h-full flex-col p-5">
          <p className="text-xs uppercase tracking-[0.08em] text-[var(--text-tertiary)]">In progress</p>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="text-3xl font-bold tabular-nums text-[var(--text-primary)]">{progress.inProgressTasks}</p>
            <p className="pb-1 text-xs tabular-nums text-[var(--text-muted)]">
              {progress.totalTasks > 0 ? `${Math.round(inProgressPercent)}% of tasks` : 'No tasks'}
            </p>
          </div>
          <div
            role="img"
            aria-label={`${progress.inProgressTasks} of ${progress.totalTasks} tasks in progress`}
            className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--surface-3)]"
          >
            <div
              className="h-full rounded-full bg-[var(--accent-500)]"
              style={{ width: `${Math.min(100, inProgressPercent)}%` }}
            />
          </div>
          <p className="mt-auto pt-4 text-sm leading-5 text-[var(--text-secondary)]">
            {progress.inProgressTasks > 0 ? 'Active work is moving through the plan.' : 'No active tasks right now.'}
          </p>
        </CardContent>
      </Card>

      <Card className="border-[var(--border-subtle)]">
        <CardContent className="flex h-full flex-col p-5">
          <p className="text-xs uppercase tracking-[0.08em] text-[var(--text-tertiary)]">Health</p>
          <div className="mt-3">
            <HealthBadge health={health.health} />
          </div>
          <div
            role="img"
            aria-label={`Project health: ${HEALTH_LABELS[health.health]}`}
            className="mt-5 grid grid-cols-3 gap-1.5"
          >
            {(['behind', 'at_risk', 'on_track'] as ProjectHealth[]).map((state, index) => (
              <span
                key={state}
                className="h-2 rounded-full transition-opacity"
                style={{
                  backgroundColor: HEALTH_VISUALS[state].color,
                  opacity: index === healthVisual.position ? 1 : 0.2,
                }}
              />
            ))}
          </div>
          <p className="mt-auto pt-4 text-sm leading-5 text-[var(--text-secondary)]">{health.message}</p>
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

export function HealthBadge({ health }: { health: ProjectHealth }) {
  const variant = health === 'on_track' ? 'success' : health === 'at_risk' ? 'warning' : 'danger';
  return <Badge variant={variant}>{HEALTH_LABELS[health]}</Badge>;
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
  onCreateNew,
  onLinkExisting,
  onClose,
}: {
  onCreateNew: () => void;
  onLinkExisting: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element) || !target.closest('[data-phase-add-menu]')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex].focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const trigger = menuRef.current
        ?.parentElement
        ?.closest('[data-phase-add-menu]')
        ?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
      onClose();
      queueMicrotask(() => trigger?.focus());
    }
  }

  return (
    <motion.div
      ref={menuRef}
      data-phase-add-menu
      role="menu"
      aria-label="Add task"
      onKeyDown={handleKeyDown}
      className="absolute left-1/2 top-full z-50 mt-1.5 w-52 -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_8px_24px_rgba(0,0,0,0.3)]"
      variants={dropdownVariants}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <button
        type="button"
        role="menuitem"
        onClick={onCreateNew}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
      >
        <FilePlus2 size={14} className="text-[var(--accent)]" />
        Create new task
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onLinkExisting}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
      >
        <Search size={14} className="text-[var(--text-secondary)]" />
        Link existing task
      </button>
    </motion.div>
  );
}
