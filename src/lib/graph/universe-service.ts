import 'server-only';

import { count, desc, eq, inArray } from 'drizzle-orm';
import db from '@/db';
import {
  hubProjects,
  tags,
  taskProjects,
  tasks,
  taskTags,
} from '@/db/schema';
import { buildUniverseSubgraph } from './universe-subgraph';
import type {
  UniverseGraphFilters,
  UniverseProjectRecord,
  UniverseSubgraph,
  UniverseTagRecord,
  UniverseTaskRecord,
} from './universe-types';
import { normalizeGraphBudgets } from './query';
import { getCanonicalTaskFilterWhere } from '@/app/api/tasks/canonical-filter';

export async function getUniverseSubgraph(
  filters: UniverseGraphFilters,
): Promise<UniverseSubgraph> {
  const { maxNodes, maxEdges } = normalizeGraphBudgets(filters);
  const { taskWhere } = await getCanonicalTaskFilterWhere(filters.taskQuery);

  const [selectedTasks, totalRows] = await Promise.all([
    db.select({
      id: tasks.id,
      title: tasks.title,
      priority: tasks.priority,
      status: tasks.status,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
      effort: tasks.effort,
    }).from(tasks)
      .where(taskWhere)
      .orderBy(desc(tasks.updatedAt))
      .limit(maxNodes + 1) as Promise<UniverseTaskRecord[]>,
    db.select({ value: count() }).from(tasks).where(taskWhere),
  ]);
  const filteredTaskCount = Number(totalRows[0]?.value ?? 0);

  const hasMoreTasks = selectedTasks.length > maxNodes;
  const boundedTasks = selectedTasks.slice(0, maxNodes);
  const taskIds = boundedTasks.map((task) => task.id);
  let selectedTags: UniverseTagRecord[] = [];
  let selectedProjects: UniverseProjectRecord[] = [];

  if (taskIds.length && filters.dimensions.includes('tags')) {
    selectedTags = await db.select({
      taskId: taskTags.taskId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    }).from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(inArray(taskTags.taskId, taskIds));
  }

  if (taskIds.length && filters.dimensions.includes('project')) {
    selectedProjects = await db.select({
      taskId: taskProjects.taskId,
      id: hubProjects.id,
      name: hubProjects.name,
      color: hubProjects.color,
      status: hubProjects.status,
    }).from(taskProjects)
      .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
      .where(inArray(taskProjects.taskId, taskIds));
  }

  const graph = buildUniverseSubgraph({
    tasks: boundedTasks,
    tags: selectedTags,
    projects: selectedProjects,
    dimensions: filters.dimensions,
    maxNodes,
    maxEdges,
    hasMoreTasks,
  });
  return {
    ...graph,
    stats: {
      ...graph.stats,
      filteredTaskCount,
    },
  };
}
