import type {
  KeywordSearchRepository,
  SearchOptions,
  SearchResult,
  SearchableNotificationRecord,
  SearchableTaskRecord,
} from './repository';

export interface SqliteKeywordSearchCapability {
  rebuildSearchIndex(): Promise<void>;
  indexTask(task: SearchableTaskRecord): Promise<void>;
  removeTaskFromIndex(taskId: string): Promise<void>;
  indexAlert(alert: SearchableNotificationRecord): Promise<void>;
  removeAlertFromIndex(alertId: string): Promise<void>;
  warmUpFTS(): Promise<void>;
  searchFTS(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  sqliteKeywordSearchRepository: KeywordSearchRepository;
}

let capability: SqliteKeywordSearchCapability | null = null;

export function registerSqliteKeywordSearchCapability(
  next: SqliteKeywordSearchCapability,
): void {
  capability = next;
}

export function clearSqliteKeywordSearchCapability(): void {
  capability = null;
}

function requireCapability(): SqliteKeywordSearchCapability {
  if (!capability) {
    throw new Error('SQLite keyword-search capability has not been registered');
  }
  return capability;
}

export const rebuildSearchIndex = (
  ...args: Parameters<SqliteKeywordSearchCapability['rebuildSearchIndex']>
) => requireCapability().rebuildSearchIndex(...args);
export const indexTask = (
  ...args: Parameters<SqliteKeywordSearchCapability['indexTask']>
) => requireCapability().indexTask(...args);
export const removeTaskFromIndex = (
  ...args: Parameters<SqliteKeywordSearchCapability['removeTaskFromIndex']>
) => requireCapability().removeTaskFromIndex(...args);
export const indexAlert = (
  ...args: Parameters<SqliteKeywordSearchCapability['indexAlert']>
) => requireCapability().indexAlert(...args);
export const removeAlertFromIndex = (
  ...args: Parameters<SqliteKeywordSearchCapability['removeAlertFromIndex']>
) => requireCapability().removeAlertFromIndex(...args);
export const warmUpFTS = (
  ...args: Parameters<SqliteKeywordSearchCapability['warmUpFTS']>
) => requireCapability().warmUpFTS(...args);
export const searchFTS = (
  ...args: Parameters<SqliteKeywordSearchCapability['searchFTS']>
) => requireCapability().searchFTS(...args);

export const sqliteKeywordSearchRepository: KeywordSearchRepository = {
  rebuild: (...args) => requireCapability().sqliteKeywordSearchRepository.rebuild(...args),
  indexTask: (...args) => requireCapability().sqliteKeywordSearchRepository.indexTask(...args),
  removeTask: (...args) => requireCapability().sqliteKeywordSearchRepository.removeTask(...args),
  indexNotification: (...args) =>
    requireCapability().sqliteKeywordSearchRepository.indexNotification(...args),
  removeNotification: (...args) =>
    requireCapability().sqliteKeywordSearchRepository.removeNotification(...args),
  warmUp: (...args) => requireCapability().sqliteKeywordSearchRepository.warmUp(...args),
  search: (...args) => requireCapability().sqliteKeywordSearchRepository.search(...args),
};
