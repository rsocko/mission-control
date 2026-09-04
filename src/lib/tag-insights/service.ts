import 'server-only';

import type { TagInsightsAnalyticsRepository } from '@/db/persistence/analytics';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { buildTagInsights, normalizeTagInsightOptions } from './aggregate';
import type { TagInsightOptions } from './aggregate';
import type { TagInsightRecord, TagInsights } from './types';

async function tagInsightsRepository(): Promise<TagInsightsAnalyticsRepository> {
  return (await getWorkerPersistenceRepositories()).analytics.tagInsights;
}

export async function getTagInsights(
  requestedOptions: Partial<TagInsightOptions> = {},
): Promise<TagInsights> {
  const options = normalizeTagInsightOptions(requestedOptions);
  const repository = await tagInsightsRepository();
  const syntheticCandidates = await repository.listSyntheticTagCandidates();
  const syntheticTagIds = syntheticCandidates
    .filter((tag) => isSyntheticTag(tag.name))
    .map((tag) => tag.id);

  const boundedTasks = await repository.listBoundedTaggedTasks(
    syntheticTagIds,
    options.taskLimit + 1,
  );

  const includedTasks = boundedTasks.slice(0, options.taskLimit);
  if (includedTasks.length === 0) {
    return buildTagInsights([], options);
  }

  const includedTaskIds = includedTasks.map((task) => task.id);
  const topTags = await repository.listTopTags(
    includedTaskIds,
    syntheticTagIds,
    options.topN,
  );

  const selectedTags = topTags.filter((tag) => !isSyntheticTag(tag.name));
  if (selectedTags.length === 0) {
    return buildTagInsights([], options);
  }

  const selectedTagsById = new Map(selectedTags.map((tag) => [tag.id, tag]));
  const taskById = new Map(includedTasks.map((task) => [task.id, task]));
  const linkedRecords = await repository.listTaskTagLinks(
    includedTaskIds,
    selectedTags.map((tag) => tag.id),
  );

  const records: TagInsightRecord[] = linkedRecords.map((record) => {
    const task = taskById.get(record.taskId);
    const tag = selectedTagsById.get(record.tagId);
    if (!task || !tag) {
      throw new Error('Tag insight records changed during aggregation');
    }
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      tagId: tag.id,
      tagName: tag.name,
      tagColor: tag.color,
    };
  });

  const insights = buildTagInsights(records, options);
  return {
    ...insights,
    meta: {
      ...insights.meta,
      processedTaskCount: includedTasks.length,
      truncated: boundedTasks.length > options.taskLimit,
    },
  };
}
