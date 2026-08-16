import { describe, expect, it } from 'vitest';
import {
  cannotUseAsMergeTarget,
  chooseDefaultMergeTarget,
  filterAndSortTags,
  findMergeSuggestions,
  getScopedUsageCount,
  getSystemCategory,
  isSystemTag,
  partitionTags,
} from '@/app/settings/components/tag-review/heuristics';
import type { ReviewTag, SourceListInfo } from '@/app/settings/components/tag-review/types';

function tag(overrides: Partial<ReviewTag> = {}): ReviewTag {
  return {
    id: 'tag-1',
    name: 'Bug',
    slug: 'bug',
    type: 'hub',
    source: null,
    sources: [],
    sourceNames: [],
    color: null,
    confirmed: true,
    usageCount: 1,
    unifiedInto: null,
    listUsage: [],
    sourceUsage: [],
    ...overrides,
  };
}

const sourceLists: SourceListInfo[] = [{
  id: 'repo-one',
  connectorInstanceId: 'github-1',
  sourceId: 'org/repo',
  name: 'org/repo',
  type: 'repo',
}];

describe('tag review heuristics', () => {
  it('identifies and categorizes protected system tags', () => {
    expect(isSystemTag('mc:waiting')).toBe(true);
    expect(isSystemTag('Priority / high')).toBe(true);
    expect(isSystemTag('P2')).toBe(true);
    expect(isSystemTag('size-large')).toBe(true);
    expect(isSystemTag('product')).toBe(false);
    expect(getSystemCategory('mc:waiting')).toBe('Micro-status');
    expect(getSystemCategory('P0')).toBe('Priority');
    expect(getSystemCategory('effort:large')).toBe('Effort');
    expect(getSystemCategory('product')).toBeNull();
  });

  it('suggests exact and normalized duplicates but skips unified tags', () => {
    const exact = tag({ id: 'exact', name: 'wontfix', slug: 'wontfix' });
    const punctuation = tag({ id: 'punctuation', name: "won't fix", slug: 'wont-fix' });
    const unified = tag({
      id: 'unified',
      name: 'WONT FIX',
      slug: 'wont-fix',
      unifiedInto: exact.id,
    });

    expect(findMergeSuggestions([exact, punctuation, unified])).toEqual([
      { a: exact, b: punctuation },
    ]);
  });

  it('prefers a hub merge winner, then the most-used candidate', () => {
    const source = tag({ id: 'source', type: 'source', usageCount: 20 });
    const hub = tag({ id: 'hub', usageCount: 1 });
    expect(chooseDefaultMergeTarget([source, hub])).toBe(hub);
    expect(chooseDefaultMergeTarget([
      tag({ id: 'small', usageCount: 1 }),
      tag({ id: 'large', usageCount: 3 }),
    ]).id).toBe('large');
  });

  it('guards an unused source winner unless another source establishes scope', () => {
    const unusedSource = tag({ id: 'unused', type: 'source', usageCount: 0 });
    const hub = tag({ id: 'hub' });
    expect(cannotUseAsMergeTarget(unusedSource, [unusedSource, hub])).toBe(true);
    expect(cannotUseAsMergeTarget(unusedSource, [
      unusedSource,
      hub,
      tag({ id: 'used-source', type: 'source', usageCount: 2 }),
    ])).toBe(false);
  });

  it('filters and sorts with list-scoped usage counts', () => {
    const repoTag = tag({
      id: 'repo-tag',
      name: 'Repo',
      slug: 'repo',
      usageCount: 8,
      listUsage: [{
        connectorInstanceId: 'github-1',
        sourceListId: 'org/repo',
        usageCount: 2,
      }],
    });
    const otherTag = tag({ id: 'other', name: 'Other', slug: 'other', usageCount: 10 });

    expect(getScopedUsageCount(repoTag, 'list:repo-one', sourceLists)).toBe(2);
    expect(filterAndSortTags(
      [otherTag, repoTag],
      'list:repo-one',
      'rep',
      'usage-desc',
      sourceLists,
    )).toEqual([repoTag]);
  });

  it('partitions system and AI tags away from user tags', () => {
    const result = partitionTags([
      tag({ id: 'user' }),
      tag({ id: 'system', name: 'priority-high' }),
      tag({ id: 'pending-ai', type: 'ai-inferred', confirmed: false }),
      tag({ id: 'confirmed-ai', type: 'ai-inferred', confirmed: true }),
    ]);

    expect(result.userTags.map(item => item.id)).toEqual(['user']);
    expect(result.systemTags.map(item => item.id)).toEqual(['system']);
    expect(result.aiTags.map(item => item.id)).toEqual(['pending-ai']);
    expect(result.confirmedAiTags.map(item => item.id)).toEqual(['confirmed-ai']);
  });
});
