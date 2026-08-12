import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import type {
  TagInsightPair,
  TagInsightRecord,
  TagInsights,
} from './types';

export const TAG_INSIGHT_DEFAULTS = {
  topN: 15,
  minCooccurrence: 2,
  taskLimit: 2_000,
} as const;

export const TAG_INSIGHT_LIMITS = {
  topN: { min: 1, max: 30 },
  minCooccurrence: { min: 1, max: 100 },
  taskLimit: { min: 1, max: 5_000 },
} as const;

export interface TagInsightOptions {
  topN: number;
  minCooccurrence: number;
  taskLimit: number;
}

function compareText(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function boundedInteger(
  value: number | string | null | undefined,
  fallback: number,
  limits: { min: number; max: number },
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), limits.min), limits.max);
}

export function normalizeTagInsightOptions(input: {
  topN?: number | string | null;
  minCooccurrence?: number | string | null;
  taskLimit?: number | string | null;
}): TagInsightOptions {
  return {
    topN: boundedInteger(input.topN, TAG_INSIGHT_DEFAULTS.topN, TAG_INSIGHT_LIMITS.topN),
    minCooccurrence: boundedInteger(
      input.minCooccurrence,
      TAG_INSIGHT_DEFAULTS.minCooccurrence,
      TAG_INSIGHT_LIMITS.minCooccurrence,
    ),
    taskLimit: boundedInteger(
      input.taskLimit,
      TAG_INSIGHT_DEFAULTS.taskLimit,
      TAG_INSIGHT_LIMITS.taskLimit,
    ),
  };
}

export function makeTagPairKey(firstTagId: string, secondTagId: string): string {
  return JSON.stringify([firstTagId, secondTagId].sort(compareText));
}

export function buildTagInsights(
  records: TagInsightRecord[],
  requestedOptions: Partial<TagInsightOptions> = {},
): TagInsights {
  const options = normalizeTagInsightOptions(requestedOptions);
  const taskOrder: string[] = [];
  const taskIndexes = new Map<string, number>();
  const tasks = new Map<string, { id: string; title: string; status: string }>();
  const taskTags = new Map<string, Map<string, {
    id: string;
    name: string;
    color: string | null;
  }>>();

  for (const record of records) {
    if (isSyntheticTag(record.tagName)) continue;
    if (!tasks.has(record.taskId)) {
      taskIndexes.set(record.taskId, taskOrder.length);
      taskOrder.push(record.taskId);
      tasks.set(record.taskId, {
        id: record.taskId,
        title: record.taskTitle,
        status: record.taskStatus,
      });
    }
    if ((taskIndexes.get(record.taskId) ?? options.taskLimit) >= options.taskLimit) continue;
    const tagsForTask = taskTags.get(record.taskId) ?? new Map();
    tagsForTask.set(record.tagId, {
      id: record.tagId,
      name: record.tagName,
      color: record.tagColor,
    });
    taskTags.set(record.taskId, tagsForTask);
  }

  const includedTaskIds = taskOrder.slice(0, options.taskLimit);
  const tagTasks = new Map<string, {
    id: string;
    name: string;
    color: string | null;
    taskIds: Set<string>;
  }>();

  for (const taskId of includedTaskIds) {
    for (const tag of taskTags.get(taskId)?.values() ?? []) {
      const entry = tagTasks.get(tag.id) ?? { ...tag, taskIds: new Set<string>() };
      entry.taskIds.add(taskId);
      tagTasks.set(tag.id, entry);
    }
  }

  const tags = Array.from(tagTasks.values())
    .sort((a, b) =>
      b.taskIds.size - a.taskIds.size
      || compareText(a.name, b.name)
      || compareText(a.id, b.id))
    .slice(0, options.topN)
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      taskCount: tag.taskIds.size,
      taskIds: Array.from(tag.taskIds).sort(compareText),
    }));

  const selectedTagIds = new Set(tags.map((tag) => tag.id));
  const pairsByKey = new Map<string, TagInsightPair>();
  for (const taskId of includedTaskIds) {
    const tagIds = Array.from(taskTags.get(taskId)?.keys() ?? [])
      .filter((tagId) => selectedTagIds.has(tagId))
      .sort(compareText);
    for (let firstIndex = 0; firstIndex < tagIds.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < tagIds.length; secondIndex++) {
        const sourceTagId = tagIds[firstIndex];
        const targetTagId = tagIds[secondIndex];
        const key = makeTagPairKey(sourceTagId, targetTagId);
        const pair = pairsByKey.get(key) ?? {
          key,
          sourceTagId,
          targetTagId,
          count: 0,
          taskIds: [],
        };
        pair.count += 1;
        pair.taskIds.push(taskId);
        pairsByKey.set(key, pair);
      }
    }
  }

  const pairs = Array.from(pairsByKey.values())
    .filter((pair) => pair.count >= options.minCooccurrence)
    .sort((a, b) =>
      compareText(a.sourceTagId, b.sourceTagId)
      || compareText(a.targetTagId, b.targetTagId));

  const taskDictionary = Object.fromEntries(
    includedTaskIds
      .map((taskId) => tasks.get(taskId))
      .filter((task): task is NonNullable<typeof task> => Boolean(task))
      .map((task) => [task.id, task]),
  );

  return {
    tags,
    pairs,
    tasks: taskDictionary,
    meta: {
      ...options,
      processedTaskCount: includedTaskIds.length,
      truncated: taskOrder.length > options.taskLimit,
    },
  };
}
