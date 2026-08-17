import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DestinationPicker,
  groupQuickAddDestinations,
} from '@/components/add-task/DestinationPicker';
import { TemplatePicker } from '@/components/add-task/TemplatePicker';
import { useQuickAddTemplates } from '@/lib/hooks/useQuickAddTemplates';
import { findQuickAddContextDestination } from '@/lib/hooks/useQuickAddDestinations';
import type { QuickAddDestination } from '@/components/add-task/quick-add-types';
import type { TaskTemplate } from '@/types';

const destinations: QuickAddDestination[] = [
  {
    id: 'local',
    label: 'Local',
    shortLabel: 'Local',
    connectorType: 'local',
    account: null,
    color: '#000',
  },
  {
    id: 'todo',
    label: 'Microsoft To Do',
    shortLabel: 'To Do',
    connectorType: 'microsoft-todo',
    account: 'work',
    color: '#000',
  },
  {
    id: 'todo',
    label: 'Microsoft To Do › Backlog',
    shortLabel: 'Backlog',
    connectorType: 'microsoft-todo',
    account: 'work',
    color: '#000',
    listId: 'backlog',
    listName: 'Backlog',
    groupName: 'Planning',
    groupSortOrder: 1,
  },
  {
    id: 'todo',
    label: 'Microsoft To Do › Today',
    shortLabel: 'Today',
    connectorType: 'microsoft-todo',
    account: 'work',
    color: '#000',
    listId: 'today',
    listName: 'Today',
  },
];

const templates: TaskTemplate[] = [
  {
    id: 'template-1',
    name: 'Bug report',
    description: 'Capture a bug',
    type: 'single',
    subtasks: [],
    isBuiltIn: true,
    createdAt: '2026-08-15',
    updatedAt: '2026-08-15',
  },
  {
    id: 'template-2',
    name: 'Release workflow',
    description: 'Ship a release',
    type: 'workflow',
    subtasks: [],
    workflowTasks: [{ title: 'Prepare' }],
    isBuiltIn: true,
    createdAt: '2026-08-15',
    updatedAt: '2026-08-15',
  },
];

describe('Quick Add destination picker', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('groups sources, named groups, and ungrouped lists predictably', () => {
    expect(groupQuickAddDestinations(destinations, '').map((group) => ({
      label: group.label,
      destinations: group.destinations.map((destination) => destination.listName
        ?? destination.shortLabel),
    }))).toEqual([
      { label: 'Sources', destinations: ['Local', 'To Do'] },
      { label: 'To Do › Planning', destinations: ['Backlog'] },
      { label: 'To Do › Other', destinations: ['Today'] },
    ]);
  });

  it('resolves exact context lists before connector and configured defaults', () => {
    expect(findQuickAddContextDestination({
      destinations,
      context: {
        sourceFilter: null,
        listFilter: 'backlog',
        listFilterName: 'Backlog',
        listFilterConnectorType: 'microsoft-todo',
      },
      defaultDestination: { connectorType: 'local' },
    })).toMatchObject({ listId: 'backlog' });
  });

  it('filters and selects destinations with keyboard navigation', async () => {
    const onSelect = vi.fn();
    render(
      <DestinationPicker
        open
        destinations={destinations}
        selectedDestination={destinations[0]}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const search = screen.getByPlaceholderText('Search destinations...');
    fireEvent.change(search, { target: { value: 'today' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ listId: 'today' }));
  });

  it('closes on Escape without changing the destination', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <DestinationPicker
        open
        destinations={destinations}
        selectedDestination={destinations[0]}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText('Search destinations...'), {
      key: 'Escape',
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Quick Add template picker state', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ templates }), {
        headers: { 'Content-Type': 'application/json' },
      })
    ));
  });

  it('loads typeahead templates in the focused hook instead of the bar', async () => {
    const { result, rerender } = renderHook(
      ({ input }) => useQuickAddTemplates(input),
      { initialProps: { input: '' } },
    );

    rerender({ input: 't/release' });

    await waitFor(() => {
      expect(result.current.typeahead?.matches.map((template) => template.id)).toEqual([
        'template-2',
      ]);
    });
  });

  it('preserves template keyboard navigation and selection', async () => {
    const onSelectSingle = vi.fn();
    const onSelectWorkflow = vi.fn();
    render(
      <TemplatePicker
        open
        onClose={vi.fn()}
        onSelectSingle={onSelectSingle}
        onSelectWorkflow={onSelectWorkflow}
      />,
    );
    const search = screen.getByPlaceholderText('Search templates…');
    await screen.findByText('Bug report');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelectWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'template-2' }),
    );
    expect(onSelectSingle).not.toHaveBeenCalled();
  });
});
