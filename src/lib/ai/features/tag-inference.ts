import { generateText } from 'ai';
import db from '@/db';
import { tags, tasks, taskTags } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getAIModel, getAIRouteOutcome } from '../provider-factory';
import type { AIRouteOutcome } from '../types';

export async function inferTags(): Promise<{
  suggestions: Array<{ taskId: string; title: string; suggestedTags: string[]; confidence: number }>;
  routing?: AIRouteOutcome;
}> {
  const allTasksList = await db.select().from(tasks).where(eq(tasks.status, 'todo')).limit(50);
  const allTagRecords = await db.select().from(taskTags);
  const taggedTaskIds = new Set(allTagRecords.map(taskTag => taskTag.taskId));
  const untagged = allTasksList.filter(task => !taggedTaskIds.has(task.id)).slice(0, 15);

  if (untagged.length === 0) return { suggestions: [] };

  const availableTags = await db.select().from(tags);
  const tagNames = availableTags.map(tag => tag.name);
  const route = getAIModel('tag-inference', {
    sources: untagged.map(task => task.connectorType),
  });
  const taskList = untagged.map((task, index) => (
    `${index + 1}. "${task.title}" (source: ${task.connectorType}, list: ${task.sourceListName || 'default'})`
  )).join('\n');
  const result = await generateText({
    model: route.model,
    system: `You suggest tags for tasks. Available tags: ${tagNames.join(', ')}. You may also suggest new tags if none fit. Respond ONLY in JSON: {"suggestions": [{"index": 1, "tags": ["work", "urgent"], "confidence": 0.8}]}`,
    messages: [{ role: 'user', content: `Suggest tags for these tasks:\n\n${taskList}` }],
  });
  const routing = getAIRouteOutcome(route.context, result.response);

  try {
    const parsed = JSON.parse(result.text) as {
      suggestions?: Array<{ index: number; tags: string[]; confidence: number }>;
    };
    return {
      suggestions: (parsed.suggestions || []).map(suggestion => ({
        taskId: untagged[suggestion.index - 1]?.id || '',
        title: untagged[suggestion.index - 1]?.title || '',
        suggestedTags: suggestion.tags,
        confidence: suggestion.confidence,
      })).filter(suggestion => suggestion.taskId),
      routing,
    };
  } catch {
    return { suggestions: [], routing };
  }
}
