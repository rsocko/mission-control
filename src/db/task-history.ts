import db from '@/db';
import * as schema from '@/db/schema';
import { taskHistoryEvents } from '@/db/schema';
import { and, asc, eq, gte, inArray, lt, lte, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export const TASK_HISTORY_EVENT_TYPES = [
  'baseline',
  'status_changed',
  'micro_status_changed',
  'kanban_column_changed',
  'effort_changed',
  'reopened',
  'project_added',
  'project_removed',
  'phase_added',
  'phase_removed',
] as const;

export type TaskHistoryEventType = typeof TASK_HISTORY_EVENT_TYPES[number];
export type TaskHistoryEvent = typeof taskHistoryEvents.$inferSelect;
export type TaskHistoryDatabase = BetterSQLite3Database<typeof schema>;

export interface TaskHistoryRange {
  start: string;
  end: string;
  taskIds?: string[];
  eventTypes?: TaskHistoryEventType[];
  projectIds?: string[];
  phaseIds?: string[];
}

export interface TaskStateAtTime {
  taskId: string;
  status: string;
  microStatus: string | null;
  kanbanColumn: string | null;
  effort: number | null;
  projectIds: string[];
  phaseIds: string[];
  asOf: string;
  historicalBoundaryAt: string;
}

interface BaselineValue {
  status?: unknown;
  microStatus?: unknown;
  kanbanColumn?: unknown;
  effort?: unknown;
  projectIds?: unknown;
  phaseIds?: unknown;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Returns events in [start, end), ordered deterministically by occurrence and ID.
 * Empty optional ID/type arrays intentionally return no events.
 */
export async function getTaskTransitionsInRange(
  range: TaskHistoryRange,
  database: TaskHistoryDatabase = db,
): Promise<TaskHistoryEvent[]> {
  const conditions: SQL[] = [
    gte(taskHistoryEvents.occurredAt, range.start),
    lt(taskHistoryEvents.occurredAt, range.end),
  ];

  if (range.taskIds) {
    if (range.taskIds.length === 0) return [];
    conditions.push(inArray(taskHistoryEvents.taskId, range.taskIds));
  }
  if (range.eventTypes) {
    if (range.eventTypes.length === 0) return [];
    conditions.push(inArray(taskHistoryEvents.eventType, range.eventTypes));
  }
  if (range.projectIds) {
    if (range.projectIds.length === 0) return [];
    conditions.push(inArray(taskHistoryEvents.projectId, range.projectIds));
  }
  if (range.phaseIds) {
    if (range.phaseIds.length === 0) return [];
    conditions.push(inArray(taskHistoryEvents.phaseId, range.phaseIds));
  }

  return database
    .select()
    .from(taskHistoryEvents)
    .where(and(...conditions))
    .orderBy(asc(taskHistoryEvents.occurredAt), asc(taskHistoryEvents.id));
}

/**
 * Reconstructs tracked reporting state through the supplied instant.
 * Returns null before the task's baseline because no defensible state exists there.
 */
export async function getTaskStateAtTime(
  taskId: string,
  at: string,
  database: TaskHistoryDatabase = db,
): Promise<TaskStateAtTime | null> {
  const events = await database
    .select()
    .from(taskHistoryEvents)
    .where(and(
      eq(taskHistoryEvents.taskId, taskId),
      lte(taskHistoryEvents.occurredAt, at),
    ))
    .orderBy(asc(taskHistoryEvents.occurredAt), asc(taskHistoryEvents.id));

  const baselineIndex = events.findIndex((event) => event.eventType === 'baseline');
  if (baselineIndex < 0) return null;

  const baselineEvent = events[baselineIndex];
  const baseline = parseBaseline(baselineEvent.newValue);
  if (!baseline || typeof baseline.status !== 'string') return null;

  const projectIds = new Set(stringArray(baseline.projectIds));
  const phaseIds = new Set(stringArray(baseline.phaseIds));
  const state: TaskStateAtTime = {
    taskId,
    status: baseline.status,
    microStatus: typeof baseline.microStatus === 'string' ? baseline.microStatus : null,
    kanbanColumn: typeof baseline.kanbanColumn === 'string' ? baseline.kanbanColumn : null,
    effort: typeof baseline.effort === 'number' ? baseline.effort : null,
    projectIds: [],
    phaseIds: [],
    asOf: at,
    historicalBoundaryAt: baselineEvent.occurredAt,
  };

  for (const event of events.slice(baselineIndex + 1)) {
    switch (event.eventType as TaskHistoryEventType) {
      case 'status_changed':
        if (event.newValue !== null) state.status = event.newValue;
        break;
      case 'micro_status_changed':
        state.microStatus = event.newValue;
        break;
      case 'kanban_column_changed':
        state.kanbanColumn = event.newValue;
        break;
      case 'effort_changed':
        state.effort = event.newValue === null ? null : Number(event.newValue);
        break;
      case 'project_added':
        if (event.projectId) projectIds.add(event.projectId);
        break;
      case 'project_removed':
        if (event.projectId) projectIds.delete(event.projectId);
        break;
      case 'phase_added':
        if (event.phaseId) phaseIds.add(event.phaseId);
        break;
      case 'phase_removed':
        if (event.phaseId) phaseIds.delete(event.phaseId);
        break;
      default:
        break;
    }
  }

  state.projectIds = [...projectIds].sort();
  state.phaseIds = [...phaseIds].sort();
  return state;
}
