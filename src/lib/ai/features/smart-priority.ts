import { generateText } from 'ai';
import db from '@/db';
import { tasks } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { getAIModel, getAIRouteOutcome } from '../provider-factory';
import type { AIRouteOutcome } from '../types';
import { normalizeSmartPriorityRankings } from './normalization';

export { normalizeSmartPriorityRankings } from './normalization';

export async function computeSmartPriority(): Promise<{
  rankings: Array<{ taskId: string; title: string; score: number; reason: string }>;
  routing?: AIRouteOutcome;
}> {
  const today = getLocalToday();
  const openTasks = await db.select().from(tasks)
    .where(eq(tasks.status, 'todo'))
    .orderBy(desc(tasks.updatedAt))
    .limit(30);

  if (openTasks.length === 0) return { rankings: [] };

  const route = getAIModel('smart-priority', {
    sources: openTasks.map(task => task.connectorType),
  });
  const taskList = openTasks.map((t, i) => (
    `${i + 1}. "${t.title}" | priority: ${t.priority} | due: ${t.dueDate || 'none'} | source: ${t.connectorType} | list: ${t.sourceListName || 'default'}`
  )).join('\n');
  const result = await generateText({
    model: route.model,
    system: 'You are a productivity prioritization engine. Given a list of tasks, score each 1-100 (100=most urgent) and give a brief reason. Respond ONLY in JSON format: {"rankings": [{"index": 1, "score": 85, "reason": "overdue by 3 days"}]}',
    messages: [{ role: 'user', content: `Today is ${today}. Rank these tasks by urgency/importance:\n\n${taskList}` }],
  });

  return {
    rankings: normalizeSmartPriorityRankings(result.text, openTasks, today),
    routing: getAIRouteOutcome(route.context, result.response),
  };
}
