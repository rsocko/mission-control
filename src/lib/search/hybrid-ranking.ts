import type { SearchResult } from './repository';

export const DEFAULT_RRF_K = 60;

export type LexicalMatchStrength = 'exact' | 'prefix' | 'lexical' | 'none';

export interface HybridRankExplanation {
  lexicalRank: number | null;
  semanticRank: number | null;
  fusedRank: number;
  lexicalMatch: LexicalMatchStrength;
  semanticOnly: boolean;
}

export interface HybridRankingOptions {
  limit: number;
  perKindLimit?: number;
  rrfK?: number;
  lexicalWeight?: number;
  semanticWeight?: number;
}

function resultKey(result: Pick<SearchResult, 'type' | 'id'>): string {
  return `${result.type}:${result.id}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function lexicalStrength(query: string, result: SearchResult): LexicalMatchStrength {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 'none';

  const normalizedId = normalize(result.id);
  const normalizedTitle = normalize(result.title);
  const issueNumber = result.metadata.issueNumber;
  if (
    normalizedQuery === normalizedId
    || normalizedQuery.replace(/^#/, '') === normalizedId.replace(/^#/, '')
    || (issueNumber !== undefined
      && normalizedQuery.replace(/^#/, '') === String(issueNumber))
    || normalizedQuery === normalizedTitle
  ) {
    return 'exact';
  }
  if (normalizedTitle.startsWith(normalizedQuery)) return 'prefix';
  const queryTerms = normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return queryTerms.length > 0 && queryTerms.every((term) => normalizedTitle.includes(term))
    ? 'lexical'
    : 'none';
}

function strengthRank(strength: LexicalMatchStrength): number {
  if (strength === 'exact') return 3;
  if (strength === 'prefix') return 2;
  if (strength === 'lexical') return 1;
  return 0;
}

interface RankedResult {
  result: SearchResult;
  lexicalRank: number | null;
  semanticRank: number | null;
  lexicalMatch: LexicalMatchStrength;
  fusedScore: number;
}

function compareRanked(left: RankedResult, right: RankedResult): number {
  const strengthDifference = strengthRank(right.lexicalMatch) - strengthRank(left.lexicalMatch);
  if (strengthDifference !== 0) return strengthDifference;
  if (right.fusedScore !== left.fusedScore) return right.fusedScore - left.fusedScore;
  if (left.result.type !== right.result.type) {
    return left.result.type < right.result.type ? -1 : 1;
  }
  const leftTitle = normalize(left.result.title);
  const rightTitle = normalize(right.result.title);
  if (leftTitle !== rightTitle) return leftTitle < rightTitle ? -1 : 1;
  if (left.result.id !== right.result.id) return left.result.id < right.result.id ? -1 : 1;
  return 0;
}

/**
 * Deterministic reciprocal-rank fusion. Raw backend scores are intentionally
 * ignored because FTS/BM25 and cosine values are not calibrated to one another.
 */
export function fuseHybridResults(
  query: string,
  lexicalResults: SearchResult[],
  semanticResults: SearchResult[],
  options: HybridRankingOptions,
): SearchResult[] {
  const limit = Math.max(1, Math.trunc(options.limit));
  const perKindLimit = Math.max(1, Math.trunc(options.perKindLimit ?? limit));
  const rrfK = Math.max(1, options.rrfK ?? DEFAULT_RRF_K);
  const lexicalWeight = Math.max(0, options.lexicalWeight ?? 1);
  const semanticWeight = Math.max(0, options.semanticWeight ?? 1);
  const ranked = new Map<string, RankedResult>();

  let lexicalRank = 0;
  lexicalResults.forEach((result) => {
    const key = resultKey(result);
    if (ranked.has(key)) return;
    lexicalRank++;
    ranked.set(key, {
      result: { ...result, source: 'fts' },
      lexicalRank,
      semanticRank: null,
      lexicalMatch: lexicalStrength(query, result),
      fusedScore: lexicalWeight / (rrfK + lexicalRank),
    });
  });

  const semanticSeen = new Set<string>();
  let semanticRank = 0;
  semanticResults.forEach((result) => {
    const key = resultKey(result);
    if (semanticSeen.has(key)) return;
    semanticSeen.add(key);
    semanticRank++;
    const existing = ranked.get(key);
    const semanticContribution = semanticWeight / (rrfK + semanticRank);
    if (!existing) {
      ranked.set(key, {
        result: { ...result, source: 'semantic' },
        lexicalRank: null,
        semanticRank,
        lexicalMatch: 'none',
        fusedScore: semanticContribution,
      });
      return;
    }
    existing.semanticRank = semanticRank;
    existing.fusedScore += semanticContribution;
    existing.result = {
      ...existing.result,
      source: 'hybrid',
      snippet: existing.result.snippet || result.snippet,
      metadata: {
        ...result.metadata,
        ...existing.result.metadata,
        semanticScore: result.score,
      },
    };
  });

  const selected: RankedResult[] = [];
  const kindCounts = new Map<SearchResult['type'], number>();
  const sorted = [...ranked.values()].sort(compareRanked);
  const enforceKindCap = new Set(sorted.map((candidate) => candidate.result.type)).size > 1;
  for (const candidate of sorted) {
    const kindCount = kindCounts.get(candidate.result.type) ?? 0;
    if (enforceKindCap && kindCount >= perKindLimit) continue;
    selected.push(candidate);
    kindCounts.set(candidate.result.type, kindCount + 1);
    if (selected.length === limit) break;
  }

  return selected.map((candidate, index) => {
    const explanation: HybridRankExplanation = {
      lexicalRank: candidate.lexicalRank,
      semanticRank: candidate.semanticRank,
      fusedRank: index + 1,
      lexicalMatch: candidate.lexicalMatch,
      semanticOnly: candidate.lexicalRank === null,
    };
    return {
      ...candidate.result,
      score: candidate.fusedScore,
      rankExplanation: explanation,
    };
  });
}
