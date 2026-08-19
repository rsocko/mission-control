import { generateText } from 'ai';
import db from '@/db';
import { tasks } from '@/db/schema';
import { inArray, sql } from 'drizzle-orm';
import { getAIModel, getAIRouteOutcome } from '../provider-factory';
import type { AIRouteOutcome } from '../types';
import { getEnergyTagsForTasks } from './energy-tag-queries';
import { normalizeEnergyTagSuggestions } from './normalization';

type EnergyTask = {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  connectorType: string;
};

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
  let targetTasks: EnergyTask[];
  if (taskIds && taskIds.length > 0) {
    const existingEnergyMap = await getEnergyTagsForTasks(taskIds);
    const untagged = taskIds.filter(id => !existingEnergyMap.has(id));
    if (untagged.length === 0) return { suggestions: [] };
    targetTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      connectorType: tasks.connectorType,
    })
      .from(tasks)
      .where(inArray(tasks.id, untagged))
      .limit(30);
  } else {
    const openTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      connectorType: tasks.connectorType,
    })
      .from(tasks)
      .where(sql`${tasks.status} NOT IN ('done', 'cancelled') AND ${tasks.depth} = 0`)
      .limit(50);
    const allEnergyMap = await getEnergyTagsForTasks(openTasks.map(task => task.id));
    targetTasks = openTasks.filter(task => !allEnergyMap.has(task.id));
  }

  if (targetTasks.length === 0) return { suggestions: [] };

  const route = getAIModel('energy-tag-suggestion', {
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
    routing: getAIRouteOutcome(route.context, result.response),
  };
}
