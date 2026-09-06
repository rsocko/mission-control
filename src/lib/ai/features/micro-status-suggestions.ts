import { generateText } from 'ai';
import { getLocalToday } from '@/lib/utils/date';
import {
  getAsyncAIModel,
  getAsyncAIRouteOutcome,
} from '../provider-runtime';
import type { AIRouteOutcome } from '../types';
import { normalizeMicroStatusSuggestions } from './normalization';
import { getAIWorkflowPersistence } from '../workflow-persistence';

export { normalizeMicroStatusSuggestions } from './normalization';

export async function suggestMicroStatuses(): Promise<{
  suggestions: Array<{
    taskId: string;
    title: string;
    suggestedStatus: string;
    confidence: number;
    reason: string;
  }>;
  routing?: AIRouteOutcome;
}> {
  const today = getLocalToday();
  const now = new Date();
  const openTasks = await (await getAIWorkflowPersistence())
    .recommendations.listMicroStatusTasks(30);

  if (openTasks.length === 0) return { suggestions: [] };

  const taskSummaries = openTasks.map(task => {
    const ageDays = Math.floor((now.getTime() - new Date(task.createdAt).getTime()) / 86400000);
    const staleDays = Math.floor((now.getTime() - new Date(task.updatedAt).getTime()) / 86400000);
    return `- "${task.title}" | status: ${task.status} | micro: ${task.microStatus || 'none'} | priority: ${task.priority} | age: ${ageDays}d | stale: ${staleDays}d | due: ${task.dueDate || 'none'} | assignee: ${task.assignee || 'none'} | source: ${task.connectorType} | id: ${task.id}`;
  }).join('\n');
  const route = await getAsyncAIModel('micro-status-suggestion', {
    sources: openTasks.map(task => task.connectorType),
  });
  const result = await generateText({
    model: route.model,
    system: `You analyze open tasks and suggest micro-statuses. Available micro-statuses:
- waiting_on_someone: Blocked waiting for a response from another person
- need_to_think: Requires reflection or planning before acting
- started_but_stuck: Work began but hit a wall
- ready_but_unmotivated: Could start anytime, just not feeling it
- done_needs_review: Work complete, awaiting review
- blocked_external: Blocked by external dependency or system
- in_research: Actively researching or exploring approaches

Rules:
- Only suggest for tasks that clearly match a pattern (stale + no updates = likely stuck, has assignee + no progress = waiting, etc.)
- Skip tasks that already have appropriate micro-statuses
- Confidence: 0.0-1.0 (only include suggestions with >= 0.5)
- Be conservative — don't over-suggest

Return JSON array: [{ "taskId": "...", "suggestedStatus": "...", "confidence": 0.8, "reason": "..." }]
Return empty array [] if no confident suggestions.`,
    messages: [{
      role: 'user',
      content: `Today: ${today}\n\nOpen tasks:\n${taskSummaries}`,
    }],
  });

  return {
    suggestions: normalizeMicroStatusSuggestions(result.text, openTasks),
    routing: getAsyncAIRouteOutcome(route, result.response),
  };
}
