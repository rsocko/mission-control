import { getAIWorkflowPersistence } from '../workflow-persistence';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import {
  recommendTagsForTask,
  type TagRecommendation,
} from '@/lib/tags/recommendations';

export interface TagInferenceSuggestion {
  taskId: string;
  title: string;
  tags: TagRecommendation[];
  suggestedTags: string[];
  confidence: number;
}

export async function inferTags(): Promise<{
  suggestions: TagInferenceSuggestion[];
  availableTags: Array<{ id: string; name: string }>;
}> {
  const workflowPersistence = await getAIWorkflowPersistence();
  const allTasksList = await workflowPersistence.recommendations.listTagInferenceTasks(50);
  const taggedTaskIds = new Set(
    await workflowPersistence.recommendations.listTaggedTaskIds(),
  );
  const candidateIds = allTasksList
    .filter((task) => !taggedTaskIds.has(task.id))
    .slice(0, 25)
    .map((task) => task.id);

  if (candidateIds.length === 0) {
    return { suggestions: [], availableTags: [] };
  }

  const { taskReads } = await getTaskCorePersistence();
  const inputs = await taskReads.getQuickSortSuggestionInputs(candidateIds);
  const suggestions = inputs.tasks
    .map((task): TagInferenceSuggestion | null => {
      const tags = recommendTagsForTask(task, inputs);
      if (tags.length === 0) return null;
      return {
        taskId: task.id,
        title: task.title,
        tags,
        suggestedTags: tags.map((tag) => tag.name),
        confidence: tags.reduce(
          (total, tag) => total + tag.confidence,
          0,
        ) / tags.length,
      };
    })
    .filter((suggestion): suggestion is TagInferenceSuggestion => Boolean(suggestion))
    .sort((left, right) => (
      right.confidence - left.confidence
      || left.title.localeCompare(right.title)
    ));

  return {
    suggestions,
    availableTags: inputs.tags,
  };
}
