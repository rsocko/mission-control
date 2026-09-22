import type { SearchResult } from './repository';

function getTitleMatchRank(result: SearchResult): number {
  const rank = result.metadata.titleMatchRank;
  return typeof rank === 'number' ? rank : Number.MAX_SAFE_INTEGER;
}

export function compareKeywordResults(left: SearchResult, right: SearchResult): number {
  const titleRankDifference = getTitleMatchRank(left) - getTitleMatchRank(right);
  if (titleRankDifference !== 0) return titleRankDifference;

  const scoreDifference = right.score - left.score;
  if (scoreDifference !== 0) return scoreDifference;

  const titleDifference = left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
  return titleDifference !== 0
    ? titleDifference
    : `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`);
}
