import 'server-only';

import { asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import db from '@/db';
import {
  connectorConfigs,
  hubProjects,
  projectPhaseItems,
  projectPhases,
  tags,
  taskProjects,
  tasks,
  taskTags,
} from '@/db/schema';
import {
  DEFAULT_TASK_LIMIT,
  DEFAULT_WORD_LIMIT,
  MAX_TASK_LIMIT,
  MAX_VALUES_PER_SOURCE_PER_TASK,
  extractWordInsights,
} from './extract';
import type {
  WordInsightSource,
  WordInsightsResult,
  WordInsightTaskRecord,
  WordSourceValue,
} from './types';
import { WORD_INSIGHT_SOURCES } from './types';

function appendValue(
  valuesByTask: Map<string, WordSourceValue[]>,
  taskId: string,
  value: WordSourceValue,
) {
  const values = valuesByTask.get(taskId);
  if (!values) return;
  const sameSourceValues = values.filter((candidate) => candidate.source === value.source);
  if (
    sameSourceValues.length >= MAX_VALUES_PER_SOURCE_PER_TASK
    || sameSourceValues.some((candidate) => candidate.id === value.id)
  ) return;
  values.push(value);
}

export async function getWordInsights(input: {
  enabledSources?: WordInsightSource[];
  taskLimit?: number;
  wordLimit?: number;
} = {}): Promise<WordInsightsResult> {
  const taskLimit = Math.max(1, Math.min(input.taskLimit ?? DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT));
  const enabledSources = new Set(input.enabledSources ?? WORD_INSIGHT_SOURCES);
  const taskRows = await db.select({
    id: tasks.id,
    title: tasks.title,
    description: tasks.description,
    status: tasks.status,
    sourceListId: tasks.sourceListId,
    sourceListName: tasks.sourceListName,
  }).from(tasks)
    .leftJoin(connectorConfigs, eq(tasks.connectorInstanceId, connectorConfigs.id))
    .where(isNull(connectorConfigs.deletedAt))
    .orderBy(asc(tasks.id))
    .limit(taskLimit + 1);

  const truncated = taskRows.length > taskLimit;
  const boundedTasks = taskRows.slice(0, taskLimit);
  const taskIds = boundedTasks.map((task) => task.id);
  const valuesByTask = new Map<string, WordSourceValue[]>(
    boundedTasks.map((task) => {
      const values: WordSourceValue[] = [];
      if (enabledSources.has('title')) values.push({
        source: 'title',
        id: task.id,
        label: 'Task title',
        text: task.title,
      });
      if (enabledSources.has('notes') && task.description) values.push({
        source: 'notes',
        id: task.id,
        label: 'Task notes',
        text: task.description,
      });
      if (enabledSources.has('list') && task.sourceListName) values.push({
        source: 'list',
        id: task.sourceListId ?? task.sourceListName,
        label: task.sourceListName,
        text: task.sourceListName,
      });
      return [task.id, values];
    }),
  );

  if (taskIds.length > 0) {
    const rankedTags = db.select({
      taskId: taskTags.taskId,
      id: tags.id,
      name: tags.name,
      rank: sql<number>`row_number() over (
        partition by ${taskTags.taskId}
        order by ${tags.name}, ${tags.id}
      )`.as('source_rank'),
    }).from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(inArray(taskTags.taskId, taskIds))
      .as('ranked_word_insight_tags');
    const rankedProjects = db.select({
      taskId: taskProjects.taskId,
      id: hubProjects.id,
      name: hubProjects.name,
      rank: sql<number>`row_number() over (
        partition by ${taskProjects.taskId}
        order by ${hubProjects.name}, ${hubProjects.id}
      )`.as('source_rank'),
    }).from(taskProjects)
      .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
      .where(inArray(taskProjects.taskId, taskIds))
      .as('ranked_word_insight_projects');
    const rankedPhases = db.select({
      taskId: projectPhaseItems.taskId,
      id: projectPhases.id,
      name: projectPhases.name,
      rank: sql<number>`row_number() over (
        partition by ${projectPhaseItems.taskId}
        order by ${projectPhases.name}, ${projectPhases.id}
      )`.as('source_rank'),
    }).from(projectPhaseItems)
      .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
      .where(inArray(projectPhaseItems.taskId, taskIds))
      .as('ranked_word_insight_phases');
    const relationshipLimit = taskIds.length * MAX_VALUES_PER_SOURCE_PER_TASK;
    const [tagRows, projectRows, phaseRows] = await Promise.all([
      enabledSources.has('tag')
        ? db.select({
            taskId: rankedTags.taskId,
            id: rankedTags.id,
            name: rankedTags.name,
          }).from(rankedTags)
            .where(lte(rankedTags.rank, MAX_VALUES_PER_SOURCE_PER_TASK))
            .orderBy(asc(rankedTags.taskId), asc(rankedTags.name), asc(rankedTags.id))
            .limit(relationshipLimit)
        : Promise.resolve([]),
      enabledSources.has('project')
        ? db.select({
            taskId: rankedProjects.taskId,
            id: rankedProjects.id,
            name: rankedProjects.name,
          }).from(rankedProjects)
            .where(lte(rankedProjects.rank, MAX_VALUES_PER_SOURCE_PER_TASK))
            .orderBy(asc(rankedProjects.taskId), asc(rankedProjects.name), asc(rankedProjects.id))
            .limit(relationshipLimit)
        : Promise.resolve([]),
      enabledSources.has('phase')
        ? db.select({
            taskId: rankedPhases.taskId,
            id: rankedPhases.id,
            name: rankedPhases.name,
          }).from(rankedPhases)
            .where(lte(rankedPhases.rank, MAX_VALUES_PER_SOURCE_PER_TASK))
            .orderBy(asc(rankedPhases.taskId), asc(rankedPhases.name), asc(rankedPhases.id))
            .limit(relationshipLimit)
        : Promise.resolve([]),
    ]);

    for (const row of tagRows) {
      appendValue(valuesByTask, row.taskId, {
        source: 'tag',
        id: row.id,
        label: row.name,
        text: row.name,
      });
    }
    for (const row of projectRows) {
      appendValue(valuesByTask, row.taskId, {
        source: 'project',
        id: row.id,
        label: row.name,
        text: row.name,
      });
    }
    for (const row of phaseRows) {
      appendValue(valuesByTask, row.taskId, {
        source: 'phase',
        id: row.id,
        label: row.name,
        text: row.name,
      });
    }
  }

  const records: WordInsightTaskRecord[] = boundedTasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    values: valuesByTask.get(task.id) ?? [],
  }));

  return extractWordInsights({
    records,
    enabledSources: input.enabledSources,
    taskLimit,
    wordLimit: input.wordLimit ?? DEFAULT_WORD_LIMIT,
    truncated,
  });
}
