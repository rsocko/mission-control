import { describe, expect, it, vi } from 'vitest';
import {
  getQuickAddSlashDestinations,
  scrollListTypeaheadSelectionIntoView,
} from '@/components/add-task/QuickAddBar';
import type { QuickAddDestination } from '@/components/add-task/quick-add-types';

describe('quick-add list typeahead', () => {
  it.each(['hom', 'home', '  HOME  '])('ranks list-name matches ahead of group-only matches for %j', (query) => {
    const destinations: QuickAddDestination[] = [
      { listId: 'garage', listName: 'Garage' },
      { listId: 'home-general', listName: '\u{1F3E0} Home General' },
      { listId: 'outside', listName: 'Outside' },
      { listId: 'home-projects', listName: '\u{1F3E0} Home Projects' },
    ].map((list) => ({
      id: 'todo',
      connectorType: 'microsoft-todo',
      account: 'personal',
      color: '#000',
      label: `To Do > ${list.listName}`,
      shortLabel: list.listName,
      groupName: 'HOME',
      ...list,
    }));
    const originalOrder = [...destinations];

    expect(getQuickAddSlashDestinations(destinations, query).map((destination) =>
      destination.listId
    )).toEqual(['home-general', 'home-projects', 'garage', 'outside']);
    expect(destinations).toEqual(originalOrder);
  });

  it.each(['shortLabel', 'label', 'groupName', 'connectorType'] as const)(
    'ranks list-name matches ahead of %s-only matches',
    (attribute) => {
      const base: QuickAddDestination = {
        id: 'todo',
        connectorType: 'microsoft-todo',
        account: 'personal',
        color: '#000',
        label: 'Garage',
        shortLabel: 'Garage',
        listId: 'garage',
        listName: 'Garage',
      };
      const metadataMatch = { ...base, [attribute]: 'A Home' };
      const nameMatch = {
        ...base,
        label: 'My Home General',
        shortLabel: 'My Home General',
        listId: 'home-general',
        listName: 'My Home General',
      };

      expect(getQuickAddSlashDestinations([metadataMatch, nameMatch], 'home')).toEqual([
        nameMatch,
        metadataMatch,
      ]);
      expect(getQuickAddSlashDestinations([metadataMatch, nameMatch], 'unmatched')).toEqual([]);
    },
  );

  it('scrolls the keyboard-selected option into view', () => {
    const container = document.createElement('div');
    const option = document.createElement('button');
    option.dataset.listTypeaheadIndex = '7';
    option.scrollIntoView = vi.fn();
    container.append(option);

    scrollListTypeaheadSelectionIntoView(container, 7);

    expect(option.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('includes lists and sources that allow list-less task creation', () => {
    const destinations: QuickAddDestination[] = [
      {
        id: 'local',
        label: 'Local',
        connectorType: 'local',
        account: null,
        color: '#000',
      },
      {
        id: 'todo',
        label: 'To Do',
        connectorType: 'microsoft-todo',
        account: 'work',
        color: '#000',
        listSelectionMode: 'optional',
      },
      {
        id: 'todo',
        label: 'To Do › Inbox',
        shortLabel: 'Inbox',
        connectorType: 'microsoft-todo',
        account: 'work',
        color: '#000',
        listId: 'inbox',
        listName: 'Inbox',
        listSelectionMode: 'optional',
      },
      {
        id: 'github',
        label: 'GitHub',
        connectorType: 'github-issues',
        account: 'work',
        color: '#000',
        listSelectionMode: 'required',
      },
      {
        id: 'github',
        label: 'GitHub › owner/repo',
        shortLabel: 'owner/repo',
        connectorType: 'github-issues',
        account: 'work',
        color: '#000',
        listId: 'owner/repo',
        listName: 'owner/repo',
        listSelectionMode: 'required',
      },
    ];

    expect(getQuickAddSlashDestinations(destinations, '').map((destination) =>
      destination.listName ?? destination.label
    )).toEqual(['Inbox', 'owner/repo', 'Local', 'To Do']);
    expect(getQuickAddSlashDestinations(destinations, 'github')).toEqual([
      expect.objectContaining({ listId: 'owner/repo' }),
    ]);
    expect(getQuickAddSlashDestinations(destinations, 'due:tomorrow')).toEqual([]);
  });
});
