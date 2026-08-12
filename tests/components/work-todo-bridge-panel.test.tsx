import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkTodoBridgePanel } from '@/app/settings/components/WorkTodoBridgePanel';
import type { ConnectorConfig, SourceList } from '@/app/settings/components/types';

const connector: ConnectorConfig = {
  id: 'work-todo',
  type: 'microsoft-todo-work',
  name: 'Work To Do',
  enabled: true,
  syncMode: 'manual',
  pollIntervalMinutes: null,
  capabilities: {},
  credentials: {},
  settings: {},
  syncedLists: [],
  createdAt: '2026-08-07T18:00:00.000Z',
  updatedAt: '2026-08-07T18:00:00.000Z',
  deletedAt: null,
};

const sourceLists: SourceList[] = [{
  id: 'source-list',
  connectorInstanceId: connector.id,
  sourceId: 'list-1',
  name: 'Corporate Tasks',
  type: 'todo',
  taskCount: 4,
  lastSyncedAt: '2026-08-07T18:00:00.000Z',
  groupId: null,
}];

describe('Work To Do bridge panel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        initialized: true,
        transport: 'power-automate-graph',
        capabilityProfile: 'extended-v1',
        resetRequired: false,
        lastIngestAt: '2026-08-07T18:00:00.000Z',
        lastIngestMode: 'delta',
        lastError: null,
        deltaCheckpointStored: true,
        pendingWriteBackCount: 3,
      }),
    })));
  });

  it('shows lists, pending writes, and checkpoint state without exposing a token', async () => {
    render(
      <WorkTodoBridgePanel
        connector={connector}
        sourceLists={sourceLists}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(await screen.findByText('Extended Graph delta')).toBeInTheDocument();
    expect(screen.getByText('Corporate Tasks')).toBeInTheDocument();
    expect(screen.getByText('Stored; never displayed')).toBeInTheDocument();
    expect(screen.getByLabelText('Display Name')).toHaveValue('Work To Do');
    expect(document.body.textContent).not.toContain('deltatoken');
  });

  it('requests a fresh baseline and reloads status', async () => {
    render(
      <WorkTodoBridgePanel
        connector={connector}
        sourceLists={sourceLists}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await screen.findByText('Extended Graph delta');

    fireEvent.click(screen.getByRole('button', { name: 'Require fresh delta baseline' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/connectors/work-todo/work-todo',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'reset-delta' }),
      }),
    ));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
