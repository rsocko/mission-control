import 'server-only';

import { buildUniverseSubgraph } from './universe-subgraph';
import type {
  UniverseGraphFilters,
  UniverseProjectRecord,
  UniverseSubgraph,
  UniverseTagRecord,
  UniverseTaskRecord,
} from './universe-types';
import { normalizeGraphBudgets } from './query';
import {
  isUniverseClustersEnabled,
  isUniverseSemanticNeighborsEnabled,
} from './universe-semantic-config';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { requireGraphReportingPersistence } from '@/db/persistence/worker-repositories';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { buildTaskFilterSpec } from '@/lib/tasks/core/filter-spec';
import { normalizedCsv } from '@/app/api/tasks/query-input';
import { getLocalDaysFromNow, getLocalToday } from '@/lib/utils/date';
import { NEXT_7_DAYS } from '@/lib/tasks/due-window';

export async function getGraphReportingPersistence() {
  return requireGraphReportingPersistence(await getWorkerPersistenceRepositories());
}

async function universeFilterInput(taskQuery: URLSearchParams) {
  const today = getLocalToday();
  const spec = buildTaskFilterSpec(taskQuery, {
    readCsv: normalizedCsv,
    clock: {
      today,
      weekFromNow: getLocalDaysFromNow(NEXT_7_DAYS),
      recentCutoff: getLocalDaysFromNow(-7),
    },
  });
  const { filterInputs } = await getTaskCorePersistence();
  return {
    spec,
    filterInputs: {
      myDayTaskIds: await filterInputs.listMyDayTaskIds(spec.myDayDate),
      assignedGitHubUsernames: await filterInputs.listAssignedGitHubUsernames(),
      inboxListEntries: await filterInputs.listInboxListEntries(),
    },
  };
}

export async function getUniverseSubgraph(
  filters: UniverseGraphFilters,
): Promise<UniverseSubgraph> {
  const { maxNodes, maxEdges } = normalizeGraphBudgets(filters);
  const filter = await universeFilterInput(filters.taskQuery);
  const boundedSeedIds = filters.seedTaskIds?.slice(0, 10);
  const repository = (await getGraphReportingPersistence()).universe;
  const rows = await repository.read({
    ...filter,
    seedTaskIds: boundedSeedIds,
    maxNodes,
    includeTags: filters.dimensions.includes('tags'),
    includeProjects: filters.dimensions.includes('project'),
  });

  const graph = buildUniverseSubgraph({
    tasks: rows.tasks as UniverseTaskRecord[],
    tags: rows.tags as UniverseTagRecord[],
    projects: rows.projects as UniverseProjectRecord[],
    dimensions: filters.dimensions,
    maxNodes,
    maxEdges,
    hasMoreTasks: rows.hasMoreTasks,
  });
  return {
    ...graph,
    capabilities: {
      semanticNeighbors: isUniverseSemanticNeighborsEnabled(),
      clusters: isUniverseClustersEnabled(),
    },
    stats: {
      ...graph.stats,
      filteredTaskCount: rows.filteredTaskCount,
    },
  };
}
