import type { PlanningHorizon } from '@/types';

export const PLANNING_HORIZONS = ['now', 'next', 'later', 'someday'] as const satisfies readonly PlanningHorizon[];
export type PlanningHorizonFilter = PlanningHorizon | 'none';

export const PLANNING_HORIZON_LABELS: Record<PlanningHorizon, string> = {
  now: 'Now',
  next: 'Next',
  later: 'Later',
  someday: 'Someday',
};

export const PLANNING_HORIZON_VISUALS: Record<PlanningHorizon, {
  color: string;
  dotClass: string;
  textClass: string;
  badgeClass: string;
}> = {
  now: {
    color: 'var(--success)',
    dotClass: 'bg-emerald-400',
    textClass: 'text-emerald-400',
    badgeClass: 'border-emerald-800/30 bg-emerald-900/20 text-emerald-400',
  },
  next: {
    color: 'var(--accent-400)',
    dotClass: 'bg-blue-400',
    textClass: 'text-blue-400',
    badgeClass: 'border-blue-800/30 bg-blue-900/20 text-blue-400',
  },
  later: {
    color: 'var(--color-violet-400)',
    dotClass: 'bg-violet-400',
    textClass: 'text-violet-400',
    badgeClass: 'border-violet-800/30 bg-violet-900/20 text-violet-400',
  },
  someday: {
    color: 'var(--text-tertiary)',
    dotClass: 'bg-slate-400',
    textClass: 'text-slate-400',
    badgeClass: 'border-slate-700/30 bg-slate-800/20 text-slate-400',
  },
};

export function isPlanningHorizon(value: unknown): value is PlanningHorizon {
  return typeof value === 'string'
    && (PLANNING_HORIZONS as readonly string[]).includes(value);
}
