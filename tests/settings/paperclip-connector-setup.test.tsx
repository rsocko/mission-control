import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AddConnectorModal } from '@/app/settings/components/AddConnectorModal';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('tests Paperclip access and creates a restricted notification connector for the verified company', async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === '/api/connectors/test-pre-save') {
      return Response.json({
        success: true,
        sources: { companyName: 'Research team' },
      });
    }
    if (String(input) === '/api/connectors') {
      return Response.json({ id: 'paperclip-connector' }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AddConnectorModal onClose={() => undefined} onAdded={() => undefined} />);

  fireEvent.click(screen.getByText('Paperclip').closest('button')!);
  fireEvent.change(screen.getByLabelText('Paperclip API origin'), {
    target: { value: 'https://paperclip.example.test' },
  });
  fireEvent.change(screen.getByLabelText('Paperclip company ID'), {
    target: { value: 'company-1' },
  });
  fireEvent.change(screen.getByLabelText('Paperclip API token'), {
    target: { value: 'paperclip-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Test and add' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [, testInit] = fetchMock.mock.calls[0]!;
  expect(JSON.parse(String(testInit?.body))).toEqual({
    type: 'paperclip',
    settings: {
      apiOrigin: 'https://paperclip.example.test',
      companyId: 'company-1',
    },
    credentials: { apiToken: 'paperclip-token' },
  });
  const [, createInit] = fetchMock.mock.calls[1]!;
  expect(JSON.parse(String(createInit?.body))).toMatchObject({
    type: 'paperclip',
    name: 'Paperclip — Research team',
    pollIntervalMinutes: 5,
    settings: {
      companyId: 'company-1',
      companyName: 'Research team',
    },
    credentials: { apiToken: 'paperclip-token' },
    capabilities: {
      notificationOnly: true,
      write: false,
      delete: false,
    },
  });
  expect(await screen.findByText('Paperclip approvals connector added.')).toBeInTheDocument();
});
