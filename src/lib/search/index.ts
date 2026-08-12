import {
  indexAlert,
  indexTask,
  searchFTS,
  type SearchResult,
  type SearchableNotificationRecord,
  type SearchableTaskRecord,
} from './fts';
import {
  buildNotificationEmbeddingText,
  buildTaskEmbeddingText,
  getSemanticSearchMetrics,
  getSemanticSearchStatus,
  indexEntityEmbedding,
  rebuildEmbeddingIndex,
  semanticSearch,
  warmUpEmbeddings,
} from './semantic';
import { rebuildSearchIndex, warmUpFTS } from './fts';

type SearchScope = 'tasks' | 'notifications' | 'all';
type SearchMode = 'keyword' | 'semantic' | 'hybrid';

function normalizeLimit(limit = 20) {
  return Math.max(1, Math.min(limit, 50));
}

function resultKey(result: Pick<SearchResult, 'type' | 'id'>) {
  return `${result.type}:${result.id}`;
}

export async function search(
  query: string,
  options: {
    type?: SearchScope;
    mode?: SearchMode;
    limit?: number;
  } = {},
): Promise<SearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const type = options.type ?? 'all';
  const mode = options.mode ?? 'hybrid';
  const limit = normalizeLimit(options.limit);
  const branchLimit = Math.max(limit * 2, limit);

  if (mode === 'keyword') {
    return searchFTS(normalizedQuery, { type, limit });
  }

  if (mode === 'semantic') {
    return semanticSearch(normalizedQuery, { type, limit });
  }

  const [ftsResults, semanticResults] = await Promise.all([
    searchFTS(normalizedQuery, { type, limit: branchLimit }),
    semanticSearch(normalizedQuery, { type, limit: branchLimit }),
  ]);

  const merged = new Map<string, SearchResult>();

  for (const result of ftsResults) {
    merged.set(resultKey(result), {
      ...result,
      score: result.score * 0.6,
      source: 'fts',
    });
  }

  for (const result of semanticResults) {
    const key = resultKey(result);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        ...result,
        score: result.score * 0.4,
        source: 'semantic',
      });
      continue;
    }

    merged.set(key, {
      ...existing,
      score: existing.score + (result.score * 0.4),
      source: 'hybrid',
      snippet: existing.snippet || result.snippet,
      metadata: { ...result.metadata, ...existing.metadata },
    });
  }

  return Array.from(merged.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export async function getSearchStatus(mode: SearchMode = 'hybrid') {
  if (mode === 'keyword') {
    return { available: true, note: null, semanticMetrics: null };
  }

  const status = await getSemanticSearchStatus();
  return {
    available: status.available,
    note: status.available ? null : status.note,
    semanticMetrics: getSemanticSearchMetrics(),
  };
}

export async function indexTaskSearch(task: SearchableTaskRecord) {
  await indexTask(task);
  await indexEntityEmbedding(
    'task',
    task.id,
    buildTaskEmbeddingText(task),
    [task.connectorType ?? ''],
    task.updatedAt
      ? {
          title: task.title,
          body: task.description ?? null,
          sortAt: task.updatedAt,
        }
      : undefined,
  ).catch(() => false);
}

export async function indexNotificationSearch(notification: SearchableNotificationRecord) {
  await indexAlert(notification);
  await indexEntityEmbedding(
    'alert',
    notification.id,
    buildNotificationEmbeddingText(notification),
    [notification.connectorType ?? ''],
    notification.receivedAt
      ? {
          title: notification.title,
          body: notification.body ?? null,
          sortAt: notification.receivedAt,
        }
      : undefined,
  ).catch(() => false);
}

/** @deprecated Use indexNotificationSearch */
export const indexAlertSearch = indexNotificationSearch;

export { rebuildEmbeddingIndex, rebuildSearchIndex };

/**
 * Pre-warm all search indexes (FTS tables + embedding cache).
 * Call after sync completes to eliminate cold-start lag on first query.
 */
export async function warmUpSearch() {
  await warmUpFTS();
  await warmUpEmbeddings();
}

export type { SearchResult, SearchableTaskRecord, SearchableNotificationRecord } from './fts';
