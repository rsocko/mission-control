import type { ConnectorInfo, ReviewTag, SourceListInfo, TagSort } from './types';

const SYSTEM_TAG_PATTERNS = [
  /^mc:/i,
  /^priority[\s:\/\-_]/i,
  /^priority$/i,
  /^p[0-3]$/i,
  /^effort[\s:\/\-_]/i,
  /^size[\s:\/\-_]/i,
];

export function isSystemTag(tagName: string): boolean {
  return SYSTEM_TAG_PATTERNS.some(pattern => pattern.test(tagName));
}

export function getSystemCategory(tagName: string): string | null {
  if (/^mc:/i.test(tagName)) return 'Micro-status';
  if (/^priority/i.test(tagName) || /^p[0-3]$/i.test(tagName)) return 'Priority';
  if (/^effort/i.test(tagName) || /^size/i.test(tagName)) return 'Effort';
  return null;
}

export function findMergeSuggestions(tagList: ReviewTag[]): Array<{ a: ReviewTag; b: ReviewTag }> {
  const suggestions: Array<{ a: ReviewTag; b: ReviewTag }> = [];

  for (let i = 0; i < tagList.length; i++) {
    for (let j = i + 1; j < tagList.length; j++) {
      const a = tagList[i];
      const b = tagList[j];
      if (a.unifiedInto || b.unifiedInto) continue;

      if (a.slug === b.slug) {
        suggestions.push({ a, b });
        continue;
      }

      const normalizedA = a.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedB = b.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedA === normalizedB && normalizedA.length > 2) suggestions.push({ a, b });
    }
  }

  return suggestions;
}

export function chooseDefaultMergeTarget(tagList: ReviewTag[]): ReviewTag {
  return [...tagList].sort((a, b) => {
    if (a.type === 'hub' && b.type !== 'hub') return -1;
    if (b.type === 'hub' && a.type !== 'hub') return 1;
    return b.usageCount - a.usageCount;
  })[0];
}

export function cannotUseAsMergeTarget(tag: ReviewTag, reviewTags: ReviewTag[]): boolean {
  return tag.type === 'source'
    && tag.usageCount === 0
    && reviewTags.some(item => item.type !== 'source')
    && !reviewTags.some(item =>
      item.id !== tag.id && item.type === 'source' && item.usageCount > 0
    );
}

export function getScopedUsageCount(
  tag: ReviewTag,
  scopeFilter: string,
  sourceLists: SourceListInfo[],
): number {
  if (scopeFilter === 'all' || scopeFilter === 'local') return tag.usageCount;

  if (scopeFilter.startsWith('list:')) {
    const sourceList = sourceLists.find(item => item.id === scopeFilter.slice(5));
    if (!sourceList) return 0;
    return tag.listUsage?.find(usage =>
      usage.connectorInstanceId === sourceList.connectorInstanceId
      && usage.sourceListId === sourceList.sourceId
    )?.usageCount ?? 0;
  }

  return tag.sourceUsage?.find(usage => usage.connectorType === scopeFilter)?.usageCount ?? 0;
}

export function partitionTags(tags: ReviewTag[]) {
  const userTags: ReviewTag[] = [];
  const systemTags: ReviewTag[] = [];
  const aiTags: ReviewTag[] = [];
  const confirmedAiTags: ReviewTag[] = [];

  for (const tag of tags) {
    if (isSystemTag(tag.name)) systemTags.push(tag);
    else if (tag.type === 'ai-inferred' && !tag.confirmed) aiTags.push(tag);
    else if (tag.type === 'ai-inferred') confirmedAiTags.push(tag);
    else userTags.push(tag);
  }

  return { userTags, systemTags, aiTags, confirmedAiTags };
}

export function filterAndSortTags(
  tags: ReviewTag[],
  scopeFilter: string,
  searchQuery: string,
  sortBy: TagSort,
  sourceLists: SourceListInfo[],
): ReviewTag[] {
  let result = tags;

  if (scopeFilter === 'local') {
    result = result.filter(tag => tag.type === 'hub' || (!tag.sources?.length && !tag.source));
  } else if (scopeFilter.startsWith('list:')) {
    const sourceList = sourceLists.find(item => item.id === scopeFilter.slice(5));
    if (sourceList) {
      result = result.filter(tag => tag.listUsage?.some(usage =>
        usage.connectorInstanceId === sourceList.connectorInstanceId
        && usage.sourceListId === sourceList.sourceId
      ));
    }
  } else if (scopeFilter !== 'all') {
    result = result.filter(tag => {
      const sources = tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : []);
      return sources.includes(scopeFilter);
    });
  }

  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    result = result.filter(tag =>
      tag.name.toLowerCase().includes(query) || tag.slug.includes(query)
    );
  }

  return [...result].sort((a, b) => {
    if (sortBy === 'usage-desc') {
      return getScopedUsageCount(b, scopeFilter, sourceLists)
        - getScopedUsageCount(a, scopeFilter, sourceLists);
    }
    if (sortBy === 'usage-asc') {
      return getScopedUsageCount(a, scopeFilter, sourceLists)
        - getScopedUsageCount(b, scopeFilter, sourceLists);
    }
    if (sortBy === 'name-desc') return b.name.localeCompare(a.name);
    return a.name.localeCompare(b.name);
  });
}

export function getScopeOptions(
  tags: ReviewTag[],
  sourceLists: SourceListInfo[],
  connectors: ConnectorInfo[],
) {
  const sources = new Set<string>();
  for (const tag of tags) {
    for (const source of tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : [])) {
      sources.add(source);
    }
  }

  const listsByType = new Map<string, SourceListInfo[]>();
  for (const sourceList of sourceLists) {
    const connector = connectors.find(item => item.id === sourceList.connectorInstanceId);
    if (!connector || connector.capabilities.tagScope !== 'per-list') continue;
    const lists = listsByType.get(connector.type) ?? [];
    lists.push(sourceList);
    listsByType.set(connector.type, lists);
  }

  return { sources: Array.from(sources).sort(), listsByType };
}
