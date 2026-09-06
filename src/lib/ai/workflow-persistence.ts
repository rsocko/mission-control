import {
  requireAIWorkflowPersistence,
  type AIWorkflowPersistence,
} from '@/db/persistence/ai-workflows';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { DailyPlanningPersistence } from '@/db/persistence/daily-planning';

export type AIDailyPlanningPersistence = DailyPlanningPersistence & {
  dayPlan: NonNullable<DailyPlanningPersistence['dayPlan']>;
  energySuggestions: NonNullable<DailyPlanningPersistence['energySuggestions']>;
  focus: DailyPlanningPersistence['focus'] & {
    getSuggestionContext: NonNullable<
      DailyPlanningPersistence['focus']['getSuggestionContext']
    >;
  };
};

export async function getAIWorkflowPersistence(): Promise<AIWorkflowPersistence> {
  return requireAIWorkflowPersistence(await getWorkerPersistenceRepositories());
}

export async function getAIDailyPlanningPersistence(): Promise<AIDailyPlanningPersistence> {
  const { dailyPlanning } = await getWorkerPersistenceRepositories();
  if (!dailyPlanning?.dayPlan || !dailyPlanning.energySuggestions) {
    throw new Error('AI daily-planning persistence is not available in the selected backend');
  }
  if (!dailyPlanning.focus.getSuggestionContext) {
    throw new Error('AI focus-suggestion persistence is not available in the selected backend');
  }
  return dailyPlanning as AIDailyPlanningPersistence;
}
