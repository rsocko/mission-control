import type {
  TaskCorePersistence,
  TaskCollectionReadRepository,
  TaskCreateRepository,
  TaskDetailReadRepository,
  TaskMutationRepository,
  TaskRemovalRepository,
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
  collections?: Partial<TaskCollectionReadRepository>;
  details?: Partial<TaskDetailReadRepository>;
  creates?: Partial<TaskCreateRepository>;
  mutations?: Partial<TaskMutationRepository>;
  removals?: Partial<TaskRemovalRepository>;
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
    collections: {
      readTaskCollection: async () => ({
        rows: [],
        total: 0,
        stats: {
          totalOpen: 0,
          overdue: 0,
          dueToday: 0,
          dueThisWeek: 0,
          noDate: 0,
          highPriority: 0,
          assignedToMe: 0,
          myDay: 0,
          recentlyCreated: 0,
          recentlyClosed: 0,
          waiting: 0,
          inbox: 0,
        },
        sourceCounts: {},
        availableTags: [],
        connectorContexts: [],
        smartScore: null,
      }),
      ...inputs.collections,
    },
    details: {
      getTaskDetail: async () => null,
      ...inputs.details,
    },
    creates: {
      resolveTaskCreateTarget: async () => ({ kind: 'connector-not-found' }),
      createTask: async () => ({ kind: 'connector-not-found' }),
      ...inputs.creates,
    },
    mutations: {
      getTaskWriteContext: async () => null,
      mutateTask: async () => ({ kind: 'not-found' }),
      ...inputs.mutations,
    },
    removals: {
      getTaskRemovalContext: async () => null,
      applyTaskRemoval: async () => ({ kind: 'not-found' }),
      finalizeRemoteTaskRemoval: async () => ({ kind: 'not-found' }),
      ...inputs.removals,
    },
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
