import type { DashboardTaskViewModel as Task } from '@/types/dashboard';
import {
  effortPosition,
  markerDensityScale,
  priorityPosition,
  urgencyScore,
  type MatrixAxisMode,
} from './scales';

export interface ProjectedMatrixTask {
  task: Task;
  x: number;
  y: number;
  urgency: number | null;
  daysUntilDue: number | null;
  urgencyState: ReturnType<typeof urgencyScore>['state'];
}

export interface MatrixNeedsData {
  missingPriority: Task[];
  missingEffort: Task[];
  missingDueDate: Task[];
  invalidDueDate: Task[];
}

export interface MatrixProjection {
  tasks: ProjectedMatrixTask[];
  needsData: MatrixNeedsData;
}

export interface MatrixTaskMark {
  kind: 'task';
  item: ProjectedMatrixTask;
  x: number;
  y: number;
}

export interface MatrixClusterMark {
  kind: 'cluster';
  id: string;
  items: ProjectedMatrixTask[];
  x: number;
  y: number;
}

export type MatrixMark = MatrixTaskMark | MatrixClusterMark;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function projectTasks(
  tasks: Task[],
  axisMode: MatrixAxisMode,
  today: string,
): MatrixProjection {
  const result: MatrixProjection = {
    tasks: [],
    needsData: {
      missingPriority: [],
      missingEffort: [],
      missingDueDate: [],
      invalidDueDate: [],
    },
  };

  for (const task of tasks) {
    const y = priorityPosition(task.priority);
    const urgency = urgencyScore(task.dueDate, today);
    const effort = effortPosition(task.effort);

    if (y === null) result.needsData.missingPriority.push(task);
    if (effort === null) result.needsData.missingEffort.push(task);
    if (!task.dueDate) {
      result.needsData.missingDueDate.push(task);
    } else if (urgency.value === null) {
      result.needsData.invalidDueDate.push(task);
    }

    if (
      y === null
      || (axisMode === 'priority-urgency' && urgency.value === null)
      || (axisMode === 'priority-effort' && effort === null)
    ) {
      continue;
    }

    result.tasks.push({
      task,
      x: axisMode === 'priority-effort' ? effort! : urgency.value!,
      y,
      urgency: urgency.value,
      daysUntilDue: urgency.daysUntilDue,
      urgencyState: urgency.state,
    });
  }
  return result;
}

function priorityBandBounds(priority: number): [number, number] {
  if (priority >= 100) return [88, 97];
  if (priority >= 75) return [63, 87];
  if (priority >= 50) return [38, 62];
  return [3, 37];
}

function placeIndividualMarks(
  tasks: ProjectedMatrixTask[],
  width: number,
  height: number,
  axisMode: MatrixAxisMode,
): MatrixTaskMark[] {
  const sorted = [...tasks].sort((left, right) => (
    stableHash(left.task.id) - stableHash(right.task.id)
    || left.task.id.localeCompare(right.task.id)
  ));
  const densityScale = markerDensityScale(tasks.length, width, height);
  const separation = 18 * densityScale + 5;
  const placed: Array<{ x: number; y: number }> = [];

  return sorted.map((item) => {
    const anchorX = (item.x / 100) * width;
    const anchorY = (item.y / 100) * height;
    const [minBandY, maxBandY] = priorityBandBounds(item.y);
    const quadrant = quadrantForPoint(item.x, item.y, axisMode);
    const baseAngle = ((stableHash(item.task.id) % 360) * Math.PI) / 180;
    let best = { x: anchorX, y: anchorY, collisions: Number.POSITIVE_INFINITY };

    for (let attempt = 0; attempt < 72; attempt += 1) {
      const radius = attempt === 0 ? 0 : 4 + Math.sqrt(attempt) * separation * 0.72;
      const angle = baseAngle + attempt * 2.399963229728653;
      const candidateX = Math.max(separation / 2, Math.min(width - separation / 2, anchorX + Math.cos(angle) * radius));
      const candidateY = Math.max(
        (minBandY / 100) * height,
        Math.min((maxBandY / 100) * height, anchorY + Math.sin(angle) * radius),
      );
      const normalizedX = (candidateX / width) * 100;
      const normalizedY = (candidateY / height) * 100;
      if (quadrantForPoint(normalizedX, normalizedY, axisMode) !== quadrant) continue;

      const collisions = placed.reduce((count, point) => (
        Math.hypot(candidateX - point.x, candidateY - point.y) < separation ? count + 1 : count
      ), 0);
      if (collisions < best.collisions) best = { x: candidateX, y: candidateY, collisions };
      if (collisions === 0) break;
    }

    placed.push(best);
    return {
      kind: 'task',
      item,
      x: Math.max(1, Math.min(99, (best.x / width) * 100)),
      y: Math.max(3, Math.min(97, (best.y / height) * 100)),
    };
  });
}

export function createMatrixMarks(
  tasks: ProjectedMatrixTask[],
  width: number,
  height: number,
  zoom: number,
  axisMode: MatrixAxisMode = 'priority-urgency',
): MatrixMark[] {
  if (!tasks.length) return [];
  const safeWidth = Math.max(width, 320);
  const safeHeight = Math.max(height, 320);
  const clampedZoom = Math.max(1, Math.min(4, zoom));

  if (tasks.length <= 150 || (tasks.length <= 1_000 && clampedZoom >= 3.5)) {
    return placeIndividualMarks(tasks, safeWidth, safeHeight, axisMode);
  }

  const cellPixels = Math.max(30, 76 / clampedZoom);
  const xCells = Math.max(4, Math.floor(safeWidth / cellPixels));
  const yCells = Math.max(4, Math.floor(safeHeight / cellPixels));
  const bins = new Map<string, ProjectedMatrixTask[]>();

  for (const item of tasks) {
    const xCell = Math.min(xCells - 1, Math.floor((item.x / 100) * xCells));
    const yCell = Math.min(yCells - 1, Math.floor((item.y / 100) * yCells));
    const key = `${xCell}:${yCell}`;
    const bin = bins.get(key) ?? [];
    bin.push(item);
    bins.set(key, bin);
  }

  return [...bins.entries()].map(([key, items]) => {
    if (items.length === 1) {
      return { kind: 'task' as const, item: items[0], x: items[0].x, y: items[0].y };
    }
    return {
      kind: 'cluster' as const,
      id: key,
      items,
      x: items.reduce((sum, item) => sum + item.x, 0) / items.length,
      y: items.reduce((sum, item) => sum + item.y, 0) / items.length,
    };
  });
}

export function quadrantForPoint(
  x: number,
  y: number,
  axisMode: MatrixAxisMode,
): 'upper-left' | 'upper-right' | 'lower-left' | 'lower-right' {
  const xThreshold = axisMode === 'priority-effort' ? 62.5 : 50;
  const upper = y >= 62.5;
  const right = x >= xThreshold;
  if (upper && right) return 'upper-right';
  if (upper) return 'upper-left';
  if (right) return 'lower-right';
  return 'lower-left';
}
