import type { DashboardTaskViewModel as Task } from '@/types/dashboard';
import type { PlanningHorizon } from '@/types';

export type MatrixAxisMode = 'priority-urgency' | 'priority-effort';
export type MatrixSizeMode = 'smart-score' | 'effort' | 'urgency' | 'uniform';
export type MatrixColorMode = 'project' | 'urgency' | 'status' | 'priority' | 'planning-horizon';
export type MatrixMobileView = 'table' | 'matrix';

export interface MatrixPaginationCursor {
  signature: string;
  count: number;
}

export interface UrgencyResult {
  value: number | null;
  daysUntilDue: number | null;
  state: 'invalid' | 'none' | 'overdue' | 'today' | 'future' | 'horizon';
  source: 'due-date' | 'planning-horizon' | 'none';
  planningHorizon: PlanningHorizon | null;
}

const PLANNING_HORIZON_URGENCY: Record<PlanningHorizon, number> = {
  now: 85,
  next: 55,
  later: 25,
  someday: 5,
};

const URGENCY_ANCHORS = [
  [0, 95],
  [1, 85],
  [3, 65],
  [7, 45],
  [14, 30],
  [30, 15],
  [90, 5],
] as const;

function dayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(timestamp / 86_400_000);
}

export function priorityPosition(priority: string): number | null {
  switch (priority) {
    case 'critical': return 100;
    case 'high': return 75;
    case 'medium': return 50;
    case 'low': return 25;
    default: return null;
  }
}

export function priorityLabel(priority: string): string {
  return priority === 'none' ? 'Needs data' : priority[0].toUpperCase() + priority.slice(1);
}

export function urgencyScore(
  dueDate: string | null,
  today: string,
  planningHorizon: PlanningHorizon | null = null,
): UrgencyResult {
  if (!dueDate) {
    if (planningHorizon) {
      return {
        value: PLANNING_HORIZON_URGENCY[planningHorizon],
        daysUntilDue: null,
        state: 'horizon',
        source: 'planning-horizon',
        planningHorizon,
      };
    }
    return {
      value: 0,
      daysUntilDue: null,
      state: 'none',
      source: 'none',
      planningHorizon: null,
    };
  }
  const due = dayNumber(dueDate);
  const current = dayNumber(today);
  if (due === null || current === null) {
    return {
      value: null,
      daysUntilDue: null,
      state: 'invalid',
      source: 'due-date',
      planningHorizon,
    };
  }

  const daysUntilDue = due - current;
  if (daysUntilDue < 0) {
    return { value: 100, daysUntilDue, state: 'overdue', source: 'due-date', planningHorizon };
  }
  if (daysUntilDue === 0) {
    return { value: 95, daysUntilDue, state: 'today', source: 'due-date', planningHorizon };
  }
  if (daysUntilDue >= 90) {
    return { value: 5, daysUntilDue, state: 'future', source: 'due-date', planningHorizon };
  }

  for (let index = 1; index < URGENCY_ANCHORS.length; index += 1) {
    const [rightDay, rightValue] = URGENCY_ANCHORS[index];
    if (daysUntilDue <= rightDay) {
      const [leftDay, leftValue] = URGENCY_ANCHORS[index - 1];
      const progress = (daysUntilDue - leftDay) / (rightDay - leftDay);
      return {
        value: Math.round(leftValue + (rightValue - leftValue) * progress),
        daysUntilDue,
        state: 'future',
        source: 'due-date',
        planningHorizon,
      };
    }
  }

  return { value: 5, daysUntilDue, state: 'future', source: 'due-date', planningHorizon };
}

export function effortPosition(effort: number | null | undefined): number | null {
  if (!Number.isInteger(effort) || effort === null || effort === undefined || effort < 1 || effort > 5) {
    return null;
  }
  return ((effort - 1) / 4) * 100;
}

export function markerDiameter(
  task: Pick<Task, 'smartScore' | 'effort'>,
  urgency: number | null,
  mode: MatrixSizeMode,
): { diameter: number; missing: boolean } {
  if (mode === 'uniform') return { diameter: 12, missing: false };

  let normalized: number | null;
  if (mode === 'effort') {
    const position = effortPosition(task.effort);
    normalized = position === null ? null : position / 100;
  } else if (mode === 'urgency') {
    normalized = urgency === null ? null : urgency / 100;
  } else {
    normalized = typeof task.smartScore === 'number'
      ? Math.max(0, Math.min(100, task.smartScore)) / 100
      : null;
  }

  if (normalized === null) return { diameter: 8, missing: true };
  return { diameter: 8 + Math.sqrt(normalized) * 10, missing: false };
}

export function markerDensityScale(taskCount: number, width: number, height: number): number {
  if (taskCount <= 0) return 1;
  const availableArea = Math.max(width, 320) * Math.max(height, 320);
  return Math.max(1, Math.min(1.8, Math.sqrt(availableArea / (taskCount * 20_000))));
}

export function getMatrixPaginationDecision(
  cursor: MatrixPaginationCursor,
  signature: string,
  loadedCount: number,
  loading: boolean,
  hasMore: boolean,
): { cursor: MatrixPaginationCursor; shouldLoad: boolean } {
  if (cursor.signature !== signature) {
    return { cursor: { signature, count: -1 }, shouldLoad: false };
  }
  if (loading || !hasMore || loadedCount === cursor.count) {
    return { cursor, shouldLoad: false };
  }
  return {
    cursor: { signature, count: loadedCount },
    shouldLoad: true,
  };
}
