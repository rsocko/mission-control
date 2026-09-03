import { syncLogger } from '@/lib/logger';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication-service';
import {
  getLegacySearchIndexingService,
  type SearchIndexAlert,
  type SearchIndexTask,
} from '@/lib/search/indexing-service';
import { getKeywordSearchRepository } from '@/lib/search/keyword-runtime';

async function allowsSemanticSearch(): Promise<boolean> {
  return (await getWorkerPersistenceRepositories()).execution.support
    .allowsLegacyWorkflow('semantic-search');
}

async function publishSemantic(
  kind: 'upsert' | 'delete',
  entityType: 'task' | 'alert',
  entityId: string,
): Promise<void> {
  if (kind === 'upsert') await publishSemanticEntityUpsert(entityType, entityId);
  else await publishSemanticEntityDelete(entityType, entityId);
}

/**
 * Pre-warm search indexes after sync completes.
 * Ensures the first Ctrl+K search has no cold-start delay.
 */
export async function warmUpSearchAfterSync() {
  if (!(await allowsSemanticSearch()) || process.env.MC_DATABASE_BACKEND === 'postgres') {
    await getKeywordSearchRepository().warmUp();
    return;
  }
  await getLegacySearchIndexingService().warmUp().catch((e) => {
    syncLogger.error({ err: e }, 'warmUpSearch failed');
  });
}

export type SearchableTask = SearchIndexTask;

export async function indexTaskForSearch(task: SearchableTask) {
  if (process.env.MC_DATABASE_BACKEND === 'postgres') {
    await getKeywordSearchRepository().indexTask(task);
    await publishSemantic('upsert', 'task', task.id);
    return;
  }
  if (!(await allowsSemanticSearch())) {
    await getKeywordSearchRepository().indexTask(task);
    return;
  }
  await getLegacySearchIndexingService().indexTask(task).catch((e) => { syncLogger.error({ err: e, taskId: task.id }, 'indexTaskSearch failed'); });
}

/**
 * Batch-index multiple tasks for search. Defers embedding generation
 * to avoid blocking the event loop during sync.
 */
export async function indexTasksForSearchBatch(taskBatch: SearchableTask[]) {
  if (taskBatch.length === 0) return;
  if (process.env.MC_DATABASE_BACKEND === 'postgres') {
    for (const task of taskBatch) {
      try {
        await getKeywordSearchRepository().indexTask(task);
        await publishSemantic('upsert', 'task', task.id);
      } catch (error) {
        syncLogger.error({ err: error, taskId: task.id }, 'indexTaskSearch failed');
      }
    }
    return;
  }
  if (!(await allowsSemanticSearch())) {
    for (const task of taskBatch) {
      try {
        await getKeywordSearchRepository().indexTask(task);
      } catch (error) {
        syncLogger.error({ err: error, taskId: task.id }, 'indexTaskSearch failed');
      }
    }
    return;
  }
  for (const task of taskBatch) {
    try {
      await getLegacySearchIndexingService().indexTask(task);
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
    await getKeywordSearchRepository().removeTask(taskId);
    await publishSemantic('delete', 'task', taskId);
    return;
  }
  if (!(await allowsSemanticSearch())) {
    await getKeywordSearchRepository().removeTask(taskId);
    return;
  }
  await getLegacySearchIndexingService().removeTask(taskId).catch((e) => {
    syncLogger.error({ err: e, taskId }, 'removeTaskSearch failed');
  });
}

export async function indexAlertForSearch(alert: SearchIndexAlert) {
  if (process.env.MC_DATABASE_BACKEND === 'postgres') {
    await getKeywordSearchRepository().indexNotification(alert);
    await publishSemantic('upsert', 'alert', alert.id);
    return;
  }
  if (!(await allowsSemanticSearch())) {
    await getKeywordSearchRepository().indexNotification(alert);
    return;
  }
  await getLegacySearchIndexingService().indexAlert(alert).catch((e) => { syncLogger.error({ err: e, alertId: alert.id }, 'indexAlertSearch failed'); });
}
