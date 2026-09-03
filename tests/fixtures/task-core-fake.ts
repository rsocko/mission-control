import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';
import {
  clearTaskCorePersistence,
  registerTaskCorePersistence,
} from '@/lib/tasks/core/runtime';

/**
 * Minimal task-core composition for route tests that mock `@/db` outright.
 *
 * Since L04 the canonical filter reads its stored inputs (My Day membership,
 * GitHub identity, inbox lists) through the portable task-core repositories
 * rather than a Drizzle handle, so a test that replaces `@/db` with a stub
 * must supply those inputs here instead.
 */
export interface FakeTaskCoreInputs {
  myDayTaskIds?: string[];
  assignedGitHubUsernames?: string[];
  inboxListEntries?: Array<{
    connectorType: string;
    sourceListId?: string;
    sourceListName?: string;
  }>;
}

export function registerFakeTaskCorePersistence(
  inputs: FakeTaskCoreInputs = {},
): void {
  registerTaskCorePersistence({
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
