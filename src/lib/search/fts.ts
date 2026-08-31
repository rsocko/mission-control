import type { KeywordSearchRepository } from './repository';
import { resolveDatabaseBackend } from '@/db/runtime-backend';

/**
 * Resolves the keyword-search adapter for the currently selected database
 * backend. SQLite keeps using its long-standing FTS5-backed singleton
 * unchanged; PostgreSQL resolves to the adapter registered by
 * `initializeRuntimeDatabase` (see `@/db/runtime`) once the backend has
 * finished initializing.
 *
 * The PostgreSQL side is imported dynamically (only once actually needed)
 * so that merely importing this module — as most of the existing SQLite
 * call sites already do — never pulls in the PostgreSQL schema/driver graph.
 */
async function getKeywordSearchRepository(): Promise<KeywordSearchRepository> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { getPostgresKeywordSearchRepository } = await import('@/db/runtime');
    return getPostgresKeywordSearchRepository();
  }
  const { sqliteKeywordSearchRepository } = await import('./sqlite-fts-repository');
  return sqliteKeywordSearchRepository;
}

export const rebuildSearchIndex = async () => (await getKeywordSearchRepository()).rebuild();
export const indexTask = async (...args: Parameters<KeywordSearchRepository['indexTask']>) =>
  (await getKeywordSearchRepository()).indexTask(...args);
export const removeTaskFromIndex = async (
  ...args: Parameters<KeywordSearchRepository['removeTask']>
) => (await getKeywordSearchRepository()).removeTask(...args);
export const indexAlert = async (
  ...args: Parameters<KeywordSearchRepository['indexNotification']>
) => (await getKeywordSearchRepository()).indexNotification(...args);
export const removeAlertFromIndex = async (
  ...args: Parameters<KeywordSearchRepository['removeNotification']>
) => (await getKeywordSearchRepository()).removeNotification(...args);
export const warmUpFTS = async () => (await getKeywordSearchRepository()).warmUp();
export const searchFTS = async (
  ...args: Parameters<KeywordSearchRepository['search']>
) => (await getKeywordSearchRepository()).search(...args);

export type {
  SearchFilters,
  SearchOptions,
  SearchResult,
  SearchScope,
  SearchableNotificationRecord,
  SearchableTaskRecord,
} from './repository';
