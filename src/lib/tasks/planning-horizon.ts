import type { PlanningHorizon } from '@/types';

export const PLANNING_HORIZONS = ['now', 'next', 'later', 'someday'] as const satisfies readonly PlanningHorizon[];
export type PlanningHorizonFilter = PlanningHorizon | 'none';

export const PLANNING_HORIZON_LABELS: Record<PlanningHorizon, string> = {
  now: 'Now',
  next: 'Next',
  later: 'Later',
  someday: 'Someday',
};

export function isPlanningHorizon(value: unknown): value is PlanningHorizon {
  return typeof value === 'string'
    && (PLANNING_HORIZONS as readonly string[]).includes(value);
}
