import { syncLogger } from '@/lib/logger';

let searchModulePromise: Promise<typeof import('@/lib/search') | null> | undefined;

export function getSearchModule() {
  if (!searchModulePromise) {
    searchModulePromise = import('@/lib/search').catch(() => null);
  }
  return searchModulePromise;
}

/**
 * Pre-warm search indexes after sync completes.
 * Ensures the first Ctrl+K search has no cold-start delay.
 */
export async function warmUpSearchAfterSync() {
  const search = await getSearchModule();
  await search?.warmUpSearch().catch((e) => {
    syncLogger.error({ err: e }, 'warmUpSearch failed');
  });
}

export type SearchableTask = {
  id: string;
  title: string;
  description?: string | null;
  sourceListName?: string | null;
  connectorType?: string | null;
  status?: string | null;
  priority?: string | null;
  updatedAt?: string | null;
};

export async function indexTaskForSearch(task: SearchableTask) {
  const search = await getSearchModule();
  await search?.indexTaskSearch(task).catch((e) => { syncLogger.error({ err: e, taskId: task.id }, 'indexTaskSearch failed'); });
}

/**
 * Batch-index multiple tasks for search. Defers embedding generation
 * to avoid blocking the event loop during sync.
 */
export async function indexTasksForSearchBatch(taskBatch: SearchableTask[]) {
  if (taskBatch.length === 0) return;
  const search = await getSearchModule();
  if (!search) return;

  for (const task of taskBatch) {
    try {
      await search.indexTaskSearch(task);
    } catch (e) {
      syncLogger.error({ err: e, taskId: task.id }, 'indexTaskSearch failed');
    }
  }
}

export async function indexAlertForSearch(alert: {
  id: string;
  title: string;
  body?: string | null;
  category?: string | null;
  severity?: string | null;
  isRead?: boolean | null;
  isActionable?: boolean | null;
  connectorType?: string | null;
  receivedAt?: string | null;
}) {
  const search = await getSearchModule();
  await search?.indexAlertSearch(alert).catch((e) => { syncLogger.error({ err: e, alertId: alert.id }, 'indexAlertSearch failed'); });
}
