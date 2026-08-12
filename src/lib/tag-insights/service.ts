import 'server-only';

import { and, asc, countDistinct, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import db from '@/db';
import { tags, tasks, taskTags } from '@/db/schema';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { buildTagInsights, normalizeTagInsightOptions } from './aggregate';
import type { TagInsightOptions } from './aggregate';
import type { TagInsightRecord, TagInsights } from './types';

export async function getTagInsights(
  requestedOptions: Partial<TagInsightOptions> = {},
): Promise<TagInsights> {
  const options = normalizeTagInsightOptions(requestedOptions);
  const normalizedTagName = sql`lower(trim(${tags.name}))`;
  const syntheticCandidates = await db.select({
    id: tags.id,
    name: tags.name,
  })
    .from(tags)
    .where(sql`
      ${normalizedTagName} LIKE 'priority%'
      OR ${normalizedTagName} IN ('p0', 'p1', 'p2', 'p3')
      OR ${normalizedTagName} LIKE 'effort%'
      OR ${normalizedTagName} LIKE 'size%'
      OR ${normalizedTagName} LIKE 'estimate%'
      OR ${normalizedTagName} LIKE 't-shirt%'
      OR ${normalizedTagName} LIKE 'mc:%'
    `);
  const syntheticTagIds = syntheticCandidates
    .filter((tag) => isSyntheticTag(tag.name))
    .map((tag) => tag.id);

  const taggedTaskCondition = syntheticTagIds.length > 0
    ? notInArray(taskTags.tagId, syntheticTagIds)
    : undefined;
  const boundedTasks = await db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
  })
    .from(tasks)
    .innerJoin(taskTags, eq(taskTags.taskId, tasks.id))
    .where(taggedTaskCondition)
    .groupBy(tasks.id, tasks.title, tasks.status)
    .orderBy(asc(tasks.id))
    .limit(options.taskLimit + 1);

  const includedTasks = boundedTasks.slice(0, options.taskLimit);
  if (includedTasks.length === 0) {
    return buildTagInsights([], options);
  }

  const includedTaskIds = includedTasks.map((task) => task.id);
  const usageCount = countDistinct(taskTags.taskId);
  const topTags = await db.select({
    id: tags.id,
    name: tags.name,
    color: tags.color,
    usageCount,
  })
    .from(tags)
    .innerJoin(taskTags, eq(taskTags.tagId, tags.id))
    .where(and(
      inArray(taskTags.taskId, includedTaskIds),
      taggedTaskCondition,
    ))
    .groupBy(tags.id, tags.name, tags.color)
    .orderBy(desc(usageCount), asc(tags.name), asc(tags.id))
    .limit(options.topN);

  const selectedTags = topTags.filter((tag) => !isSyntheticTag(tag.name));
  if (selectedTags.length === 0) {
    return buildTagInsights([], options);
  }

  const selectedTagsById = new Map(selectedTags.map((tag) => [tag.id, tag]));
  const taskById = new Map(includedTasks.map((task) => [task.id, task]));
  const linkedRecords = await db.select({
    taskId: taskTags.taskId,
    tagId: taskTags.tagId,
  })
    .from(taskTags)
    .where(and(
      inArray(taskTags.taskId, includedTaskIds),
      inArray(taskTags.tagId, selectedTags.map((tag) => tag.id)),
    ))
    .orderBy(asc(taskTags.taskId), asc(taskTags.tagId));

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
