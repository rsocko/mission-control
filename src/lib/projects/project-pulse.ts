import type {
  ProjectHealth,
  ProjectPulse,
  ProjectPulseFreshness,
  ProjectPulseReason,
  ProjectPulseState,
  ProjectStatus,
} from '@/types';

export interface ProjectPulseInput {
  totalTasks: number;
  completedTasks: number;
  percentComplete: number;
  overdueTasks: number;
  scheduledTasks: number;
  targetDate?: string | null;
  latePhases?: number;
  upcomingPhaseDeadlines?: number;
  phasesWithDates?: number;
  lastActivity?: string | null;
  recentlyCompletedTasks?: number;
  lifecycleStatus?: ProjectStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const datePart = value.split('T')[0];
  const parsed = new Date(`${datePart}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getFreshness(lastActivity: string | null | undefined, now: Date): ProjectPulse['freshness'] {
  const activityDate = lastActivity ? new Date(lastActivity) : null;
  if (!activityDate || Number.isNaN(activityDate.getTime())) {
    return { state: 'unknown', label: 'No activity yet', daysSinceActivity: null };
  }

  const daysSinceActivity = Math.max(0, Math.floor((now.getTime() - activityDate.getTime()) / DAY_MS));
  let state: ProjectPulseFreshness = 'fresh';
  if (daysSinceActivity > 14) state = 'stale';
  else if (daysSinceActivity > 7) state = 'aging';

  const label = daysSinceActivity === 0
    ? 'Active today'
    : daysSinceActivity === 1
      ? 'Active yesterday'
      : `Active ${daysSinceActivity} days ago`;

  return { state, label, daysSinceActivity };
}

function toLegacyHealth(state: ProjectPulseState): ProjectHealth {
  if (state === 'off_track') return 'behind';
  if (state === 'watch') return 'at_risk';
  return 'on_track';
}

export function deriveProjectPulse(input: ProjectPulseInput, now = new Date()): ProjectPulse {
  const targetDate = parseDate(input.targetDate);
  const today = parseDate(now.toISOString()) ?? now;
  const daysToTarget = targetDate
    ? Math.ceil((targetDate.getTime() - today.getTime()) / DAY_MS)
    : null;
  const unfinishedTasks = Math.max(0, input.totalTasks - input.completedTasks);
  const overdueRatio = input.overdueTasks / Math.max(unfinishedTasks, 1);
  const freshness = getFreshness(input.lastActivity, now);
  const latePhases = input.latePhases ?? 0;
  const upcomingPhaseDeadlines = input.upcomingPhaseDeadlines ?? 0;
  const phasesWithDates = input.phasesWithDates ?? 0;
  const recentlyCompletedTasks = input.recentlyCompletedTasks ?? 0;
  const targetMissed = daysToTarget !== null && daysToTarget < 0 && input.percentComplete < 100;
  const deadlinePressure = daysToTarget !== null
    && daysToTarget >= 0
    && daysToTarget <= 14
    && input.percentComplete < 75;
  const hasSchedule = Boolean(targetDate) || input.scheduledTasks > 0 || phasesWithDates > 0;
  const reasons: ProjectPulseReason[] = [];
  const lifecycleInactive = input.lifecycleStatus === 'on_hold'
    || input.lifecycleStatus === 'completed'
    || input.lifecycleStatus === 'cancelled';

  if (lifecycleInactive) {
    const lifecycleLabel = input.lifecycleStatus === 'on_hold'
      ? 'on hold'
      : input.lifecycleStatus;
    return {
      state: 'unknown',
      legacyHealth: 'on_track',
      summary: `Pulse is not evaluated while this project is ${lifecycleLabel}.`,
      reasons: [{
        code: 'lifecycle_inactive',
        detail: `Lifecycle status is ${lifecycleLabel}; delivery signals are preserved but not scored.`,
      }],
      freshness,
      trend: { state: 'unknown', label: 'Evaluation paused' },
      confidence: { level: 'low', label: 'Evaluation paused' },
      suggestion: null,
    };
  }

  if (targetMissed) {
    reasons.push({
      code: 'target_missed',
      detail: `The target date passed with ${unfinishedTasks} ${unfinishedTasks === 1 ? 'task' : 'tasks'} still open.`,
    });
  }
  if (latePhases > 0) {
    reasons.push({
      code: 'late_phase',
      detail: `${latePhases} ${latePhases === 1 ? 'phase is' : 'phases are'} past the planned end date.`,
    });
  }
  if (input.overdueTasks > 0) {
    reasons.push({
      code: 'overdue_work',
      detail: `${input.overdueTasks} open ${input.overdueTasks === 1 ? 'task is' : 'tasks are'} overdue.`,
    });
  }
  if (deadlinePressure) {
    reasons.push({
      code: 'deadline_pressure',
      detail: `${daysToTarget} ${daysToTarget === 1 ? 'day remains' : 'days remain'} with ${unfinishedTasks} ${unfinishedTasks === 1 ? 'task' : 'tasks'} still open.`,
    });
  }
  if (upcomingPhaseDeadlines > 0) {
    reasons.push({
      code: 'phase_deadline',
      detail: `${upcomingPhaseDeadlines} active ${upcomingPhaseDeadlines === 1 ? 'phase ends' : 'phases end'} within 7 days.`,
    });
  }
  if (freshness.state === 'stale') {
    reasons.push({
      code: 'stale_activity',
      detail: `No meaningful activity has been recorded for ${freshness.daysSinceActivity} days.`,
    });
  }
  if (input.totalTasks === 0) {
    reasons.push({
      code: 'no_tasks',
      detail: 'No tasks are assigned, so delivery cannot be assessed yet.',
    });
  } else if (!hasSchedule) {
    reasons.push({
      code: 'limited_schedule',
      detail: 'No project, phase, or task dates are available to measure delivery risk.',
    });
  }

  let state: ProjectPulseState;
  if (input.totalTasks === 0) {
    state = 'unknown';
  } else if (targetMissed || latePhases > 0 || overdueRatio > 0.3) {
    state = 'off_track';
  } else if (
    input.overdueTasks > 0
    || deadlinePressure
    || upcomingPhaseDeadlines > 0
    || freshness.state === 'stale'
  ) {
    state = 'watch';
  } else if (!hasSchedule && freshness.state === 'unknown') {
    state = 'unknown';
  } else {
    state = 'on_track';
  }

  const confidenceLevel = input.totalTasks > 0 && hasSchedule && freshness.state !== 'unknown'
    ? 'high'
    : input.totalTasks > 0 && freshness.state !== 'unknown'
      ? 'medium'
      : 'low';
  const confidenceLabel = confidenceLevel === 'high'
    ? 'Strong evidence'
    : confidenceLevel === 'medium'
      ? 'Some schedule gaps'
      : 'Limited evidence';

  const trend = recentlyCompletedTasks > 0
    ? { state: 'improving' as const, label: `${recentlyCompletedTasks} completed this week` }
    : state === 'off_track' && freshness.state === 'stale'
      ? { state: 'worsening' as const, label: 'Risk without recent movement' }
      : freshness.state === 'fresh' || freshness.state === 'aging'
        ? { state: 'stable' as const, label: 'No completion trend yet' }
        : { state: 'unknown' as const, label: 'Not enough recent history' };

  const primaryReason = reasons[0]?.detail;
  const summary = state === 'on_track'
    ? hasSchedule
      ? 'Current work is moving without a detected schedule risk.'
      : 'Work is active, but delivery confidence is limited without dates.'
    : state === 'unknown'
      ? primaryReason ?? 'Not enough evidence is available to assess delivery.'
      : primaryReason ?? 'Current project signals need attention.';

  let suggestion: string | null = null;
  const reasonCodes = new Set(reasons.map((reason) => reason.code));
  if (reasonCodes.has('target_missed')) suggestion = 'Adjust the target date or reduce the remaining scope.';
  else if (reasonCodes.has('late_phase')) suggestion = 'Replan the late phase before adding more work.';
  else if (reasonCodes.has('overdue_work')) suggestion = 'Review and reschedule the overdue work.';
  else if (reasonCodes.has('deadline_pressure')) suggestion = 'Commit the next task or adjust the target date.';
  else if (reasonCodes.has('phase_deadline')) suggestion = 'Confirm the next deliverable for the ending phase.';
  else if (reasonCodes.has('stale_activity')) suggestion = 'Choose one next task and restart activity.';
  else if (reasonCodes.has('no_tasks')) suggestion = 'Add the first task to make progress measurable.';
  else if (reasonCodes.has('limited_schedule') && state === 'unknown') suggestion = 'Add a target date or task due date.';

  return {
    state,
    legacyHealth: toLegacyHealth(state),
    summary,
    reasons: reasons.slice(0, 3),
    freshness,
    trend,
    confidence: {
      level: confidenceLevel,
      label: confidenceLabel,
    },
    suggestion,
  };
}
