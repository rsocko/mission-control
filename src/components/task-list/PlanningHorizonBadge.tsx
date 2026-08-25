import { Clock3 } from 'lucide-react';
import type { PlanningHorizon } from '@/types';
import {
  PLANNING_HORIZON_LABELS,
  PLANNING_HORIZON_VISUALS,
} from '@/lib/tasks/planning-horizon';

export function PlanningHorizonBadge({
  planningHorizon,
  className = '',
}: {
  planningHorizon: PlanningHorizon | null | undefined;
  className?: string;
}) {
  if (!planningHorizon) return null;

  const label = PLANNING_HORIZON_LABELS[planningHorizon];
  const visual = PLANNING_HORIZON_VISUALS[planningHorizon];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${visual.badgeClass} ${className}`}
      title={`Planning horizon: ${label}`}
    >
      <Clock3 size={10} aria-hidden="true" />
      {label}
    </span>
  );
}
