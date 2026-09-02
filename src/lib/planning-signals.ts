import 'server-only';

import {
  PLANNING_FRICTION_EVENT_TYPES,
  type PlanningFrictionEventType,
  type PlanningSignalFinalizationResult,
  type PlanningSignalInput,
  type PlanningSignalRepository,
} from '@/db/persistence/planning-signals';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalToday } from '@/lib/utils/date';

export type {
  PlanningFrictionEventType,
  PlanningSignalFinalizationResult,
  PlanningSignalInput,
};

export async function getPlanningSignalRepository(): Promise<PlanningSignalRepository> {
  return (await getWorkerPersistenceRepositories()).planningSignals;
}

export async function appendPlanningSignal(input: PlanningSignalInput): Promise<boolean> {
  return (await getPlanningSignalRepository()).append(input);
}

export async function finalizePlanningSignals(
  today = getLocalToday(),
): Promise<PlanningSignalFinalizationResult> {
  return (await getWorkerPersistenceRepositories()).planningSignals.finalize(today);
}

export async function finalizePlanningSignalsIfDue(
  today = getLocalToday(),
  now = new Date(),
): Promise<PlanningSignalFinalizationResult | null> {
  return (await getWorkerPersistenceRepositories()).planningSignals.finalizeIfDue({ today, now });
}

export function planningFrictionEventTypes(): readonly PlanningFrictionEventType[] {
  return PLANNING_FRICTION_EVENT_TYPES;
}
