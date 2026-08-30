import { describe, expect, it } from 'vitest';
import { fuseHybridResults } from '@/lib/search/hybrid-ranking';
import type { SearchResult } from '@/lib/search/repository';
import {
  applyEvaluationFilter,
  SYNTHETIC_HYBRID_EVALUATION,
} from './fixtures/hybrid-evaluation';

function result(type: SearchResult['type'], id: string, title = id): SearchResult {
  return {
    type,
    id,
    title,
    snippet: '',
    score: 1,
    source: 'fts',
    href: '/',
    metadata: {},
  };
}

describe('hybrid reciprocal-rank fusion', () => {
  it.each(SYNTHETIC_HYBRID_EVALUATION)(
    'passes the $category synthetic relevance case',
    ({ query, lexical, semantic, filter, expectedFirst, expectedIds }) => {
      const fused = fuseHybridResults(
        query,
        applyEvaluationFilter(lexical, filter),
        applyEvaluationFilter(semantic, filter),
        { limit: 20 },
      );
      if (expectedFirst) expect(fused[0]?.id).toBe(expectedFirst);
      if (expectedIds) expect(fused.map((item) => item.id)).toEqual(expectedIds);
    },
  );

  it('preserves exact and title-prefix lexical matches above semantic-only results', () => {
    const fused = fuseHybridResults(
      'release',
      [result('task', 'exact', 'release'), result('task', 'prefix', 'Release checklist')],
      [
        result('task', 'related', 'Production rollout'),
        result('task', 'prefix', 'Release checklist'),
      ],
      { limit: 10 },
    );

    expect(fused.map((item) => item.id)).toEqual(['exact', 'prefix', 'related']);
  });

  it('deduplicates identity, exposes ranks, and does not present inference as lexical', () => {
    const fused = fuseHybridResults(
      'login',
      [result('task', 'same', 'Login failure')],
      [result('task', 'related', 'Authentication outage'), result('task', 'same', 'Login failure')],
      { limit: 10 },
    );

    expect(fused).toHaveLength(2);
    expect(fused[0]).toMatchObject({
      id: 'same',
      source: 'hybrid',
      rankExplanation: {
        lexicalRank: 1,
        semanticRank: 2,
        fusedRank: 1,
        semanticOnly: false,
      },
    });
    expect(fused[1].rankExplanation).toMatchObject({
      lexicalRank: null,
      semanticRank: 1,
      semanticOnly: true,
    });
  });

  it('counts duplicate candidates only once within each channel', () => {
    const duplicate = result('task', 'same', 'Same result');
    const next = result('task', 'next', 'Next result');
    const fused = fuseHybridResults(
      'same',
      [duplicate, duplicate, next],
      [duplicate, duplicate, next],
      { limit: 10 },
    );

    expect(fused).toHaveLength(2);
    expect(fused[0].rankExplanation).toMatchObject({
      lexicalRank: 1,
      semanticRank: 1,
    });
    expect(fused[1].rankExplanation).toMatchObject({
      lexicalRank: 2,
      semanticRank: 2,
    });
  });

  it('allows semantic rank to displace weak body-only lexical matches', () => {
    const fused = fuseHybridResults(
      'authentication problem',
      Array.from(
        { length: 30 },
        (_, index) => result('task', `body-${index}`, `Unrelated title ${index}`),
      ),
      [result('task', 'related', 'Sign-in outage')],
      { limit: 10 },
    );

    expect(fused[0].id).toBe('related');
  });

  it('applies strict per-kind caps when multiple kinds are available', () => {
    const fused = fuseHybridResults(
      'work',
      Array.from({ length: 5 }, (_, index) => result('task', `task-${index}`)),
      [result('notification', 'alert-1')],
      { limit: 6, perKindLimit: 3 },
    );

    expect(fused.filter((item) => item.type === 'task')).toHaveLength(3);
    expect(fused.some((item) => item.id === 'alert-1')).toBe(true);
  });

  it('uses kind, normalized title, and stable ID to break equal-rank ties', () => {
    const fused = fuseHybridResults(
      '',
      [],
      [
        result('task', 'b', 'Same'),
        result('notification', 'z', 'Same'),
      ],
      { limit: 10, semanticWeight: 0 },
    );

    expect(fused.map((item) => `${item.type}:${item.id}`)).toEqual([
      'notification:z',
      'task:b',
    ]);
  });
});
