import {
  registerLegacySearchIndexingService,
  type LegacySearchIndexingService,
} from '@/lib/search/indexing-service';

let searchModulePromise: Promise<typeof import('@/lib/search')> | undefined;

async function getSearchModule(): Promise<typeof import('@/lib/search')> {
  if (!searchModulePromise) {
    searchModulePromise = import('@/lib/search');
  }
  return searchModulePromise;
}

const sqliteLegacySearchIndexingService: LegacySearchIndexingService = {
  async warmUp() {
    await (await getSearchModule()).warmUpSearch();
  },
  async indexTask(task) {
    await (await getSearchModule()).indexTaskSearch(task);
  },
  async removeTask(taskId) {
    await (await getSearchModule()).removeTaskSearch(taskId);
  },
  async indexAlert(alert) {
    await (await getSearchModule()).indexAlertSearch(alert);
  },
};

export function registerSqliteLegacySearchIndexingService(): void {
  registerLegacySearchIndexingService(sqliteLegacySearchIndexingService);
}
