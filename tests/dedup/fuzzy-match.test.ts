/**
 * Fuzzy Title Matching — Unit Tests
 *
 * Tests the dedup utility functions for cross-connector matching.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  tokenize,
  levenshteinSimilarity,
  tokenSimilarity,
  computeSimilarity,
  findFuzzyMatches,
  isAutoLinkMatch,
  isPotentialMatch,
} from '@/lib/dedup/fuzzy-match';

describe('normalizeTitle', () => {
  it('lowercases and trims', () => {
    expect(normalizeTitle('  Follow Up With Bob  ')).toBe('follow up with bob');
  });

  it('strips Re: and FW: prefixes', () => {
    expect(normalizeTitle('Re: Budget approval')).toBe('budget approval');
    expect(normalizeTitle('FW: Meeting notes')).toBe('meeting notes');
    expect(normalizeTitle('Fwd: Action items')).toBe('action items');
  });

  it('strips Action: prefix', () => {
    expect(normalizeTitle('Action: Submit report')).toBe('submit report');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeTitle('Review   the   proposal')).toBe('review the proposal');
  });
});

describe('tokenize', () => {
  it('splits on spaces and hyphens', () => {
    expect(tokenize('review the q3-budget')).toEqual(['review', 'q3', 'budget']);
  });

  it('removes stop words', () => {
    expect(tokenize('send a reply to bob')).toEqual(['send', 'reply', 'bob']);
  });

  it('keeps meaningful short words (2+ chars)', () => {
    expect(tokenize('do it now')).toEqual(['do', 'now']);
  });
});

describe('levenshteinSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(levenshteinSimilarity('hello', 'hello')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(levenshteinSimilarity('abc', 'xyz')).toBe(0.0);
  });

  it('handles one-character difference', () => {
    expect(levenshteinSimilarity('hello', 'hallo')).toBe(0.8);
  });

  it('handles empty strings', () => {
    expect(levenshteinSimilarity('', '')).toBe(1.0);
    expect(levenshteinSimilarity('hello', '')).toBe(0.0);
  });
});

describe('tokenSimilarity', () => {
  it('returns 1.0 for identical token sets', () => {
    expect(tokenSimilarity(['review', 'budget'], ['review', 'budget'])).toBe(1.0);
  });

  it('returns 0.0 for no overlap', () => {
    expect(tokenSimilarity(['review', 'budget'], ['send', 'email'])).toBe(0.0);
  });

  it('handles partial overlap', () => {
    // intersection=1 (review), union=3 (review, budget, report) = 0.333...
    expect(tokenSimilarity(['review', 'budget'], ['review', 'report'])).toBeCloseTo(1 / 3);
  });
});

describe('computeSimilarity', () => {
  it('returns 1.0 for identical titles', () => {
    expect(computeSimilarity('Submit Q3 report', 'Submit Q3 report')).toBe(1.0);
  });

  it('returns high score for minor rewording', () => {
    const score = computeSimilarity('Submit Q3 report', 'Submit the Q3 report');
    expect(score).toBeGreaterThan(0.8);
  });

  it('returns high score for Re: prefixed duplicate', () => {
    const score = computeSimilarity('Review budget proposal', 'Re: Review budget proposal');
    expect(score).toBe(1.0);
  });

  it('returns low score for completely different tasks', () => {
    const score = computeSimilarity('Submit Q3 report', 'Buy groceries for dinner');
    expect(score).toBeLessThan(0.3);
  });

  it('handles reordering of words', () => {
    const score = computeSimilarity('Update sales report', 'Sales report update');
    expect(score).toBeGreaterThan(0.7);
  });
});

describe('findFuzzyMatches', () => {
  const candidates = [
    { id: 'task-1', title: 'Submit Q3 financial report', connectorType: 'microsoft-todo', connectorInstanceId: 'todo-1', sourceId: 'todo:123', metadata: null },
    { id: 'task-2', title: 'Buy groceries', connectorType: 'microsoft-todo', connectorInstanceId: 'todo-1', sourceId: 'todo:456', metadata: null },
    { id: 'task-3', title: 'Review budget proposal from finance', connectorType: 'github-issues', connectorInstanceId: 'gh-1', sourceId: 'gh:789', metadata: null },
  ];

  it('finds a high-confidence match', () => {
    const results = findFuzzyMatches('Submit Q3 financial report', candidates);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].taskId).toBe('task-1');
    expect(results[0].score).toBeGreaterThan(0.85);
  });

  it('returns no matches for unrelated title', () => {
    const results = findFuzzyMatches('Deploy new Docker container', candidates);
    expect(results.length).toBe(0);
  });

  it('respects threshold option', () => {
    const results = findFuzzyMatches('Submit Q3 report', candidates, { threshold: 0.95 });
    // Even a close match may not hit 0.95
    expect(results.every(r => r.score >= 0.95)).toBe(true);
  });

  it('sorts results by score descending', () => {
    const results = findFuzzyMatches('financial report Q3', candidates, { threshold: 0.3 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

describe('isAutoLinkMatch', () => {
  it('returns true for scores >= 0.85', () => {
    expect(isAutoLinkMatch(0.85)).toBe(true);
    expect(isAutoLinkMatch(0.95)).toBe(true);
  });

  it('returns false for scores < 0.85', () => {
    expect(isAutoLinkMatch(0.84)).toBe(false);
    expect(isAutoLinkMatch(0.70)).toBe(false);
  });

  it('respects custom threshold', () => {
    expect(isAutoLinkMatch(0.80, { autoLinkThreshold: 0.80 })).toBe(true);
    expect(isAutoLinkMatch(0.79, { autoLinkThreshold: 0.80 })).toBe(false);
  });
});

describe('isPotentialMatch', () => {
  it('returns true for scores in the potential range', () => {
    expect(isPotentialMatch(0.75)).toBe(true);
    expect(isPotentialMatch(0.80)).toBe(true);
  });

  it('returns false for auto-link scores', () => {
    expect(isPotentialMatch(0.90)).toBe(false);
  });

  it('returns false for below-threshold scores', () => {
    expect(isPotentialMatch(0.50)).toBe(false);
  });
});
