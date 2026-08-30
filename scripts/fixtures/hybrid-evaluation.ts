import type { SearchResult } from '@/lib/search/repository';

export type EvaluationCategory =
  | 'exact-id'
  | 'exact-title'
  | 'lexical'
  | 'conceptual'
  | 'cross-source'
  | 'filtered'
  | 'duplicate'
  | 'no-result';

export interface EvaluationFilter {
  metadataKey: string;
  allowedValue: string;
}

export function applyEvaluationFilter(
  candidates: SearchResult[],
  filter?: EvaluationFilter,
): SearchResult[] {
  if (!filter) return candidates;
  return candidates.filter(
    (candidate) => candidate.metadata[filter.metadataKey] === filter.allowedValue,
  );
}

function candidate(
  type: SearchResult['type'],
  id: string,
  title: string,
  metadata: Record<string, unknown> = {},
): SearchResult {
  return {
    type,
    id,
    title,
    snippet: '',
    score: 1,
    source: 'fts',
    href: type === 'task' ? `/?taskId=${id}` : `/notifications?id=${id}`,
    metadata,
  };
}

export const SYNTHETIC_HYBRID_EVALUATION = [
  {
    category: 'exact-id',
    query: '#1663',
    lexical: [candidate('task', 'task-1663', 'Validate hybrid search', { issueNumber: 1663 })],
    semantic: [candidate('task', 'concept-1', 'Search quality planning')],
    expectedFirst: 'task-1663',
  },
  {
    category: 'exact-title',
    query: 'Database migration',
    lexical: [candidate('task', 'migration', 'Database migration')],
    semantic: [candidate('task', 'concept-2', 'Move persistent storage')],
    expectedFirst: 'migration',
  },
  {
    category: 'lexical',
    query: 'urgent login',
    lexical: [candidate('task', 'login', 'Urgent login regression')],
    semantic: [candidate('notification', 'auth-alert', 'Authentication errors')],
    expectedFirst: 'login',
  },
  {
    category: 'conceptual',
    query: 'customers cannot sign in',
    lexical: [],
    semantic: [candidate('task', 'auth', 'Repair authentication timeout')],
    expectedFirst: 'auth',
  },
  {
    category: 'cross-source',
    query: 'payment outage',
    lexical: [candidate('notification', 'payment-alert', 'Payment outage detected')],
    semantic: [candidate('task', 'payment-task', 'Repair checkout provider')],
    expectedIds: ['payment-alert', 'payment-task'],
  },
  {
    category: 'filtered',
    query: 'deploy',
    lexical: [
      candidate('task', 'denied-lexical', 'Deploy secret service', { projectId: 'secret' }),
      candidate('task', 'allowed', 'Deploy approved service', { projectId: 'alpha' }),
    ],
    semantic: [
      candidate('task', 'denied-semantic', 'Deploy restricted workload', { projectId: 'secret' }),
      candidate('task', 'allowed', 'Deploy approved service', { projectId: 'alpha' }),
    ],
    filter: { metadataKey: 'projectId', allowedValue: 'alpha' },
    expectedIds: ['allowed'],
  },
  {
    category: 'duplicate',
    query: 'sync failure',
    lexical: [candidate('notification', 'sync', 'Sync failure')],
    semantic: [candidate('notification', 'sync', 'Sync failure')],
    expectedIds: ['sync'],
  },
  {
    category: 'no-result',
    query: 'nonexistent synthetic subject',
    lexical: [],
    semantic: [],
    expectedIds: [],
  },
] satisfies Array<{
  category: EvaluationCategory;
  query: string;
  lexical: SearchResult[];
  semantic: SearchResult[];
  filter?: EvaluationFilter;
  expectedFirst?: string;
  expectedIds?: string[];
}>;
