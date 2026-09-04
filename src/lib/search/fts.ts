import type { KeywordSearchRepository } from './repository';
import { getKeywordSearchRepository } from './keyword-runtime';

export const rebuildSearchIndex = async () => getKeywordSearchRepository().rebuild();
export const indexTask = async (...args: Parameters<KeywordSearchRepository['indexTask']>) =>
  getKeywordSearchRepository().indexTask(...args);
export const removeTaskFromIndex = async (
  ...args: Parameters<KeywordSearchRepository['removeTask']>
) => getKeywordSearchRepository().removeTask(...args);
export const indexAlert = async (
  ...args: Parameters<KeywordSearchRepository['indexNotification']>
) => getKeywordSearchRepository().indexNotification(...args);
export const removeAlertFromIndex = async (
  ...args: Parameters<KeywordSearchRepository['removeNotification']>
) => getKeywordSearchRepository().removeNotification(...args);
export const warmUpFTS = async () => getKeywordSearchRepository().warmUp();
export const searchFTS = async (
  ...args: Parameters<KeywordSearchRepository['search']>
) => getKeywordSearchRepository().search(...args);

export type {
  SearchFilters,
  SearchOptions,
  SearchResult,
  SearchScope,
  SearchableNotificationRecord,
  SearchableTaskRecord,
} from './repository';
