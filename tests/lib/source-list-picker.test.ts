import { describe, expect, it } from 'vitest';
import {
  groupSourceLists,
  parseRecentSourceListIds,
} from '@/lib/source-list-picker';

const groups = [
  { id: 'personal', name: 'Personal', sortOrder: 2 },
  { id: 'work', name: 'Work', sortOrder: 1 },
];

const lists = [
  { sourceId: 'inbox', name: 'Inbox', groupId: null, sortOrder: 1 },
  { sourceId: 'later', name: 'Later', groupId: 'work', sortOrder: 2 },
  { sourceId: 'today', name: 'Today', groupId: 'work', sortOrder: 1 },
  { sourceId: 'chores', name: 'Chores', groupId: 'personal', sortOrder: 1 },
];

describe('source list picker grouping', () => {
  it('puts recent lists first and retains the complete grouped directory', () => {
    expect(groupSourceLists({
      lists,
      groups,
      search: '',
      recentIds: ['chores', 'today'],
    }).map((section) => ({
      label: section.label,
      lists: section.lists.map((list) => list.name),
    }))).toEqual([
      { label: 'Recent', lists: ['Chores', 'Today'] },
      { label: 'Work', lists: ['Today', 'Later'] },
      { label: 'Personal', lists: ['Chores'] },
      { label: 'Other', lists: ['Inbox'] },
    ]);
  });

  it('searches list and group names while preserving configured group order', () => {
    expect(groupSourceLists({
      lists,
      groups,
      search: 'work',
      recentIds: ['chores'],
    }).map((section) => ({
      label: section.label,
      lists: section.lists.map((list) => list.name),
    }))).toEqual([
      { label: 'Work', lists: ['Today', 'Later'] },
    ]);
  });

  it('sanitizes and limits persisted recent IDs', () => {
    expect(parseRecentSourceListIds(
      JSON.stringify([' today ', 'today', 42, '', 'later', 'chores', 'inbox', 'backlog']),
    )).toEqual(['today', 'later', 'chores', 'inbox', 'backlog']);
    expect(parseRecentSourceListIds('{bad json')).toEqual([]);
  });
});
