import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultConnectorEditPanel } from '@/app/settings/components/ConnectorsSection';
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
      return new Response(JSON.stringify({}), { status: 200 });
    }));
  });

  it('removes a repository addition from the editor when saving fails', async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('Failed to update connector'));
    render(
      <DefaultConnectorEditPanel
        connector={connector}
        sourceLists={[]}
        onUpdate={onUpdate}
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
});
