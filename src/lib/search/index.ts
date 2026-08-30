import {
  indexAlert,
  indexTask,
  rebuildSearchIndex,
  removeAlertFromIndex,
  removeTaskFromIndex,
  searchFTS,
  warmUpFTS,
  type SearchResult,
  type SearchableNotificationRecord,
  type SearchableTaskRecord,
} from './fts';
import {
  getSemanticSearchMetrics,
  getSemanticSearchStatus,
  rebuildEmbeddingIndex,
  semanticSearch,
} from './semantic';
import {
  publishSemanticDelete,
  publishSemanticUpsert,
} from '@/lib/semantic-index/runtime';

type SearchScope = 'tasks' | 'notifications' | 'all';
type SearchMode = 'keyword' | 'semantic' | 'hybrid';
export interface SearchFilters {
  source?: string;
  status?: string;
  excludeDone?: boolean;
}

type SearchOptions = SearchFilters & {
  type?: SearchScope;
  mode?: SearchMode;
  limit?: number;
};

export interface SearchBranchTiming {
  status: 'completed';
  durationMs: number;
  resultCount: number;
}

export interface SearchExecution {
  results: SearchResult[];
  branches: Partial<Record<'keyword' | 'semantic', SearchBranchTiming>>;
}

function normalizeLimit(limit = 20) {
  return Math.max(1, Math.min(limit, 50));
}

function resultKey(result: Pick<SearchResult, 'type' | 'id'>) {
  return `${result.type}:${result.id}`;
}

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  return (await searchWithBranches(query, options)).results;
}

export async function searchWithBranches(
  query: string,
  options: SearchOptions = {},
): Promise<SearchExecution> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { results: [], branches: {} };
  }

  const type = options.type ?? 'all';
  const mode = options.mode ?? 'hybrid';
  const limit = normalizeLimit(options.limit);
  const branchLimit = Math.max(limit * 2, limit);
  const filters: SearchFilters = {
    source: options.source,
    status: options.status,
    excludeDone: options.excludeDone,
  };
  if (mode === 'keyword') {
    const startedAt = performance.now();
    const results = await searchFTS(normalizedQuery, { type, limit, ...filters });
    return {
      results,
      branches: {
        keyword: {
          status: 'completed',
          durationMs: Math.round(performance.now() - startedAt),
          resultCount: results.length,
        },
      },
    };
  }

  if (mode === 'semantic') {
    const startedAt = performance.now();
    const results = await semanticSearch(normalizedQuery, { type, limit, ...filters });
    return {
      results,
      branches: {
        semantic: {
          status: 'completed',
          durationMs: Math.round(performance.now() - startedAt),
          resultCount: results.length,
        },
      },
    };
  }

  const [keywordBranch, semanticBranch] = await Promise.all([
    timeSearchBranch(() => searchFTS(normalizedQuery, {
      type,
      limit: branchLimit,
      ...filters,
    })),
    timeSearchBranch(() => semanticSearch(normalizedQuery, {
      type,
      limit: branchLimit,
      ...filters,
    })),
  ]);
  const ftsResults = keywordBranch.results;
  const semanticResults = semanticBranch.results;

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

  const results = Array.from(merged.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return {
    results,
    branches: {
      keyword: keywordBranch.timing,
      semantic: semanticBranch.timing,
    },
  };
}

async function timeSearchBranch(load: () => Promise<SearchResult[]>) {
  const startedAt = performance.now();
  const results = await load();
  return {
    results,
    timing: {
      status: 'completed' as const,
      durationMs: Math.round(performance.now() - startedAt),
      resultCount: results.length,
    },
  };
}

export async function getSearchStatus(mode: SearchMode = 'hybrid') {
  if (mode === 'keyword') {
    return {
      available: true,
      enabled: false,
      state: 'not-requested' as const,
      note: null,
      semanticMetrics: null,
    };
  }

  const status = await getSemanticSearchStatus();
  return {
    available: status.available,
    enabled: status.state !== 'disabled',
    state: status.state,
    note: status.note,
    semanticMetrics: getSemanticSearchMetrics(),
  };
}

/**
 * Publishes a semantic intent for an entity whose authoritative write already
 * committed.
 *
 * Publication never throws and never blocks on a provider: `publishSemantic*`
 * records a durable intent (or logs a skip) and returns. A dropped intent is
 * repaired by reconciliation rather than failing the caller.
 */
async function publishSemantic(
  kind: 'upsert' | 'delete',
  entityType: 'task' | 'alert',
  entityId: string,
): Promise<void> {
  if (kind === 'upsert') await publishSemanticUpsert(entityType, entityId);
  else await publishSemanticDelete(entityType, entityId);
}

/**
 * Keyword indexing stays inline and immediate — it is a local FTS write. The
 * semantic side is only *published*: no embedding provider is ever called on a
 * domain write path.
 */
export async function indexTaskSearch(task: SearchableTaskRecord) {
  await indexTask(task);
  await publishSemantic('upsert', 'task', task.id);
}

export async function indexNotificationSearch(notification: SearchableNotificationRecord) {
  await indexAlert(notification);
  await publishSemantic('upsert', 'alert', notification.id);
}

/** @deprecated Use indexNotificationSearch */
export const indexAlertSearch = indexNotificationSearch;

/** Removes a deleted task from the keyword index and tombstones its document. */
export async function removeTaskSearch(taskId: string) {
  await removeTaskFromIndex(taskId);
  await publishSemantic('delete', 'task', taskId);
}

export async function removeNotificationSearch(notificationId: string) {
  await removeAlertFromIndex(notificationId);
  await publishSemantic('delete', 'alert', notificationId);
}

/**
 * Publishes a semantic re-index for an entity whose projected fields changed
 * without its searchable text changing (a status transition, for instance).
 * The keyword index does not need that update; the projection does.
 */
export async function publishTaskSemanticUpdate(taskId: string) {
  await publishSemantic('upsert', 'task', taskId);
}

export async function publishNotificationSemanticUpdate(notificationId: string) {
  await publishSemantic('upsert', 'alert', notificationId);
}

export { rebuildEmbeddingIndex, rebuildSearchIndex };

/**
 * Pre-warm the keyword index after sync. The semantic index is maintained by
 * the durable index worker, so nothing here embeds, backfills, or rebuilds.
 */
export async function warmUpSearch() {
  await warmUpFTS();
}

export type { SearchResult, SearchableTaskRecord, SearchableNotificationRecord } from './fts';
