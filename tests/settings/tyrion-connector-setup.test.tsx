import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AddConnectorModal } from '@/app/settings/components/AddConnectorModal';
import { DefaultConnectorEditPanel } from '@/app/settings/components/ConnectorsSection';
import type { ConnectorConfig } from '@/app/settings/components/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('submits the configurable Tyrion Bridge API URL and setup token', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    success: true,
    details: 'Tyrion bridge reachable and authenticated with Monarch',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  render(<AddConnectorModal onClose={() => undefined} onAdded={() => undefined} />);

  fireEvent.click(screen.getByText('Tyrion').closest('button')!);

  expect(await screen.findByRole('heading', { name: 'Connect Tyrion' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Tyrion Bridge API URL'), {
    target: { value: 'https://bridge.example.test/connector/v1' },
  });
  fireEvent.change(screen.getByLabelText('Service token'), {
    target: { value: 'invented-setup-token' },
  });
  expect(document.body).toHaveTextContent('https://tyrion.example/api/connector/v1');

  fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

  const [, init] = fetchMock.mock.calls[0];
  expect(JSON.parse(String(init?.body))).toEqual({
    type: 'finance-manager',
    credentials: { serviceToken: 'invented-setup-token' },
    settings: { bridgeUrl: 'https://bridge.example.test/connector/v1' },
  });
});

it('edits the persisted Tyrion Bridge API URL without round-tripping credentials', async () => {
  const connector: ConnectorConfig = {
    id: 'finance-test',
    type: 'finance-manager',
    name: 'Tyrion',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 240,
    capabilities: { read: true, write: true, sync: true },
    credentials: {},
    hasCredentials: true,
    settings: { bridgeUrl: 'http://old-bridge:8100' },
    syncedLists: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    deletedAt: null,
  };
  const onUpdate = vi.fn().mockResolvedValue(undefined);

  render(<DefaultConnectorEditPanel
    connector={connector}
    sourceLists={[]}
    onUpdate={onUpdate}
    onPurgeSourceList={vi.fn().mockResolvedValue(undefined)}
    onDelete={() => undefined}
    confirmDelete={null}
    setConfirmDelete={() => undefined}
    onHealthRefresh={() => undefined}
  />);

  fireEvent.change(screen.getByLabelText('Tyrion Bridge API URL'), {
    target: { value: 'http://new-bridge:8100' },
  });
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
    'finance-test',
    expect.objectContaining({
      settings: { bridgeUrl: 'http://new-bridge:8100' },
    }),
  ));
  expect(JSON.stringify(onUpdate.mock.calls)).not.toContain('serviceToken');
});
