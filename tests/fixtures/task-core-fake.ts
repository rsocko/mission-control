import type {
  TaskCorePersistence,
  TaskReadRepository,
} from '@/lib/tasks/core/contracts';
import {
  clearTaskCorePersistence,
  registerTaskCorePersistence,
} from '@/lib/tasks/core/runtime';

/**
 * Minimal task-core composition for route tests. L04 canonical-filter inputs
 * and L05 endpoint reads are supplied through typed portable repositories,
 * without requiring route tests to emulate Drizzle query chains.
 */
export interface FakeTaskCoreInputs {
  myDayTaskIds?: string[];
  assignedGitHubUsernames?: string[];
  inboxListEntries?: Array<{
    connectorType: string;
    sourceListId?: string;
    sourceListName?: string;
  }>;
  taskReads?: Partial<TaskReadRepository>;
}

export function createFakeTaskReadRepository(
  overrides: Partial<TaskReadRepository> = {},
): TaskReadRepository {
  return {
    getAttachmentReadContext: async () => ({ task: null, attachment: null }),
    getDocumentPreviewContext: async () => ({ task: null, connector: null }),
    listLinkedSources: async () => [],
    searchRelationshipCandidates: async () => null,
    listDuplicateDetectionTasks: async () => [],
    listDistinctTaskAssignees: async () => [],
    getGroupCounts: async () => ({}),
    listQuickSortSources: async () => ({ rows: [], definitions: [] }),
    getQuickSortCounts: async () => ({
      no_priority: 0,
      quadrant: 0,
      no_effort: 0,
      no_tags: 0,
      no_planning_horizon: 0,
    }),
    listQuickSortTasks: async () => [],
    getQuickSortSuggestionInputs: async () => ({
      tasks: [],
      sourceRankings: [],
      tags: [],
      taskTags: [],
    }),
    ...overrides,
  };
}

export function registerFakeTaskCorePersistence(
  inputs: FakeTaskCoreInputs = {},
): void {
  registerTaskCorePersistence({
    taskReads: createFakeTaskReadRepository(inputs.taskReads),
    filterInputs: {
      listMyDayTaskIds: async () => inputs.myDayTaskIds ?? [],
      listAssignedGitHubUsernames: async () => inputs.assignedGitHubUsernames ?? [],
      listInboxListEntries: async () => inputs.inboxListEntries ?? [],
    },
    priorityEntities: {
      listPriorityEntitiesByRank: async () => [],
      getProjectReference: async () => null,
      getTagReference: async () => null,
      getSourceListReference: async () => null,
      listProjectReferences: async () => [],
      listTagReferences: async () => [],
      listSourceListReferences: async () => [],
    },
    sourceListNames: {
      listSourceListDisplayNames: async () => [],
    },
  } as unknown as TaskCorePersistence);
}

export { clearTaskCorePersistence };
