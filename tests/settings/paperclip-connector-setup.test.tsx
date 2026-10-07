import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AddConnectorModal } from '@/app/settings/components/AddConnectorModal';
import { ConnectorBrandIcon } from '@/app/settings/components/ConnectorBrandIcon';
import { CONNECTOR_ICONS } from '@/app/settings/components/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('renders the vendored upstream Paperclip logo', () => {
  expect(CONNECTOR_ICONS.paperclip).toBe('/icons/connectors/paperclip.svg');

  const { container } = render(<ConnectorBrandIcon type="paperclip" />);

  expect(container.querySelector('img')).toHaveAttribute(
    'src',
    '/icons/connectors/paperclip.svg',
  );
});

it('authorizes Paperclip in the browser and creates a connector for the selected company', async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === '/api/connectors/paperclip/auth') {
      const body = JSON.parse(String(init?.body)) as { action: string };
      if (body.action === 'start') {
        return Response.json({
          authSessionId: 'auth-session-1',
          approvalUrl: 'https://paperclip.example.test/cli-auth/challenge-1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          suggestedPollIntervalMs: 1,
        }, { status: 201 });
      }
      return Response.json({
        status: 'approved',
        keyExpiresAt: '2027-01-01T00:00:00.000Z',
        companies: [
          { id: 'company-1', name: 'Research team' },
          { id: 'company-2', name: 'Operations' },
        ],
      });
    }
    if (String(input) === '/api/connectors') {
      return Response.json({ id: 'paperclip-connector' }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null);
  const onClose = vi.fn();
  render(<AddConnectorModal onClose={onClose} onAdded={() => undefined} />);

  fireEvent.click(screen.getByText('Paperclip').closest('button')!);
  fireEvent.change(await screen.findByLabelText('Paperclip API origin'), {
    target: { value: 'https://paperclip.example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize in Paperclip' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(openWindow).toHaveBeenCalledWith(
    'https://paperclip.example.test/cli-auth/challenge-1',
    '_blank',
    'noopener,noreferrer',
  );
  expect(await screen.findByText(/Authorization approved; setup is not finished/)).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /All accessible companies/ })).toBeChecked();
  fireEvent.click(screen.getByRole('dialog').parentElement!);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const [, startInit] = fetchMock.mock.calls[0]!;
  expect(JSON.parse(String(startInit?.body))).toEqual({
    action: 'start',
    apiOrigin: 'https://paperclip.example.test',
  });
  const [, createInit] = fetchMock.mock.calls[2]!;
  expect(JSON.parse(String(createInit?.body))).toMatchObject({
    type: 'paperclip',
    name: 'Paperclip — All companies',
    pollIntervalMinutes: 5,
    settings: {
      monitorAllCompanies: true,
      companyIds: [],
    },
    credentials: { authSessionId: 'auth-session-1' },
    capabilities: {
      notificationOnly: true,
      write: false,
      delete: false,
    },
  });
  expect(await screen.findByText('Paperclip connected.')).toBeInTheDocument();
});
