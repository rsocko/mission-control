import type { EffortMeasure, TaskPriority, TaskStatus } from '@/types';

/**
 * Canonical task visual semantics.
 *
 * Task-facing UI must consume these definitions instead of assigning colors
 * locally. Other domains (project status, triage status, connector health,
 * notification severity, and micro-status) own separate visual semantics.
 */

export type TaskVisualStatus = TaskStatus | 'blocked';

interface TaskVisualDefinition {
  label: string;
  textClass: string;
  dotClass: string;
  borderClass: string;
  badgeClass: string;
  actionClass: string;
  color: string;
}

interface TaskPriorityVisualDefinition extends TaskVisualDefinition {
  shortLabel: string;
}

export const TASK_PRIORITY_VISUALS = {
  critical: {
    label: 'Critical',
    shortLabel: 'P0',
    textClass: 'text-rose-400',
    dotClass: 'bg-rose-500',
    borderClass: 'border-rose-500/60',
    badgeClass: 'text-rose-400 bg-rose-900/40 border-rose-700/50',
    actionClass: 'text-rose-400 hover:bg-rose-400/15 hover:text-rose-300',
    color: '#f43f5e',
  },
  high: {
    label: 'High',
    shortLabel: 'P1',
    textClass: 'text-orange-400',
    dotClass: 'bg-orange-400',
    borderClass: 'border-orange-400/60',
    badgeClass: 'text-orange-400 bg-orange-900/30 border-orange-800/40',
    actionClass: 'text-orange-400 hover:bg-orange-400/15 hover:text-orange-300',
    color: '#fb923c',
  },
  medium: {
    label: 'Medium',
    shortLabel: 'P2',
    textClass: 'text-amber-300',
    dotClass: 'bg-amber-400',
    borderClass: 'border-amber-400/60',
    badgeClass: 'text-amber-300 bg-amber-900/25 border-amber-700/35',
    actionClass: 'text-amber-300 hover:bg-amber-300/15 hover:text-amber-200',
    color: '#fbbf24',
  },
  low: {
    label: 'Low',
    shortLabel: 'P3',
    textClass: 'text-sky-400',
    dotClass: 'bg-sky-400',
    borderClass: 'border-sky-400/60',
    badgeClass: 'text-sky-400 bg-sky-900/25 border-sky-700/35',
    actionClass: 'text-sky-400 hover:bg-sky-400/15 hover:text-sky-300',
    color: '#38bdf8',
  },
  none: {
    label: 'None',
    shortLabel: '—',
    textClass: 'text-[var(--text-muted)]',
    dotClass: 'bg-slate-500',
    borderClass: 'border-[var(--border)]',
    badgeClass: 'text-[var(--text-muted)] bg-[var(--surface-0)] border-[var(--border)]',
    actionClass: 'text-slate-400 hover:bg-slate-400/15 hover:text-slate-300',
    color: '#64748b',
  },
} as const satisfies Record<TaskPriority, TaskPriorityVisualDefinition>;

export const TASK_STATUS_VISUALS = {
  todo: {
    label: 'To do',
    textClass: 'text-[var(--text-muted)]',
    dotClass: 'bg-slate-500',
    borderClass: 'border-slate-500/60',
    badgeClass: 'text-slate-400 bg-slate-900/30 border-slate-700/40',
    actionClass: 'text-slate-400 hover:bg-slate-400/15 hover:text-slate-300',
    color: '#94a3b8',
  },
  in_progress: {
    label: 'In progress',
    textClass: 'text-[var(--accent-400)]',
    dotClass: 'bg-[var(--accent-500)]',
    borderClass: 'border-[var(--accent-500)]/60',
    badgeClass: 'text-[var(--accent-400)] bg-[var(--accent-900)]/30 border-[var(--accent-800)]/40',
    actionClass: 'text-[var(--accent-400)] hover:bg-[var(--accent-400)]/15 hover:text-[var(--accent-300)]',
    color: '#3b82f6',
  },
  blocked: {
    label: 'Blocked',
    textClass: 'text-amber-300',
    dotClass: 'bg-amber-400',
    borderClass: 'border-amber-400/60',
    badgeClass: 'text-amber-300 bg-amber-900/25 border-amber-700/40',
    actionClass: 'text-amber-300 hover:bg-amber-300/15 hover:text-amber-200',
    color: '#f59e0b',
  },
  done: {
    label: 'Done',
    textClass: 'text-[var(--success)]',
    dotClass: 'bg-[var(--success)]',
    borderClass: 'border-[var(--success)]/60',
    badgeClass: 'text-[var(--success)] bg-[var(--success-muted)]/30 border-[var(--success)]/20',
    actionClass: 'text-[var(--success)] hover:bg-[var(--success)]/15 hover:text-emerald-300',
    color: '#10b981',
  },
  cancelled: {
    label: 'Cancelled',
    textClass: 'text-[var(--text-muted)]',
    dotClass: 'bg-slate-500',
    borderClass: 'border-[var(--border)]',
    badgeClass: 'text-[var(--text-muted)] bg-[var(--surface-0)] border-[var(--border)]',
    actionClass: 'text-slate-400 hover:bg-slate-400/15 hover:text-slate-300',
    color: '#64748b',
  },
} as const satisfies Record<TaskVisualStatus, TaskVisualDefinition>;

export function getTaskPriorityVisual(priority: TaskPriority | string) {
  return TASK_PRIORITY_VISUALS[priority as TaskPriority] ?? TASK_PRIORITY_VISUALS.none;
}

export function getTaskStatusVisual(status: TaskVisualStatus | string) {
  return TASK_STATUS_VISUALS[status as TaskVisualStatus] ?? TASK_STATUS_VISUALS.todo;
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/** Text color classes for priority badges (simple — text only). */
export const PRIORITY_TEXT_COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TASK_PRIORITY_VISUALS).map(([key, visual]) => [key, visual.textClass])),
};

/** Full badge classes for priority (text + background + border). */
export const PRIORITY_BADGE_COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TASK_PRIORITY_VISUALS).map(([key, visual]) => [key, visual.badgeClass])),
};

/** Dot color classes used in priority option lists. */
export const PRIORITY_DOT_COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TASK_PRIORITY_VISUALS).map(([key, visual]) => [key, visual.dotClass])),
};

/** Short labels for priority display. */
export const PRIORITY_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TASK_PRIORITY_VISUALS).map(([key, visual]) => [key, visual.shortLabel])),
};

/** Priority options for dropdowns/selectors. */
export const PRIORITY_OPTIONS = [
  { value: 'none', label: TASK_PRIORITY_VISUALS.none.label, dot: TASK_PRIORITY_VISUALS.none.dotClass },
  { value: 'low', label: TASK_PRIORITY_VISUALS.low.label, dot: TASK_PRIORITY_VISUALS.low.dotClass },
  { value: 'medium', label: TASK_PRIORITY_VISUALS.medium.label, dot: TASK_PRIORITY_VISUALS.medium.dotClass },
  { value: 'high', label: TASK_PRIORITY_VISUALS.high.label, dot: TASK_PRIORITY_VISUALS.high.dotClass },
  { value: 'critical', label: TASK_PRIORITY_VISUALS.critical.label, dot: TASK_PRIORITY_VISUALS.critical.dotClass },
] as const;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Task status options for dropdowns/filters. */
export const TASK_STATUS_OPTIONS = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'blocked', label: 'Blocked' },
] as const;

/** Task status options with an "All" option for filters. */
export const TASK_STATUS_FILTER_OPTIONS = [
  { value: 'all' as const, label: 'All statuses' },
  ...TASK_STATUS_OPTIONS,
];

/** Human-readable status labels. */
export const STATUS_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TASK_STATUS_VISUALS).map(([key, visual]) => [key, visual.label])),
};

/** Whether a task is no longer active, regardless of how it ended. */
export function isInactiveTaskStatus(status: string): boolean {
  return status === 'done' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

/** Valid effort values (1–5). */
export const EFFORT_VALUES = [1, 2, 3, 4, 5] as const;

/** Display labels per effort measure. Keyed by numeric effort value. */
export const EFFORT_MEASURE_LABELS: Record<EffortMeasure, Record<number, string>> = {
  tshirt: { 1: 'XS', 2: 'S', 3: 'M', 4: 'L', 5: 'XL' },
  simple: { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' },
  label:  { 1: 'Trivial', 2: 'Easy', 3: 'Medium', 4: 'Hard', 5: 'Epic' },
  time:   { 1: '<1hr', 2: 'Half-day', 3: 'Full-day', 4: 'Multi-day', 5: 'Week+' },
};

/** Human names for each effort measure (for settings UI). */
export const EFFORT_MEASURE_NAMES: Record<EffortMeasure, string> = {
  tshirt: 'T-shirt Size',
  simple: 'Simple Scale',
  label: 'Effort Label',
  time: 'Time Buckets',
};

/** Default effort measure. */
export const DEFAULT_EFFORT_MEASURE: EffortMeasure = 'tshirt';

/** Resolve effort display label for a given measure. */
export function getEffortLabel(effort: number | null | undefined, measure: EffortMeasure = DEFAULT_EFFORT_MEASURE): string {
  if (!effort || effort < 1 || effort > 5) return '—';
  return EFFORT_MEASURE_LABELS[measure][effort] ?? '—';
}

/** Text color classes for effort levels. */
export const EFFORT_TEXT_COLORS: Record<number, string> = {
  1: 'text-green-400',
  2: 'text-emerald-400',
  3: 'text-yellow-400',
  4: 'text-orange-400',
  5: 'text-red-400',
};

/** Full badge classes for effort (text + background + border). */
export const EFFORT_BADGE_COLORS: Record<number, string> = {
  1: 'text-green-400 bg-green-900/30 border-green-800/40',
  2: 'text-emerald-400 bg-emerald-900/30 border-emerald-800/40',
  3: 'text-yellow-400 bg-yellow-900/30 border-yellow-800/40',
  4: 'text-orange-400 bg-orange-900/30 border-orange-800/40',
  5: 'text-red-400 bg-red-900/30 border-red-800/40',
};

/** Dot color classes used in effort option lists. */
export const EFFORT_DOT_COLORS: Record<number, string> = {
  1: 'bg-green-500',
  2: 'bg-emerald-400',
  3: 'bg-yellow-400',
  4: 'bg-orange-400',
  5: 'bg-red-500',
};

/** Effort options for dropdowns/selectors (uses default t-shirt labels). */
export const EFFORT_OPTIONS = [
  { value: 0, label: 'None', dot: '' },
  { value: 1, label: 'XS', dot: 'bg-green-500' },
  { value: 2, label: 'S', dot: 'bg-emerald-400' },
  { value: 3, label: 'M', dot: 'bg-yellow-400' },
  { value: 4, label: 'L', dot: 'bg-orange-400' },
  { value: 5, label: 'XL', dot: 'bg-red-500' },
] as const;

/** Build effort options dynamically for a given measure. */
export function getEffortOptions(measure: EffortMeasure = DEFAULT_EFFORT_MEASURE) {
  const labels = EFFORT_MEASURE_LABELS[measure];
  return [
    { value: 0, label: 'None', dot: '' },
    ...EFFORT_VALUES.map((v) => ({ value: v, label: labels[v], dot: EFFORT_DOT_COLORS[v] })),
  ];
}

/** Effort filter options (with "All" sentinel). */
export const EFFORT_FILTER_OPTIONS = [
  { value: 'all' as const, label: 'All effort levels' },
  { value: '1', label: 'XS' },
  { value: '2', label: 'S' },
  { value: '3', label: 'M' },
  { value: '4', label: 'L' },
  { value: '5', label: 'XL' },
];

// ---------------------------------------------------------------------------
// Effort ↔ Duration mapping (bidirectional auto-fill)
// ---------------------------------------------------------------------------

/** Default duration (minutes) for each effort level. */
export const EFFORT_TO_DURATION: Record<number, number> = {
  1: 15,    // XS → 15m
  2: 60,    // S  → 1h
  3: 240,   // M  → 4h
  4: 480,   // L  → 1d
  5: 2400,  // XL → 1w
};

/** Infer effort from a duration in minutes. Returns null if no reasonable match. */
export function durationToEffort(minutes: number): number | null {
  if (minutes <= 15) return 1;
  if (minutes <= 60) return 2;
  if (minutes <= 240) return 3;
  if (minutes <= 480) return 4;
  return 5;
}
