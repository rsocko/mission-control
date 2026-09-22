import type { PlanningHorizon } from '@/types';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  PLANNING_HORIZON_CODES,
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

  const code = PLANNING_HORIZON_CODES[planningHorizon];
  const label = PLANNING_HORIZON_LABELS[planningHorizon];
  const visual = PLANNING_HORIZON_VISUALS[planningHorizon];
  return (
    <Tooltip content={`Horizon: ${label}`}>
      <span
        aria-label={`Horizon: ${label}`}
        className={`inline-flex min-w-6 shrink-0 items-center justify-center rounded border px-1.5 py-0.5 font-mono text-xs font-semibold ${visual.badgeClass} ${className}`}
      >
        {code}
      </span>
    </Tooltip>
  );
}
