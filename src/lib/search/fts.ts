import { sqliteKeywordSearchRepository } from './sqlite-fts-repository';

export const rebuildSearchIndex = () => sqliteKeywordSearchRepository.rebuild();
export const indexTask = (...args: Parameters<typeof sqliteKeywordSearchRepository.indexTask>) =>
  sqliteKeywordSearchRepository.indexTask(...args);
export const removeTaskFromIndex = (
  ...args: Parameters<typeof sqliteKeywordSearchRepository.removeTask>
) => sqliteKeywordSearchRepository.removeTask(...args);
export const indexAlert = (
  ...args: Parameters<typeof sqliteKeywordSearchRepository.indexNotification>
) => sqliteKeywordSearchRepository.indexNotification(...args);
export const removeAlertFromIndex = (
  ...args: Parameters<typeof sqliteKeywordSearchRepository.removeNotification>
) => sqliteKeywordSearchRepository.removeNotification(...args);
export const warmUpFTS = () => sqliteKeywordSearchRepository.warmUp();
export const searchFTS = (
  ...args: Parameters<typeof sqliteKeywordSearchRepository.search>
) => sqliteKeywordSearchRepository.search(...args);

export type {
  SearchFilters,
  SearchOptions,
  SearchResult,
  SearchScope,
  SearchableNotificationRecord,
  SearchableTaskRecord,
} from './repository';
