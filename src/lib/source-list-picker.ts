export const RECENT_SOURCE_LISTS_STORAGE_KEY = 'mission-control:recent-move-targets';
export const MAX_RECENT_SOURCE_LISTS = 5;

export interface SourceListPickerList {
  sourceId: string;
  name: string;
  groupId?: string | null;
  sortOrder?: number;
}

export interface SourceListPickerGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export interface SourceListPickerSection<TList extends SourceListPickerList> {
  id: string;
  label: string;
  lists: TList[];
  recent?: boolean;
}

export function parseRecentSourceListIds(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const id = entry.trim();
      if (!id || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length === MAX_RECENT_SOURCE_LISTS) break;
    }
    return ids;
  } catch {
    return [];
  }
}

export function readRecentSourceListIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return parseRecentSourceListIds(
      window.localStorage.getItem(RECENT_SOURCE_LISTS_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function recordRecentSourceListId(sourceId: string): string[] {
  const normalizedId = sourceId.trim();
  if (!normalizedId) return readRecentSourceListIds();

  const next = [
    normalizedId,
    ...readRecentSourceListIds().filter((id) => id !== normalizedId),
  ].slice(0, MAX_RECENT_SOURCE_LISTS);

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        RECENT_SOURCE_LISTS_STORAGE_KEY,
        JSON.stringify(next),
      );
    } catch {
      // Selection still succeeds when storage is unavailable.
    }
  }

  return next;
}

function compareLists(
  a: SourceListPickerList,
  b: SourceListPickerList,
): number {
  return (
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER)
    - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name)
  );
}

export function groupSourceLists<TList extends SourceListPickerList>({
  lists,
  groups,
  search,
  recentIds,
}: {
  lists: TList[];
  groups: SourceListPickerGroup[];
  search: string;
  recentIds: string[];
}): SourceListPickerSection<TList>[] {
  const query = search.trim().toLocaleLowerCase();
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const filteredLists = query
    ? lists.filter((list) => {
        const groupName = list.groupId
          ? groupById.get(list.groupId)?.name
          : undefined;
        return `${list.name} ${groupName ?? ''}`
          .toLocaleLowerCase()
          .includes(query);
      })
    : lists;

  const sections: SourceListPickerSection<TList>[] = [];
  if (!query) {
    const listById = new Map(lists.map((list) => [list.sourceId, list]));
    const recentLists = recentIds.flatMap((id) => {
      const list = listById.get(id);
      return list ? [list] : [];
    });
    if (recentLists.length > 0) {
      sections.push({
        id: 'recent',
        label: 'Recent',
        lists: recentLists,
        recent: true,
      });
    }
  }

  const listsByGroup = new Map<string | null, TList[]>();
  for (const list of filteredLists) {
    const groupId = list.groupId && groupById.has(list.groupId)
      ? list.groupId
      : null;
    const bucket = listsByGroup.get(groupId) ?? [];
    bucket.push(list);
    listsByGroup.set(groupId, bucket);
  }

  const sortedGroups = [...groups].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  for (const group of sortedGroups) {
    const groupLists = listsByGroup.get(group.id);
    if (!groupLists?.length) continue;
    sections.push({
      id: group.id,
      label: group.name,
      lists: [...groupLists].sort(compareLists),
    });
  }

  const ungroupedLists = listsByGroup.get(null);
  if (ungroupedLists?.length) {
    sections.push({
      id: 'other',
      label: groups.length > 0 ? 'Other' : 'Lists',
      lists: [...ungroupedLists].sort(compareLists),
    });
  }

  return sections;
}
