import { generateText } from 'ai';
import {
  getAsyncAIModel,
  getAsyncAIRouteOutcome,
} from '../provider-runtime';
import type { AIRouteOutcome } from '../types';
import { getEnergyTagsForTasks } from './energy-tag-queries';
import { normalizeEnergyTagSuggestions } from './normalization';
import { getAIDailyPlanningPersistence } from '../workflow-persistence';
import type { EnergySuggestionTask } from '@/db/persistence/daily-planning';

export { normalizeEnergyTagSuggestions } from './normalization';

export async function suggestEnergyTags(taskIds?: string[]): Promise<{
  suggestions: Array<{
    taskId: string;
    title: string;
    energyLevel: 'high' | 'medium' | 'low';
    confidence: number;
    reason: string;
  }>;
  routing?: AIRouteOutcome;
}> {
  const persistence = await getAIDailyPlanningPersistence();
  const suggestions = persistence.energySuggestions;
  let targetTasks: EnergySuggestionTask[];
  if (taskIds && taskIds.length > 0) {
    const existingEnergyMap = await getEnergyTagsForTasks(taskIds);
    const untagged = taskIds.filter(id => !existingEnergyMap.has(id));
    if (untagged.length === 0) return { suggestions: [] };
    targetTasks = await suggestions.listTasksByIds(untagged, 30);
  } else {
    const openTasks = await suggestions.listOpenTopLevelTasks(50);
    const allEnergyMap = await getEnergyTagsForTasks(openTasks.map(task => task.id));
    targetTasks = openTasks.filter(task => !allEnergyMap.has(task.id));
  }

  if (targetTasks.length === 0) return { suggestions: [] };

  const route = await getAsyncAIModel('energy-tag-suggestion', {
    sources: targetTasks.map(task => task.connectorType),
  });
  const taskList = targetTasks.map(task => (
    `- id: ${task.id} | "${task.title}" | priority: ${task.priority} | source: ${task.connectorType}${task.description ? ` | desc: ${task.description.slice(0, 80)}` : ''}`
  )).join('\n');
  const result = await generateText({
    model: route.model,
    system: `You classify tasks by the mental/physical energy they demand.

Categories:
- **high**: Deep work, creative tasks, complex problem-solving, writing, coding new features, strategic planning, difficult conversations
- **medium**: Moderate focus tasks, routine development, reviews, meetings with agendas, organizing, moderate research
- **low**: Administrative tasks, email replies, status updates, simple data entry, filing, routine chores, quick fixes, reading

Rules:
- Classify based on the task title and description
- Be practical — if a task sounds quick and routine, it's low; if it needs sustained concentration, it's high
- Confidence: 0.0-1.0 (only include >= 0.5)
- When uncertain, lean toward "medium"

Return JSON array: [{ "taskId": "...", "energyLevel": "high"|"medium"|"low", "confidence": 0.8, "reason": "brief reason" }]
Return empty array [] if no confident suggestions.`,
    messages: [{ role: 'user', content: `Classify these tasks:\n${taskList}` }],
  });

  return {
    suggestions: normalizeEnergyTagSuggestions(result.text, targetTasks),
    routing: getAsyncAIRouteOutcome(route, result.response),
  };
}
