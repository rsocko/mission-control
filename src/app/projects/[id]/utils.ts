import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  format,
  isAfter,
  isBefore,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
} from 'date-fns';
import type {
  LocalDisposition,
  ProjectHealth,
  TaskPriority,
  TaskStatus,
} from '@/types';
import type { TaskFieldUpdate } from '@/components/task-detail/task-detail-types';
import type { TaskFilterContext } from '@/lib/task-filter-context';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import { filterTasksByKeyword } from '@/lib/utils/filterTasksByKeyword';
import { parseFilterQuery } from '@/lib/utils/parseFilterQuery';
import { getTaskStatusVisual } from '@/lib/constants/task-formatting';
export {
  getProjectTaskConnectorIcon as getConnectorIcon,
  getProjectTaskPriorityColor as getPriorityDotColor,
} from '@/lib/projects/task-visuals';
import type {
  GanttPhaseRow,
  GanttZoom,
  HealthSummary,
  PhaseTaskEntry,
  ProgressSummary,
  ProjectDetailViewModel as ProjectRecord,
  ProjectPhaseViewModel as ProjectPhase,
  ProjectTab,
  ProjectTaskViewModel as ProjectTask,
  TimelineSegment,
} from './types';

const PROJECT_TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'done',
  'cancelled',
];
const PROJECT_TASK_PRIORITIES: readonly TaskPriority[] = [
  'critical',
  'high',
  'medium',
  'low',
  'none',
];
const PROJECT_TASK_DISPOSITIONS: readonly LocalDisposition[] = [
  'active',
  'handled',
  'dismissed',
];

function includesValue<T extends string>(
  values: readonly T[],
  value: string | number | null | undefined,
): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

export function applyProjectTaskFieldUpdate(
  task: ProjectTask,
  fields: TaskFieldUpdate,
): ProjectTask {
  let updated = task;
  if (typeof fields.title === 'string') updated = { ...updated, title: fields.title };
  if (includesValue(PROJECT_TASK_STATUSES, fields.status)) {
    updated = { ...updated, status: fields.status };
  }
  if (includesValue(PROJECT_TASK_PRIORITIES, fields.priority)) {
    updated = { ...updated, priority: fields.priority };
  }
  if (includesValue(PROJECT_TASK_DISPOSITIONS, fields.localDisposition)) {
    updated = { ...updated, localDisposition: fields.localDisposition };
  }
  if (typeof fields.statusReason === 'string' || fields.statusReason === null) {
    updated = { ...updated, statusReason: fields.statusReason };
  }
  if (typeof fields.dueDate === 'string' || fields.dueDate === null) {
    updated = { ...updated, dueDate: fields.dueDate };
  }
  if (typeof fields.assignee === 'string' || fields.assignee === null) {
    updated = { ...updated, assignee: fields.assignee };
  }
  if (typeof fields.effort === 'number' || fields.effort === null) {
    updated = { ...updated, effort: fields.effort };
  }
  if (
    typeof fields.estimatedDuration === 'number'
    || fields.estimatedDuration === null
  ) {
    updated = { ...updated, estimatedDuration: fields.estimatedDuration };
  }
  return updated;
}

export function syncTaskPhaseMemberships(
  tasks: ProjectTask[],
  snapshot: ProjectHierarchySnapshot,
): ProjectTask[] {
  const phaseByTask = new Map<string, ProjectPhase>();
  for (const phase of snapshot.phases) {
    for (const item of snapshot.phaseItemsByPhase[phase.id] ?? []) {
      phaseByTask.set(item.taskId, phase);
    }
  }

  return tasks.map((task) => {
    if (!task.hubProjectIds?.includes(snapshot.projectId)) return task;
    const phase = phaseByTask.get(task.id);
    const existingMembership = task.projectPhaseMemberships
      ?.find((membership) => membership.projectId === snapshot.projectId);
    return {
      ...task,
      projectPhaseMemberships: [
        ...(task.projectPhaseMemberships || [])
          .filter((membership) => membership.projectId !== snapshot.projectId),
        {
          projectId: snapshot.projectId,
          projectName: existingMembership?.projectName || 'Unknown Project',
          phaseId: phase?.id ?? null,
          phaseName: phase?.name ?? null,
        },
      ],
    };
  });
}

export function toRgba(color: string | null | undefined, alpha: number) {
  if (!color) {
    return `rgba(59, 130, 246, ${alpha})`;
  }

  const normalized = color.trim();
  if (/^#([0-9a-f]{3}){1,2}$/i.test(normalized)) {
    const hex = normalized.slice(1);
    const chunk = hex.length === 3
      ? hex.split('').map((value) => value + value)
      : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    const [r, g, b] = chunk.map((value) => Number.parseInt(value, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const rgbMatch = normalized.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }

  // CSS variables and other values: use color-mix for alpha transparency
  if (alpha < 1) {
    return `color-mix(in srgb, ${normalized} ${Math.round(alpha * 100)}%, transparent)`;
  }

  return normalized;
}

/** Parse a date string (YYYY-MM-DD or ISO datetime) as a local Date at noon to avoid UTC midnight issues. */
export function parseLocalDate(value: string): Date {
  const datePart = value.split('T')[0];
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    return new Date(NaN);
  }
  return new Date(y, m - 1, d, 12);
}

export function formatDateLabel(value?: string | null, fallback = '—') {
  if (!value) return fallback;
  const parsed = parseLocalDate(value);
  return Number.isNaN(parsed.getTime()) ? fallback : format(parsed, 'MMM d, yyyy');
}

export function formatRelativeTime(value?: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';

  const diffMs = Date.now() - parsed.getTime();
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return format(parsed, 'MMM d');
}

export function getProjectStatus(project: ProjectRecord) {
  return project.statusOverride ?? project.status;
}

export function getPhaseColor(phase: ProjectPhase, project?: ProjectRecord | null) {
  return phase.color || project?.color || 'var(--accent-500)';
}

/** Returns a status-based color for phase indicators in the Gantt chart: gray (pending), blue (in_progress), green (completed). */
export function getPhaseStatusColor(status: ProjectPhase['status']): string {
  switch (status) {
    case 'completed':
      return 'var(--success)';
    case 'in_progress':
      return 'var(--accent-500)';
    default:
      return 'var(--text-muted)';
  }
}

/** Returns a status-based color for task dots in the Gantt chart. */
export function getTaskStatusColor(status: TaskStatus): string {
  return getTaskStatusVisual(status).color;
}

export function getProgressSummary(tasks: ProjectTask[]): ProgressSummary {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.status === 'done').length;
  const inProgressTasks = tasks.filter((task) => task.status === 'in_progress').length;
  const todoTasks = tasks.filter((task) => task.status === 'todo').length;
  const cancelledTasks = tasks.filter((task) => task.status === 'cancelled').length;
  const percentComplete = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return {
    totalTasks,
    completedTasks,
    inProgressTasks,
    todoTasks,
    cancelledTasks,
    percentComplete,
  };
}

export function getProjectTabCount(
  tab: ProjectTab,
  phaseCount: number,
  taskCount: number,
): number | null {
  if (tab === 'phases') return phaseCount;
  if (tab === 'tasks') return taskCount;
  return null;
}

export function getHealthSummary(project: ProjectRecord, phases: ProjectPhase[], tasks: ProjectTask[], progress: ProgressSummary): HealthSummary {
  const today = startOfDay(new Date());
  const overdueTasks = tasks.filter((task) => {
    if (!task.dueDate || task.status === 'done' || task.status === 'cancelled') return false;
    return isBefore(startOfDay(parseLocalDate(task.dueDate)), today);
  }).length;
  const latePhases = phases.filter((phase) => {
    if (!phase.targetEnd || phase.status === 'completed') return false;
    return isBefore(startOfDay(parseLocalDate(phase.targetEnd)), today);
  }).length;
  const targetDate = project.targetDate ? startOfDay(parseLocalDate(project.targetDate)) : null;
  const daysToTarget = targetDate ? differenceInCalendarDays(targetDate, today) : null;

  if (
    overdueTasks > 0 ||
    latePhases > 0 ||
    (daysToTarget !== null && daysToTarget < 0 && progress.percentComplete < 100)
  ) {
    return {
      health: 'behind',
      message: overdueTasks > 0
        ? `${overdueTasks} ${overdueTasks === 1 ? 'task is' : 'tasks are'} past due — worth a look.`
        : 'At least one phase is past its target window.',
    };
  }

  if (
    (daysToTarget !== null && daysToTarget <= 14 && progress.percentComplete < 75) ||
    phases.some((phase) => {
      if (!phase.targetEnd || phase.status === 'completed') return false;
      const daysRemaining = differenceInCalendarDays(startOfDay(parseLocalDate(phase.targetEnd)), today);
      return daysRemaining >= 0 && daysRemaining <= 7;
    })
  ) {
    return {
      health: 'at_risk',
      message: 'Upcoming deadlines are close relative to current progress.',
    };
  }

  return {
    health: 'on_track',
    message: progress.totalTasks > 0 ? 'Progress is tracking well against the current plan.' : 'Project structure is in place and ready for work.',
  };
}

export function buildGanttRows(phases: ProjectPhase[], phaseEntries: Record<string, PhaseTaskEntry[]>, project: ProjectRecord | null): GanttPhaseRow[] {
  const today = startOfDay(new Date());
  const fallbackStart = project?.startedAt ? startOfDay(parseLocalDate(project.startedAt)) : today;
  let cursor = fallbackStart;

  return phases.map<GanttPhaseRow>((phase) => {
    const hasExplicitStart = !!phase.targetStart;
    const hasExplicitEnd = !!phase.targetEnd;
    const explicitStart = hasExplicitStart ? startOfDay(parseLocalDate(phase.targetStart!)) : null;
    const explicitEnd = hasExplicitEnd ? startOfDay(parseLocalDate(phase.targetEnd!)) : null;
    const validExplicitStart = explicitStart && !Number.isNaN(explicitStart.getTime()) ? explicitStart : null;
    const validExplicitEnd = explicitEnd && !Number.isNaN(explicitEnd.getTime()) ? explicitEnd : null;

    const entries = phaseEntries[phase.id] ?? [];

    // Collect known task anchor dates (due date, or completedAt if done)
    const taskDates: Date[] = [];
    for (const entry of entries) {
      const anchor = getTaskAnchorDate(entry.task);
      if (anchor) taskDates.push(anchor);
    }

    // Determine phase start & end
    let start: Date;
    let end: Date;
    const hasExplicitBounds = !!(validExplicitStart && validExplicitEnd);

    if (hasExplicitBounds) {
      // Phase has explicit window — use it directly
      start = validExplicitStart;
      end = validExplicitEnd;
    } else if (validExplicitStart) {
      // Has start but no end — use estimated days or tasks to determine end
      start = validExplicitStart;
      const estimatedDays = Math.max(1, Math.round(phase.estimatedDays ?? Math.max(5, entries.length || 1)));
      end = addDays(start, estimatedDays - 1);
      // Stretch if tasks fall beyond
      for (const d of taskDates) {
        if (isAfter(d, end)) end = d;
      }
    } else if (taskDates.length > 0) {
      // No explicit dates — let tasks dictate the span
      const earliest = taskDates.reduce((a, b) => (isBefore(a, b) ? a : b));
      const latest = taskDates.reduce((a, b) => (isAfter(a, b) ? a : b));
      start = isBefore(earliest, cursor) ? earliest : cursor;
      end = latest;
      // Ensure minimum duration
      if (!isAfter(end, start)) end = start;
    } else {
      // No dates at all — fall back to cursor + estimated days
      start = cursor;
      const estimatedDays = Math.max(1, Math.round(phase.estimatedDays ?? Math.max(5, entries.length || 1)));
      end = addDays(start, estimatedDays - 1);
    }

    if (isBefore(end, start)) {
      end = start;
    }

    cursor = addDays(end, 1);
    const durationDays = differenceInCalendarDays(end, start) + 1;
    const slotWidth = Math.max(1, Math.floor(durationDays / Math.max(entries.length, 1)));

    const tasks = entries.map((entry, index) => {
      const effortDays = Math.max(1, Math.ceil((entry.item.estimatedEffortHours ?? entry.task.estimatedDuration ?? 8) / 8));
      const anchor = getTaskAnchorDate(entry.task);

      let barStart: Date;
      let barEnd: Date;

      if (anchor) {
        // Position the bar ending at its anchor date (due or completed)
        barEnd = anchor;
        barStart = addDays(barEnd, -(Math.min(effortDays, slotWidth) - 1));
        if (isBefore(barStart, start)) barStart = start;
        // Clamp to phase bounds when explicit dates are set
        if (hasExplicitBounds && isAfter(barEnd, end)) barEnd = end;
      } else {
        // No anchor — distribute evenly within the phase span
        barStart = addDays(start, Math.min(durationDays - 1, index * slotWidth));
        barEnd = addDays(barStart, Math.min(Math.max(effortDays, 1), slotWidth) - 1);
      }

      if (isBefore(barEnd, barStart)) {
        barEnd = barStart;
      }

      return { item: entry.item, task: entry.task, start: barStart, end: barEnd };
    });

    return { phase, start, end, durationDays, tasks };
  });
}

/** Returns the best available anchor date for a task: completedAt if done, otherwise dueDate. */
function getTaskAnchorDate(task: ProjectTask): Date | null {
  // If the task is done and has a completion date, use that
  if (task.status === 'done' && task.completedAt) {
    const completed = startOfDay(parseLocalDate(task.completedAt));
    if (!Number.isNaN(completed.getTime())) return completed;
  }
  // Otherwise use due date
  if (task.dueDate) {
    const due = startOfDay(parseLocalDate(task.dueDate));
    if (!Number.isNaN(due.getTime())) return due;
  }
  return null;
}

export function buildTimelineSegments(start: Date, end: Date, zoom: GanttZoom, cellWidth: number): TimelineSegment[] {
  const segments: TimelineSegment[] = [];

  if (zoom === 'day') {
    let cursor = start;
    while (!isAfter(cursor, end)) {
      segments.push({
        label: format(cursor, 'd'),
        sublabel: format(cursor, 'EEE'),
        offset: differenceInCalendarDays(cursor, start) * cellWidth,
        width: cellWidth,
      });
      cursor = addDays(cursor, 1);
    }
    return segments;
  }

  if (zoom === 'week') {
    let cursor = startOfWeek(start, { weekStartsOn: 1 });
    while (!isAfter(cursor, end)) {
      const segmentStart = isBefore(cursor, start) ? start : cursor;
      const rawSegmentEnd = addDays(cursor, 6);
      const segmentEnd = isAfter(rawSegmentEnd, end) ? end : rawSegmentEnd;
      segments.push({
        label: format(cursor, 'MMM d'),
        sublabel: `Week ${format(cursor, 'II')}`,
        offset: differenceInCalendarDays(segmentStart, start) * cellWidth,
        width: (differenceInCalendarDays(segmentEnd, segmentStart) + 1) * cellWidth,
      });
      cursor = addWeeks(cursor, 1);
    }
    return segments;
  }

  let cursor = startOfMonth(start);
  while (!isAfter(cursor, end)) {
    const segmentStart = isBefore(cursor, start) ? start : cursor;
    const rawSegmentEnd = endOfMonth(cursor);
    const segmentEnd = isAfter(rawSegmentEnd, end) ? end : rawSegmentEnd;
    segments.push({
      label: format(cursor, 'MMM yyyy'),
      sublabel: `${differenceInCalendarDays(segmentEnd, segmentStart) + 1} days`,
      offset: differenceInCalendarDays(segmentStart, start) * cellWidth,
      width: (differenceInCalendarDays(segmentEnd, segmentStart) + 1) * cellWidth,
    });
    cursor = addMonths(cursor, 1);
  }

  return segments;
}

export function getTimelineRange(rows: GanttPhaseRow[]) {
  const today = startOfDay(new Date());
  if (rows.length === 0) {
    return { start: subDays(today, 7), end: addDays(today, 21) };
  }

  const starts = rows.map((row) => row.start);
  const ends = rows.map((row) => row.end);
  const minStart = starts.reduce((current, value) => (isBefore(value, current) ? value : current), starts[0]);
  const maxEnd = ends.reduce((current, value) => (isAfter(value, current) ? value : current), ends[0]);

  return {
    start: isBefore(subDays(minStart, 2), today) ? subDays(minStart, 2) : subDays(today, 2),
    end: isAfter(addDays(maxEnd, 5), today) ? addDays(maxEnd, 5) : addDays(today, 5),
  };
}

export function sortTasks<T extends Pick<ProjectTask, 'priority' | 'dueDate' | 'updatedAt' | 'title'>>(
  tasks: T[],
  sortBy: string,
  sortDir: 'asc' | 'desc',
): T[] {
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    switch (sortBy) {
      case 'priority': return dir * ((priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4));
      case 'dueDate': return dir * ((a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
      case 'updated': {
        const timeA = new Date(a.updatedAt).getTime();
        const timeB = new Date(b.updatedAt).getTime();
        if (Number.isNaN(timeA) && Number.isNaN(timeB)) return 0;
        if (Number.isNaN(timeA)) return 1;
        if (Number.isNaN(timeB)) return -1;
        return dir * (timeB - timeA);
      }
      case 'title': return dir * a.title.localeCompare(b.title);
      default: return 0;
    }
  });
}

export function filterProjectTasks(
  tasks: ProjectTask[],
  context: TaskFilterContext,
  projectId: string,
): ProjectTask[] {
  const query = parseFilterQuery(context.query);
  const scopedTasks = tasks.map((task) => ({
    ...task,
    dueDate: task.dueDate ?? null,
    projectPhaseMemberships: task.projectPhaseMemberships
      ?.filter((membership) => membership.projectId === projectId),
  }));
  const keywordMatches = new Set(
    filterTasksByKeyword(scopedTasks, context.query).map((task) => task.id),
  );
  const hasStatusQuery = query.statusTokens.length > 0;

  return tasks.filter((task) => {
    if (!keywordMatches.has(task.id)) return false;
    if (
      context.completion === 'open'
      && context.statuses.length === 0
      && !hasStatusQuery
      && (task.status === 'done' || task.status === 'cancelled')
    ) return false;
    if (context.statuses.length > 0 && !context.statuses.includes(task.status)) return false;
    if (context.priorities.length > 0 && !context.priorities.includes(task.priority)) return false;
    if (context.sources.length > 0 && !context.sources.includes(task.connectorType)) return false;
    const sourceListId = task.sourceListId || task.sourceListName?.toLowerCase();
    if (context.listIds.length > 0 && !context.listIds.some((listId) => (
      listId === sourceListId
      || listId === `${task.connectorInstanceId}:${sourceListId}`
    ))) return false;
    if (
      context.tagSlugs.length > 0
      && !context.tagSlugs.some((slug) => task.tags?.some((tag) => tag.slug === slug))
    ) return false;
    return true;
  });
}
