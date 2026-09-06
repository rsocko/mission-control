import { getAIDailyPlanningPersistence } from '../workflow-persistence';

export async function getEnergyTagsForTasks(
  taskIds: string[],
): Promise<Map<string, 'high' | 'medium' | 'low'>> {
  if (taskIds.length === 0) return new Map();
  const persistence = await getAIDailyPlanningPersistence();
  const rows = await persistence.energySuggestions.listLevels(taskIds);
  return new Map(rows.map((row) => [row.taskId, row.energyLevel]));
}
