import 'server-only';

import db from '@/db';
import {
  hubProjects,
  projectPhases,
  taskHistoryEvents,
  tasks,
} from '@/db/schema';
import {
  getTaskTransitionsInRange,
  type TaskHistoryDatabase,
  type TaskHistoryEvent,
  type TaskHistoryEventType,
} from '@/db/task-history';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type {
  BurnReport,
  BurnReportMode,
  BurnReportPoint,
  BurnReportScope,
  BurnReportTask,
} from './burn-types';

export const EFFORT_COVERAGE_THRESHOLD = 0.8;

interface BaselineValue {
  status?: unknown;
  effort?: unknown;
  localDisposition?: unknown;
  projectIds?: unknown;
  phaseIds?: unknown;
}

interface MutableTaskState {
  status: string;
  effort: number | null;
  localDisposition: string;
  projectIds: Set<string>;
  phaseIds: Set<string>;
}

export interface BuildBurnReportInput {
  projectId: string;
  scope: BurnReportScope;
  scopeId: string;
  scopeName: string;
  mode: BurnReportMode;
  startDate: string;
  endDate: string;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  events: TaskHistoryEvent[];
  tasks: BurnReportTask[];
  today?: string;
}

export interface GetBurnReportInput {
  projectId: string;
  phaseId?: string;
  mode: BurnReportMode;
  startDate: string;
  endDate: string;
  today?: string;
}

function parseBaseline(value: string | null): BaselineValue | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as BaselineValue
      : null;
  } catch {
    return null;
  }
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [],
  );
}

function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match?.[0] ?? null;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function eventInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addUtcDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function addScopeToBaseline(
  baseline: BaselineValue,
  scope: BurnReportScope,
  scopeId: string,
): BaselineValue {
  const membershipKey = scope === 'project' ? 'projectIds' : 'phaseIds';
  return {
    ...baseline,
    [membershipKey]: [...stringSet(baseline[membershipKey]), scopeId],
  };
}

function reconstructTaskLifecycles(
  events: TaskHistoryEvent[],
  taskRows: BurnReportTask[],
  scope: BurnReportScope,
  scopeId: string,
): TaskHistoryEvent[] {
  const taskMap = new Map(taskRows.map((task) => [task.id, task]));
  const orderedEvents = [...events].sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt) || left.id - right.id
  ));
  const firstBaselineIds = new Map<string, number>();
  const tasksAddedToProject = new Set<string>();
  for (const event of orderedEvents) {
    if (event.eventType === 'baseline' && !firstBaselineIds.has(event.taskId)) {
      firstBaselineIds.set(event.taskId, event.id);
    }
    if (
      scope === 'project'
      && event.eventType === 'project_added'
      && event.projectId === scopeId
    ) {
      tasksAddedToProject.add(event.taskId);
    }
  }
  const reconstructed: TaskHistoryEvent[] = [];

  for (const event of orderedEvents) {
    if (
      event.eventType !== 'baseline'
      || firstBaselineIds.get(event.taskId) !== event.id
    ) {
      reconstructed.push(event);
      continue;
    }

    const baseline = parseBaseline(event.newValue);
    const task = taskMap.get(event.taskId);
    const createdAt = eventInstant(task?.createdAt);
    const inferScopeFromCreation = (
      baselineContainsScope(event, scope, scopeId)
      || (scope === 'project' && tasksAddedToProject.has(event.taskId))
    );
    if (
      !baseline
      || typeof baseline.status !== 'string'
      || !createdAt
      || createdAt > event.occurredAt
      || !inferScopeFromCreation
    ) {
      reconstructed.push(event);
      continue;
    }

    const completedAt = eventInstant(task?.completedAt);
    const hasKnownClosure = (
      (baseline.status === 'done' || baseline.status === 'cancelled')
      && completedAt !== null
      && completedAt >= createdAt
      && completedAt <= event.occurredAt
    );
    if ((baseline.status === 'done' || baseline.status === 'cancelled') && !hasKnownClosure) {
      reconstructed.push(event);
      continue;
    }
    const scopedBaseline = addScopeToBaseline(baseline, scope, scopeId);
    reconstructed.push({
      ...event,
      id: -Math.abs(event.id * 2),
      occurredAt: createdAt,
      recordedAt: event.recordedAt,
      provenance: 'task_lifecycle_reconstruction',
      newValue: JSON.stringify({
        ...scopedBaseline,
        status: 'todo',
      }),
    });
    if (hasKnownClosure) {
      reconstructed.push({
        ...event,
        id: -Math.abs(event.id * 2) + 1,
        eventType: 'status_changed',
        fieldName: 'status',
        previousValue: 'todo',
        newValue: baseline.status,
        occurredAt: completedAt,
        recordedAt: event.recordedAt,
        provenance: 'task_lifecycle_reconstruction',
      });
    }
    reconstructed.push({
      ...event,
      provenance: 'task_lifecycle_reconstruction',
      newValue: JSON.stringify(scopedBaseline),
    });
  }

  return reconstructed;
}

function applyEvent(states: Map<string, MutableTaskState>, event: TaskHistoryEvent): void {
  if (event.eventType === 'baseline') {
    const baseline = parseBaseline(event.newValue);
    if (!baseline || typeof baseline.status !== 'string') return;
    states.set(event.taskId, {
      status: baseline.status,
      effort: typeof baseline.effort === 'number' && Number.isFinite(baseline.effort)
        ? baseline.effort
        : null,
      localDisposition: typeof baseline.localDisposition === 'string'
        ? baseline.localDisposition
        : 'active',
      projectIds: stringSet(baseline.projectIds),
      phaseIds: stringSet(baseline.phaseIds),
    });
    return;
  }

  const state = states.get(event.taskId);
  if (!state) return;

  switch (event.eventType as TaskHistoryEventType) {
    case 'status_changed':
      if (event.newValue !== null) state.status = event.newValue;
      break;
    case 'effort_changed': {
      const effort = event.newValue === null ? null : Number(event.newValue);
      state.effort = effort !== null && Number.isFinite(effort) ? effort : null;
      break;
    }
    case 'local_disposition_changed':
      if (event.newValue !== null) state.localDisposition = event.newValue;
      break;
    case 'project_added':
      if (event.projectId) state.projectIds.add(event.projectId);
      break;
    case 'project_removed':
      if (event.projectId) state.projectIds.delete(event.projectId);
      break;
    case 'phase_added':
      if (event.phaseId) state.phaseIds.add(event.phaseId);
      break;
    case 'phase_removed':
      if (event.phaseId) state.phaseIds.delete(event.phaseId);
      break;
    default:
      break;
  }
}

function baselineContainsScope(
  event: Pick<TaskHistoryEvent, 'newValue'>,
  scope: BurnReportScope,
  scopeId: string,
): boolean {
  const baseline = parseBaseline(event.newValue);
  const memberships = scope === 'project' ? baseline?.projectIds : baseline?.phaseIds;
  return Array.isArray(memberships) && memberships.includes(scopeId);
}

function getMigrationBoundary(
  events: TaskHistoryEvent[],
  scope: BurnReportScope,
  scopeId: string,
): string | null {
  const boundaries = events
    .filter((event) => (
      event.eventType === 'baseline'
      && event.provenance === 'migration_baseline'
      && baselineContainsScope(event, scope, scopeId)
    ))
    .map((event) => event.occurredAt)
    .sort();
  return boundaries.at(-1) ?? null;
}

function scheduleDetails(
  start: string | null,
  end: string | null,
): BurnReport['ideal'] {
  const normalizedStart = dateOnly(start);
  const normalizedEnd = dateOnly(end);
  if (!normalizedStart || !normalizedEnd) {
    return {
      available: false,
      start: normalizedStart,
      end: normalizedEnd,
      message: 'Add both a start and target date to show an ideal trajectory.',
    };
  }
  if (normalizedStart > normalizedEnd) {
    return {
      available: false,
      start: normalizedStart,
      end: normalizedEnd,
      message: 'The target date must be on or after the start date.',
    };
  }
  return {
    available: true,
    start: normalizedStart,
    end: normalizedEnd,
    message: null,
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildBurnReport(input: BuildBurnReportInput): BurnReport {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const dates = enumerateDates(input.startDate, input.endDate);
  const states = new Map<string, MutableTaskState>();
  const events = reconstructTaskLifecycles(
    input.events,
    input.tasks,
    input.scope,
    input.scopeId,
  ).sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt) || left.id - right.id
  ));
  const historicalBoundaryAt = getMigrationBoundary(events, input.scope, input.scopeId);
  const boundaryDate = dateOnly(historicalBoundaryAt);
  const completeFromDate = boundaryDate;
  let eventIndex = 0;

  const points: BurnReportPoint[] = dates.map((date) => {
    const snapshotAt = `${addUtcDays(date, 1)}T00:00:00.000Z`;
    while (eventIndex < events.length && events[eventIndex].occurredAt < snapshotAt) {
      applyEvent(states, events[eventIndex]);
      eventIndex += 1;
    }

    const isFuture = date > today;
    const isBeforeCompleteHistory = completeFromDate !== null && date < completeFromDate;
    const membershipStates = [...states.entries()].filter(([, state]) => (
      state.localDisposition === 'active'
      && (
        input.scope === 'project'
          ? state.projectIds.has(input.scopeId)
          : state.phaseIds.has(input.scopeId)
      )
    ));
    const scopedStates = membershipStates.filter(([, state]) => state.status !== 'cancelled');
    const completedStates = scopedStates.filter(([, state]) => state.status === 'done');
    const remainingStates = scopedStates.filter(([, state]) => state.status !== 'done');
    const todoStates = membershipStates.filter(([, state]) => state.status === 'todo');
    const inProgressStates = membershipStates.filter(([, state]) => state.status === 'in_progress');
    const cancelledStates = membershipStates.filter(([, state]) => state.status === 'cancelled');
    const estimatedStates = scopedStates.filter(([, state]) => (
      state.effort !== null && state.effort > 0
    ));
    const coverage = scopedStates.length === 0 ? 1 : estimatedStates.length / scopedStates.length;
    const estimateIncomplete = coverage < 1;
    const hideActual = isFuture || isBeforeCompleteHistory;

    const countTotal = scopedStates.length;
    const countCompleted = completedStates.length;
    const effortTotal = estimatedStates.reduce((sum, [, state]) => sum + (state.effort ?? 0), 0);
    const effortCompleted = completedStates.reduce(
      (sum, [, state]) => sum + (state.effort && state.effort > 0 ? state.effort : 0),
      0,
    );
    const statusMetric = (statusStates: Array<[string, MutableTaskState]>): number => (
      input.mode === 'count'
        ? statusStates.length
        : statusStates.reduce(
            (sum, [, state]) => sum + (state.effort && state.effort > 0 ? state.effort : 0),
            0,
          )
    );
    const total = input.mode === 'count' ? countTotal : effortTotal;
    const completed = input.mode === 'count' ? countCompleted : effortCompleted;

    return {
      date,
      total: hideActual ? null : roundMetric(total),
      completed: hideActual ? null : roundMetric(completed),
      remaining: hideActual ? null : roundMetric(total - completed),
      todo: hideActual ? null : roundMetric(statusMetric(todoStates)),
      inProgress: hideActual ? null : roundMetric(statusMetric(inProgressStates)),
      cancelled: hideActual ? null : roundMetric(statusMetric(cancelledStates)),
      idealCompleted: null,
      idealRemaining: null,
      effortCoverage: hideActual ? null : roundMetric(coverage),
      estimateIncomplete,
      partial: boundaryDate !== null && date <= boundaryDate,
      completedTaskIds: hideActual ? [] : completedStates.map(([taskId]) => taskId).sort(),
      remainingTaskIds: hideActual ? [] : remainingStates.map(([taskId]) => taskId).sort(),
      statusTaskIds: {
        todo: hideActual ? [] : todoStates.map(([taskId]) => taskId).sort(),
        inProgress: hideActual ? [] : inProgressStates.map(([taskId]) => taskId).sort(),
        done: hideActual ? [] : completedStates.map(([taskId]) => taskId).sort(),
        cancelled: hideActual ? [] : cancelledStates.map(([taskId]) => taskId).sort(),
      },
    };
  });

  const latestActualPoint = [...points].reverse().find((point) => point.total !== null);
  const latestActiveTaskIds = latestActualPoint
    ? [...latestActualPoint.completedTaskIds, ...latestActualPoint.remainingTaskIds]
    : [];
  const latestStatusTaskIds = latestActualPoint
    ? Object.values(latestActualPoint.statusTaskIds).flat()
    : [];
  const latestEstimatedTasks = latestActualPoint?.effortCoverage === null || !latestActualPoint
    ? 0
    : Math.round(latestActiveTaskIds.length * latestActualPoint.effortCoverage);
  const effortCoverage = latestActiveTaskIds.length === 0
    ? 1
    : latestEstimatedTasks / latestActiveTaskIds.length;
  const effortAvailable = latestActiveTaskIds.length === 0 || effortCoverage >= EFFORT_COVERAGE_THRESHOLD;
  const effortMessage = latestActiveTaskIds.length === 0
    ? null
    : !effortAvailable
      ? `Effort reporting needs estimates on at least ${Math.round(EFFORT_COVERAGE_THRESHOLD * 100)}% of scoped tasks. ${latestEstimatedTasks} of ${latestActiveTaskIds.length} are estimated.`
      : effortCoverage < 1
        ? `Effort totals include ${latestEstimatedTasks} of ${latestActiveTaskIds.length} scoped tasks with estimates.`
        : null;

  const ideal = scheduleDetails(input.scheduleStart, input.scheduleEnd);
  const idealTotal = latestActualPoint?.total;
  const canDrawIdeal = ideal.available
    && typeof idealTotal === 'number'
    && (input.mode === 'count' || effortAvailable);
  if (canDrawIdeal && ideal.start && ideal.end) {
    const totalDuration = Math.max(
      1,
      Math.round(
        (new Date(`${ideal.end}T00:00:00.000Z`).getTime()
          - new Date(`${ideal.start}T00:00:00.000Z`).getTime()) / 86_400_000,
      ),
    );
    for (const point of points) {
      if (point.date < ideal.start || point.date > ideal.end) continue;
      const elapsed = Math.max(
        0,
        Math.round(
          (new Date(`${point.date}T00:00:00.000Z`).getTime()
            - new Date(`${ideal.start}T00:00:00.000Z`).getTime()) / 86_400_000,
        ),
      );
      const progress = Math.min(1, elapsed / totalDuration);
      point.idealCompleted = roundMetric(idealTotal * progress);
      point.idealRemaining = roundMetric(idealTotal * (1 - progress));
    }
  }

  const partialHistory = completeFromDate !== null && input.startDate < completeFromDate;
  const taskIds = new Set(latestStatusTaskIds);
  const taskMap = new Map(input.tasks.map((task) => [task.id, task.title]));
  const resolvedIdeal = canDrawIdeal
    ? ideal
    : input.mode === 'effort' && !effortAvailable
      ? {
          ...ideal,
          available: false,
          message: 'The ideal effort trajectory is unavailable until estimate coverage improves.',
        }
      : ideal.available && typeof idealTotal !== 'number'
        ? {
            ...ideal,
            available: false,
            message: 'The ideal trajectory is unavailable until observed scope exists in this window.',
          }
        : ideal;
  for (const point of points) {
    if (point !== latestActualPoint) {
      point.completedTaskIds = [];
      point.remainingTaskIds = [];
      point.statusTaskIds = {
        todo: [],
        inProgress: [],
        done: [],
        cancelled: [],
      };
    }
  }

  return {
    projectId: input.projectId,
    scope: input.scope,
    scopeId: input.scopeId,
    scopeName: input.scopeName,
    mode: input.mode,
    unitLabel: input.mode === 'count' ? 'tasks' : 'effort points',
    range: { start: input.startDate, end: input.endDate },
    points,
    tasks: [...taskIds].sort().map((id) => ({
      id,
      title: taskMap.get(id) ?? `Task ${id}`,
    })),
    partialHistory,
    historicalBoundaryAt,
    completeFromDate,
    effort: {
      available: effortAvailable,
      coverage: roundMetric(effortCoverage),
      estimatedTasks: latestEstimatedTasks,
      totalTasks: latestActiveTaskIds.length,
      threshold: EFFORT_COVERAGE_THRESHOLD,
      message: effortMessage,
    },
    ideal: resolvedIdeal,
  };
}

export async function getBurnReport(
  input: GetBurnReportInput,
  database: TaskHistoryDatabase = db,
): Promise<BurnReport | null> {
  const [project] = await database
    .select({
      id: hubProjects.id,
      name: hubProjects.name,
      startedAt: hubProjects.startedAt,
      targetDate: hubProjects.targetDate,
    })
    .from(hubProjects)
    .where(eq(hubProjects.id, input.projectId))
    .limit(1);
  if (!project) return null;

  let scope: BurnReportScope = 'project';
  let scopeId = project.id;
  let scopeName = project.name;
  let scheduleStart = project.startedAt;
  let scheduleEnd = project.targetDate;

  if (input.phaseId) {
    const [phase] = await database
      .select({
        id: projectPhases.id,
        name: projectPhases.name,
        targetStart: projectPhases.targetStart,
        targetEnd: projectPhases.targetEnd,
      })
      .from(projectPhases)
      .where(and(
        eq(projectPhases.id, input.phaseId),
        eq(projectPhases.projectId, input.projectId),
      ))
      .limit(1);
    if (!phase) return null;
    scope = 'phase';
    scopeId = phase.id;
    scopeName = phase.name;
    scheduleStart = phase.targetStart;
    scheduleEnd = phase.targetEnd;
  }

  const membershipColumn = scope === 'project'
    ? taskHistoryEvents.projectId
    : taskHistoryEvents.phaseId;
  const baselineMembershipPath = scope === 'project' ? '$.projectIds' : '$.phaseIds';
  const candidateRows = await database
    .select({
      taskId: taskHistoryEvents.taskId,
      eventType: taskHistoryEvents.eventType,
      newValue: taskHistoryEvents.newValue,
      occurredAt: taskHistoryEvents.occurredAt,
      provenance: taskHistoryEvents.provenance,
    })
    .from(taskHistoryEvents)
    .where(or(
      eq(membershipColumn, scopeId),
      and(
        eq(taskHistoryEvents.eventType, 'baseline'),
        sql`EXISTS (
          SELECT 1
          FROM json_each(
            CASE
              WHEN json_valid(${taskHistoryEvents.newValue})
                THEN json_extract(${taskHistoryEvents.newValue}, ${baselineMembershipPath})
              ELSE '[]'
            END
          ) AS membership
          WHERE membership.value = ${scopeId}
        )`,
      ),
    ));
  const taskIds = [...new Set(
    candidateRows
      .filter((row) => (
        row.eventType !== 'baseline'
        || baselineContainsScope(row, scope, scopeId)
      ))
      .map((row) => row.taskId),
  )];

  const endExclusive = `${addUtcDays(input.endDate, 1)}T00:00:00.000Z`;
  const latestReconstructionEvent = candidateRows
    .filter((row) => (
      (
        row.eventType === 'baseline'
        && row.provenance === 'migration_baseline'
        && baselineContainsScope(row, scope, scopeId)
      )
      || (scope === 'project' && row.eventType === 'project_added')
    ))
    .map((row) => row.occurredAt)
    .sort()
    .at(-1);
  const eventEndExclusive = latestReconstructionEvent && latestReconstructionEvent >= endExclusive
    ? new Date(new Date(latestReconstructionEvent).getTime() + 1).toISOString()
    : endExclusive;
  const events = taskIds.length === 0
    ? []
    : await getTaskTransitionsInRange({
        start: '0000-01-01T00:00:00.000Z',
        end: eventEndExclusive,
        taskIds,
      }, database);
  const taskRows = taskIds.length === 0
    ? []
    : await database
        .select({
          id: tasks.id,
          title: tasks.title,
          createdAt: tasks.createdAt,
          completedAt: tasks.completedAt,
        })
        .from(tasks)
        .where(inArray(tasks.id, taskIds));

  return buildBurnReport({
    ...input,
    scope,
    scopeId,
    scopeName,
    scheduleStart,
    scheduleEnd,
    events,
    tasks: taskRows,
  });
}
