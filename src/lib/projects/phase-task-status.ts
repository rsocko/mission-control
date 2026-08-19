import type { TaskStatus } from '@/types';

export type PhaseStatus = 'pending' | 'in_progress' | 'completed';

export interface PhaseTaskStatusSummary {
  totalCount: number;
  doneCount: number;
  inProgressCount: number;
  remainingCount: number;
  derivedStatus: PhaseStatus | null;
  mismatchMessage: string | null;
}

export function getPhaseTaskStatusSummary(
  phaseStatus: PhaseStatus,
  taskStatuses: TaskStatus[],
): PhaseTaskStatusSummary {
  const totalCount = taskStatuses.length;
  const doneCount = taskStatuses.filter((status) => status === 'done').length;
  const cancelledCount = taskStatuses.filter((status) => status === 'cancelled').length;
  const inProgressCount = taskStatuses.filter((status) => status === 'in_progress').length;
  const relevantCount = totalCount - cancelledCount;
  const remainingCount = relevantCount - doneCount;
  const derivedStatus = relevantCount === 0
    ? null
    : doneCount === relevantCount
      ? 'completed'
      : inProgressCount > 0 || doneCount > 0
        ? 'in_progress'
        : 'pending';

  let mismatchMessage: string | null = null;
  if (phaseStatus === 'completed' && remainingCount > 0) {
    mismatchMessage = `${remainingCount} ${remainingCount === 1 ? 'task is' : 'tasks are'} not complete`;
  } else if (phaseStatus === 'in_progress' && totalCount === 0) {
    mismatchMessage = 'Phase is in progress but has no tasks';
  } else if (phaseStatus === 'in_progress' && relevantCount === 0) {
    mismatchMessage = 'Phase is in progress but has no active tasks';
  } else if (phaseStatus === 'in_progress' && derivedStatus === 'completed') {
    mismatchMessage = cancelledCount === 0
      ? 'All tasks are complete but the phase is still in progress'
      : 'All tasks are resolved but the phase is still in progress';
  } else if (phaseStatus === 'in_progress' && derivedStatus === 'pending') {
    mismatchMessage = 'No task work has started';
  } else if (phaseStatus === 'pending' && derivedStatus === 'completed') {
    mismatchMessage = cancelledCount === 0
      ? 'All tasks are complete but the phase is still pending'
      : 'All tasks are resolved but the phase is still pending';
  } else if (phaseStatus === 'pending' && derivedStatus === 'in_progress') {
    mismatchMessage = 'Task work has started but the phase is still pending';
  }

  return {
    totalCount,
    doneCount,
    inProgressCount,
    remainingCount,
    derivedStatus,
    mismatchMessage,
  };
}

export function filterCompletedTasks<T>(
  items: T[],
  showCompleted: boolean,
  getStatus: (item: T) => TaskStatus,
): T[] {
  return showCompleted ? items : items.filter((item) => getStatus(item) !== 'done');
}

export function shouldCompactCompletedPhase(
  phaseStatus: PhaseStatus,
  visibleTaskCount: number,
  showCompleted: boolean,
): boolean {
  return phaseStatus === 'completed' && !showCompleted && visibleTaskCount === 0;
}
