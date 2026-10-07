import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AddConnectorModal } from '@/app/settings/components/AddConnectorModal';
import type { ConnectorConfig } from '@/app/settings/components/types';

function connector(id: string, type: string): ConnectorConfig {
  return {
    id,
    type,
    name: type,
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 15,
    capabilities: {},
    credentials: {},
    settings: {},
    syncedLists: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
  };
}

it('searches connector names, descriptions, and aliases', () => {
  render(<AddConnectorModal onClose={vi.fn()} onAdded={vi.fn()} />);

  const search = screen.getByRole('searchbox', { name: 'Search connectors' });
  expect(search).toHaveFocus();

  fireEvent.change(search, { target: { value: 'inbox' } });

  expect(screen.getByRole('button', { name: /Add Outlook Email/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add GitHub Issues/ })).not.toBeInTheDocument();
});

it('filters connectors by data handling classification', () => {
  render(<AddConnectorModal onClose={vi.fn()} onAdded={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: /Standard/ }));

  expect(screen.getByRole('button', { name: /Add Microsoft Todo / })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add Outlook Email/ })).not.toBeInTheDocument();
});

it('keeps connected connector types available for additional instances', () => {
  render(
    <AddConnectorModal
      onClose={vi.fn()}
      onAdded={vi.fn()}
      connectors={[
        connector('outlook-1', 'outlook-email'),
        connector('outlook-2', 'outlook-email'),
      ]}
    />,
  );

  expect(
    screen.getByRole('button', { name: /Add another Outlook Email.*2 connected/ }),
  ).toBeEnabled();
  expect(screen.getByText('2 connected')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Manage connected' })).toBeInTheDocument();
});

it('shows a recoverable empty state when no connectors match', () => {
  render(<AddConnectorModal onClose={vi.fn()} onAdded={vi.fn()} />);

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search connectors' }), {
    target: { value: 'not-a-real-connector' },
  });

  expect(screen.getByText('No connectors found')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
  expect(screen.getByRole('button', { name: /Add Microsoft Todo / })).toBeInTheDocument();
});

it('supports arrow-key navigation across connector cards', () => {
  render(<AddConnectorModal onClose={vi.fn()} onAdded={vi.fn()} />);

  const microsoftTodo = screen.getByRole('button', { name: /Add Microsoft Todo / });
  const githubIssues = screen.getByRole('button', { name: /Add GitHub Issues/ });
  microsoftTodo.focus();

  fireEvent.keyDown(microsoftTodo, { key: 'ArrowRight' });

  expect(githubIssues).toHaveFocus();
});

it('renders icon-library connector assets through the resilient icon renderer', () => {
  render(<AddConnectorModal onClose={vi.fn()} onAdded={vi.fn()} />);

  expect(screen.getByRole('img', { name: 'lucide:paperclip' })).toBeInTheDocument();
});
