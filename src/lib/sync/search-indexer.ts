import { syncLogger } from '@/lib/logger';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

let searchModulePromise: Promise<typeof import('@/lib/search') | null> | undefined;

export function getSearchModule() {
  if (!searchModulePromise) {
    searchModulePromise = import('@/lib/search').catch(() => null);
  }

  return searchModulePromise;
}

async function allowsSemanticSearch(): Promise<boolean> {
  return (await getWorkerPersistenceRepositories()).execution.support
    .allowsLegacyWorkflow('semantic-search');
}

async function publishSemantic(
  kind: 'upsert' | 'delete',
  entityType: 'task' | 'alert',
  entityId: string,
): Promise<void> {
  const {
    publishSemanticEntityDelete,
    publishSemanticEntityUpsert,
  } = await import('@/lib/semantic-index/publication');
  if (kind === 'upsert') await publishSemanticEntityUpsert(entityType, entityId);
  else await publishSemanticEntityDelete(entityType, entityId);
}

/**
 * Pre-warm search indexes after sync completes.
 * Ensures the first Ctrl+K search has no cold-start delay.
 */
export async function warmUpSearchAfterSync() {
  if (!(await allowsSemanticSearch()) || process.env.MC_DATABASE_BACKEND === 'postgres') {
    const { warmUpFTS } = await import('@/lib/search/fts');
    await warmUpFTS();
    return;
  }
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
  if (process.env.MC_DATABASE_BACKEND === 'postgres') {
    const { indexTask } = await import('@/lib/search/fts');
    await indexTask(task);
    await publishSemantic('upsert', 'task', task.id);
    return;
  }
  if (!(await allowsSemanticSearch())) {
    const { indexTask } = await import('@/lib/search/fts');
    await indexTask(task);
    return;
  }
  const search = await getSearchModule();
  await search?.indexTaskSearch(task).catch((e) => { syncLogger.error({ err: e, taskId: task.id }, 'indexTaskSearch failed'); });
}

/**
 * Batch-index multiple tasks for search. Defers embedding generation
 * to avoid blocking the event loop during sync.
 */
export async function indexTasksForSearchBatch(taskBatch: SearchableTask[]) {
  if (taskBatch.length === 0) return;
  if (process.env.MC_DATABASE_BACKEND === 'postgres') {
    const { indexTask } = await import('@/lib/search/fts');
    for (const task of taskBatch) {
      try {
        await indexTask(task);
        await publishSemantic('upsert', 'task', task.id);
      } catch (error) {
        syncLogger.error({ err: error, taskId: task.id }, 'indexTaskSearch failed');
      }
    }
    return;
  }
  if (!(await allowsSemanticSearch())) {
    const { indexTask } = await import('@/lib/search/fts');
    for (const task of taskBatch) {
      try {
        await indexTask(task);
      } catch (error) {
        syncLogger.error({ err: error, taskId: task.id }, 'indexTaskSearch failed');
      }
    }
    return;
  }
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

/**
 * Removes a deleted task from the selected keyword index, and from the
 * semantic projection only when that workflow is supported by the backend.
 */
export async function removeTaskFromSearch(taskId: string) {
  if (process.env.MC_DATABASE_BACKEND === 'postgres') {
    const { removeTaskFromIndex } = await import('@/lib/search/fts');
    await removeTaskFromIndex(taskId);
    await publishSemantic('delete', 'task', taskId);
    return;
  }
  if (!(await allowsSemanticSearch())) {
    const { removeTaskFromIndex } = await import('@/lib/search/fts');
    await removeTaskFromIndex(taskId);
    return;
  }
  const search = await getSearchModule();
  await search?.removeTaskSearch(taskId).catch((e) => {
    syncLogger.error({ err: e, taskId }, 'removeTaskSearch failed');
  });
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
  if (process.env.MC_DATABASE_BACKEND === 'postgres') {
    const { indexAlert } = await import('@/lib/search/fts');
    await indexAlert(alert);
    await publishSemantic('upsert', 'alert', alert.id);
    return;
  }
  if (!(await allowsSemanticSearch())) {
    const { indexAlert } = await import('@/lib/search/fts');
    await indexAlert(alert);
    return;
  }
  const search = await getSearchModule();
  await search?.indexAlertSearch(alert).catch((e) => { syncLogger.error({ err: e, alertId: alert.id }, 'indexAlertSearch failed'); });
}
