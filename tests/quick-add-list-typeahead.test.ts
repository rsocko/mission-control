import { describe, expect, it, vi } from 'vitest';
import {
  getQuickAddSlashDestinations,
  scrollListTypeaheadSelectionIntoView,
} from '@/components/add-task/QuickAddBar';
import type { QuickAddDestination } from '@/components/add-task/quick-add-types';

describe('quick-add list typeahead', () => {
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
