import 'server-only';

import type { WordInsightsAnalyticsRepository } from '@/db/persistence/analytics';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
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

async function wordInsightsRepository(): Promise<WordInsightsAnalyticsRepository> {
  return (await getWorkerPersistenceRepositories()).analytics.wordInsights;
}

export async function getWordInsights(input: {
  enabledSources?: WordInsightSource[];
  taskLimit?: number;
  wordLimit?: number;
} = {}): Promise<WordInsightsResult> {
  const taskLimit = Math.max(1, Math.min(input.taskLimit ?? DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT));
  const enabledSources = new Set(input.enabledSources ?? WORD_INSIGHT_SOURCES);
  const repository = await wordInsightsRepository();
  const taskRows = await repository.listTasksWithLiveConnector(taskLimit + 1);

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
    const relationshipLimit = taskIds.length * MAX_VALUES_PER_SOURCE_PER_TASK;
    const [tagRows, projectRows, phaseRows] = await Promise.all([
      enabledSources.has('tag')
        ? repository.listRankedTaskTags(
          taskIds,
          MAX_VALUES_PER_SOURCE_PER_TASK,
          relationshipLimit,
        )
        : Promise.resolve([]),
      enabledSources.has('project')
        ? repository.listRankedTaskProjects(
          taskIds,
          MAX_VALUES_PER_SOURCE_PER_TASK,
          relationshipLimit,
        )
        : Promise.resolve([]),
      enabledSources.has('phase')
        ? repository.listRankedTaskPhases(
          taskIds,
          MAX_VALUES_PER_SOURCE_PER_TASK,
          relationshipLimit,
        )
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
