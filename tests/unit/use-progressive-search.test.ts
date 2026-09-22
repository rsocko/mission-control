import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@/lib/search/fts';
import { mergeProgressiveSearchResults } from '@/lib/hooks/useProgressiveSearch';

function result(
  id: string,
  source: SearchResult['source'],
  score: number,
): SearchResult {
  return {
    type: 'task',
    id,
    title: id,
    snippet: '',
    score,
    source,
    href: `/?taskId=${id}`,
    metadata: {},
  };
}

describe('mergeProgressiveSearchResults', () => {
  it('preserves strong keyword matches and rank-fuses semantic results', () => {
    const merged = mergeProgressiveSearchResults(
      [result('exact', 'fts', 1), result('prefix', 'fts', 0.8)],
      [result('related', 'semantic', 0.99), result('exact', 'semantic', 0.9)],
      'e',
    );

    expect(merged.map((candidate) => candidate.id)).toEqual([
      'exact',
      'prefix',
      'related',
    ]);
    expect(merged[0]).toMatchObject({
      source: 'hybrid',
      metadata: { semanticScore: 0.9 },
    });
    expect(merged[2].source).toBe('semantic');
  });
});
