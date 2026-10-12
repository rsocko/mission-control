import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectorEditPanel,
  ConnectorsSection,
  DefaultConnectorEditPanel,
} from '@/app/settings/components/ConnectorsSection';
import { ListGroupsSection } from '@/app/settings/components/ListGroupsSection';
import { isSourceListSelected, type ConnectorConfig, type SourceList } from '@/app/settings/components/types';

const connector: ConnectorConfig = {
  id: 'github-1',
  type: 'github-issues',
  name: 'GitHub',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: {
    read: true,
    write: true,
    sync: true,
    lists: true,
  },
  credentials: {},
  settings: {
    repos: ['octo/existing'],
    fetchNotifications: true,
  },
  syncedLists: ['octo/existing'],
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
  deletedAt: null,
};

describe('GitHub connector settings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/permissions')) {
        return new Response(JSON.stringify({ scopes: [] }), { status: 200 });
      }
      if (url.endsWith('/validate-repo')) {
        return new Response(JSON.stringify({ valid: true }), { status: 200 });
      }
      if (url.endsWith('/api/sync/health')) {
        return new Response(JSON.stringify({
          graphApiEmojiIssue: { affected: false, affectedLists: [] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));
  });

  it('links each connector to pre-filtered sync history', () => {
    render(
      <ConnectorsSection
        connectors={[connector]}
        sourceLists={[]}
        loading={false}
        syncing={null}
        onToggle={vi.fn()}
        onSync={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={vi.fn()}
        onPurgeSourceList={vi.fn()}
        onAdd={vi.fn()}
        selectedConnector={null}
        onSelect={vi.fn()}
        deletedConnectors={[]}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: 'View GitHub sync history' }))
      .toHaveAttribute('href', '/settings/sync-history?source=github-1');
  });

  it('opens connector configuration in a tabbed modal without empty tabs', async () => {
    const todoConnector: ConnectorConfig = {
      ...connector,
      id: 'todo-1',
      type: 'microsoft-todo',
      name: 'Work tasks',
      settings: {},
      syncedLists: [],
    };

    function ConnectorHarness() {
      const [selectedConnector, setSelectedConnector] = useState<string | null>(null);
      const [selectedTab, setSelectedTab] = useState<'general' | 'sources' | 'notifications' | 'access' | 'advanced'>('general');
      return (
        <ConnectorsSection
          connectors={[connector, todoConnector]}
          sourceLists={[]}
          loading={false}
          syncing={null}
          onToggle={vi.fn()}
          onSync={vi.fn()}
          onDelete={vi.fn()}
          onUpdate={vi.fn()}
          onPurgeSourceList={vi.fn()}
          onAdd={vi.fn()}
          selectedConnector={selectedConnector}
          onSelect={setSelectedConnector}
          selectedTab={selectedTab}
          onTabChange={setSelectedTab}
          deletedConnectors={[]}
          onRestore={vi.fn()}
          onPermanentDelete={vi.fn()}
        />
      );
    }

    render(<ConnectorHarness />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[0]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'General',
      'Sources',
      'Alerts & rules',
      'Access & data',
      'Advanced',
    ]);
    expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Display Name' }), {
      target: { value: 'GitHub draft name' },
    });

    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'General' }), {
      key: 'ArrowRight',
    });
    expect(within(dialog).getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByRole('tab', { name: 'Sources' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'General' }));
    expect(within(dialog).getByRole('textbox', { name: 'Display Name' }))
      .toHaveValue('GitHub draft name');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[1]);
    const todoDialog = await screen.findByRole('dialog');
    expect(within(todoDialog).getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'General',
      'Access & data',
      'Advanced',
    ]);
  });

  it('opens directly to a selected connector tab', async () => {
    const onTabChange = vi.fn();
    render(
      <ConnectorsSection
        connectors={[connector]}
        sourceLists={[]}
        loading={false}
        syncing={null}
        onToggle={vi.fn()}
        onSync={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={vi.fn()}
        onPurgeSourceList={vi.fn()}
        onAdd={vi.fn()}
        selectedConnector={connector.id}
        onSelect={vi.fn()}
        selectedTab="sources"
        onTabChange={onTabChange}
        deletedConnectors={[]}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByText('Repositories')).toBeInTheDocument();
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it('dispatches GitHub connectors to their type-specific editor', () => {
    render(
      <ConnectorEditPanel
        connector={connector}
        sourceLists={[]}
        onUpdate={vi.fn()}
        onPurgeSourceList={vi.fn()}
        onDelete={vi.fn()}
        confirmDelete={null}
        setConfirmDelete={vi.fn()}
        onHealthRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('Repositories')).toBeInTheDocument();
    expect(screen.getByText('octo/existing')).toBeInTheDocument();
  });

  it('removes a repository addition from the editor when saving fails', async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('Failed to update connector'));
    render(
      <DefaultConnectorEditPanel
        connector={connector}
        sourceLists={[]}
        onUpdate={onUpdate}
        onPurgeSourceList={vi.fn()}
        onDelete={vi.fn()}
        confirmDelete={null}
        setConfirmDelete={vi.fn()}
        onHealthRefresh={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('owner/repo'), {
      target: { value: 'octo/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('octo/new')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      connector.id,
      expect.objectContaining({
        settings: expect.objectContaining({
          repos: ['octo/existing', 'octo/new'],
        }),
        syncedLists: ['octo/existing', 'octo/new'],
      }),
    ));
    expect(await screen.findByText('Failed to update connector')).toBeInTheDocument();
    expect(screen.queryByText('octo/new')).not.toBeInTheDocument();
    expect(screen.getByText('octo/existing')).toBeInTheDocument();
  });

  it('removes a repository from future sync while retaining its source list', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <DefaultConnectorEditPanel
        connector={connector}
        sourceLists={[]}
        onUpdate={onUpdate}
        onPurgeSourceList={vi.fn()}
        onDelete={vi.fn()}
        confirmDelete={null}
        setConfirmDelete={vi.fn()}
        onHealthRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove octo/existing from sync' }));
    expect(screen.queryByText('octo/existing')).not.toBeInTheDocument();
    expect(screen.getByText('No repositories configured')).toBeInTheDocument();
    expect(screen.getByText(/Existing imported items are retained\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      connector.id,
      expect.objectContaining({
        settings: expect.objectContaining({ repos: [] }),
        syncedLists: [],
      }),
    ));
  });

  it('does not treat a retained GitHub source list as selected when no repos remain', () => {
    const sourceList: SourceList = {
      id: 'github-1:octo/existing',
      connectorInstanceId: connector.id,
      sourceId: 'octo/existing',
      name: 'existing',
      type: 'repo',
      taskCount: 1,
      lastSyncedAt: '2026-08-08T00:00:00.000Z',
      groupId: null,
    };

    expect(isSourceListSelected({
      ...connector,
      settings: { ...connector.settings, repos: [] },
      syncedLists: [],
    }, sourceList)).toBe(false);
    expect(isSourceListSelected({ ...connector, syncedLists: [] }, sourceList)).toBe(true);
  });

  it('labels retained repositories on the list groups screen', () => {
    const sourceLists: SourceList[] = [
      {
        id: 'github-1:octo/existing',
        connectorInstanceId: connector.id,
        sourceId: 'octo/existing',
        name: 'Active repository',
        type: 'repo',
        taskCount: 1,
        lastSyncedAt: '2026-08-08T00:00:00.000Z',
        groupId: null,
      },
      {
        id: 'github-1:octo/removed',
        connectorInstanceId: connector.id,
        sourceId: 'octo/removed',
        name: 'Removed repository',
        type: 'repo',
        taskCount: 2,
        lastSyncedAt: '2026-08-08T00:00:00.000Z',
        groupId: null,
      },
    ];

    render(
      <ListGroupsSection
        connectors={[connector]}
        sourceLists={sourceLists}
        listGroups={[]}
        loading={false}
        onCreateGroup={vi.fn()}
        onUpdateGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onAssignList={vi.fn()}
        onRefresh={vi.fn()}
        onRenameList={vi.fn(() => vi.fn().mockResolvedValue(undefined))}
      />,
    );

    expect(screen.getByText('Active repository')).toBeInTheDocument();
    expect(screen.getByText('Removed repository')).toBeInTheDocument();
    expect(screen.getByText('Not syncing')).toBeInTheDocument();
    expect(screen.getByText('2 lists')).toBeInTheDocument();
  });

  it('searches and sorts source lists consistently', () => {
    const alphaConnector: ConnectorConfig = {
      ...connector,
      id: 'todo-1',
      type: 'microsoft-todo',
      name: 'Alpha Connector',
    };
    const sourceLists: SourceList[] = [
      {
        id: 'github-1:alpha',
        connectorInstanceId: connector.id,
        sourceId: 'alpha',
        name: 'Alpha',
        type: 'repo',
        taskCount: 1,
        lastSyncedAt: null,
        groupId: null,
        sortOrder: 2,
      },
      {
        id: 'todo-1:beta',
        connectorInstanceId: alphaConnector.id,
        sourceId: 'beta',
        name: 'Beta',
        type: 'board',
        taskCount: 1,
        lastSyncedAt: null,
        groupId: null,
        sortOrder: 0,
      },
      {
        id: 'github-1:gamma',
        connectorInstanceId: connector.id,
        sourceId: 'gamma',
        name: 'Gamma',
        type: 'account',
        taskCount: 1,
        lastSyncedAt: null,
        groupId: 'group-1',
        sortOrder: 1,
      },
    ];

    render(
      <ListGroupsSection
        connectors={[connector, alphaConnector]}
        sourceLists={sourceLists}
        listGroups={[{
          id: 'group-1',
          connectorInstanceId: connector.id,
          name: 'Engineering',
          icon: null,
          iconColor: null,
          sortOrder: 0,
          createdAt: '2026-08-08T00:00:00.000Z',
        }]}
        loading={false}
        onCreateGroup={vi.fn()}
        onUpdateGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onAssignList={vi.fn()}
        onRefresh={vi.fn()}
        onRenameList={vi.fn(() => vi.fn().mockResolvedValue(undefined))}
      />,
    );

    const allLists = screen.getByRole('region', { name: /All lists/ });
    const visibleNames = () => within(allLists)
      .getAllByText(/^(Alpha|Beta|Gamma)$/)
      .map((element) => element.textContent);

    expect(visibleNames()).toEqual(['Gamma', 'Alpha']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find list' }), {
      target: { value: 'gamma' },
    });
    expect(within(allLists).getByText('Gamma')).toBeInTheDocument();
    expect(within(allLists).queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 lists')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: 'Choose source' }));
    fireEvent.click(screen.getByRole('option', { name: /Alpha Connector/ }));
    expect(within(allLists).getByText('Beta')).toBeInTheDocument();
    expect(within(allLists).queryByText('Gamma')).not.toBeInTheDocument();
  });

  it('offers an MC-only purge for a retained repository', async () => {
    const onPurgeSourceList = vi.fn().mockResolvedValue(undefined);
    const retainedConnector = {
      ...connector,
      settings: { ...connector.settings, repos: [] },
      syncedLists: [],
    };
    const retainedList: SourceList = {
      id: 'github-1:octo/removed',
      connectorInstanceId: connector.id,
      sourceId: 'octo/removed',
      name: 'Removed repository',
      type: 'repo',
      taskCount: 2,
      lastSyncedAt: '2026-08-08T00:00:00.000Z',
      groupId: null,
    };

    render(
      <DefaultConnectorEditPanel
        connector={retainedConnector}
        sourceLists={[retainedList]}
        onUpdate={vi.fn()}
        onPurgeSourceList={onPurgeSourceList}
        onDelete={vi.fn()}
        confirmDelete={null}
        setConfirmDelete={vi.fn()}
        onHealthRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('Not syncing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete retained items from MC' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete from MC' }));

    await waitFor(() => expect(onPurgeSourceList).toHaveBeenCalledWith(
      connector.id,
      retainedList.id,
    ));
  });
});
