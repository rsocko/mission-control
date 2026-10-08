export type SearchScope = 'tasks' | 'notifications' | 'all';

export interface SearchFilters {
  source?: string;
  status?: string;
  notificationKind?: 'triage' | 'notes';
  dateFrom?: string;
  dueBefore?: string;
  excludeDone?: boolean;
  universeEligible?: boolean;
  excludeConnectorInstanceIds?: string[];
}

export interface SearchOptions extends SearchFilters {
  type?: SearchScope;
  limit?: number;
}

export interface SearchFacet {
  value: string;
  count: number;
}

export interface SearchFacets {
  sources: SearchFacet[];
  statuses: SearchFacet[];
}

export const SEARCH_FACET_LIMIT = 50;

export function mergeSearchFacetRows(rows: SearchFacet[]): SearchFacet[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row.value.trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + Number(row.count));
  }
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, SEARCH_FACET_LIMIT);
}

export interface SearchResult {
  type: 'task' | 'notification';
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: 'fts' | 'semantic' | 'hybrid';
  href: string;
  highlights?: {
    title?: string;
    snippet?: string;
  };
  metadata: Record<string, unknown>;
  rankExplanation?: {
    lexicalRank: number | null;
    semanticRank: number | null;
    fusedRank: number;
    lexicalMatch: 'exact' | 'prefix' | 'lexical' | 'none';
    semanticOnly: boolean;
  };
}

export interface SearchableTaskRecord {
  id: string;
  title: string;
  description?: string | null;
  sourceListName?: string | null;
  connectorType?: string | null;
  status?: string | null;
  priority?: string | null;
  updatedAt?: string | null;
}

export interface SearchableNotificationRecord {
  id: string;
  title: string;
  body?: string | null;
  category?: string | null;
  severity?: string | null;
  isRead?: boolean | null;
  isActionable?: boolean | null;
  connectorType?: string | null;
  receivedAt?: string | null;
}

export interface KeywordSearchRepository {
  rebuild(): Promise<void>;
  indexTask(task: SearchableTaskRecord): Promise<void>;
  removeTask(taskId: string): Promise<void>;
  indexNotification(notification: SearchableNotificationRecord): Promise<void>;
  removeNotification(notificationId: string): Promise<void>;
  warmUp(): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  facets(query: string, options?: SearchOptions): Promise<SearchFacets>;
}
