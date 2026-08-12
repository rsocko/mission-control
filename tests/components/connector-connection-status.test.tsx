import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  ConnectionStatus,
  type ConnectorHealthState,
} from '@/app/settings/components/ConnectionStatus';
import type { ConnectorConfig } from '@/app/settings/components/types';

const connector: ConnectorConfig = {
  id: 'doc-intelligence',
  type: 'document-intelligence',
  name: 'Document Intelligence',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 60,
  capabilities: {},
  credentials: {},
  settings: {},
  syncedLists: [],
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
  deletedAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConnectionStatus', () => {
  it('shows a healthy Document Intelligence connector as active', async () => {
    const healthState: ConnectorHealthState = {
      requestKey: 'doc-intelligence:healthy',
      data: { overall: 'healthy', modules: [] },
    };

    render(<ConnectionStatus connector={connector} healthState={healthState} />);

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText('Not Connected')).not.toBeInTheDocument();
  });

  it('shows a degraded Document Intelligence health result', async () => {
    const healthState: ConnectorHealthState = {
      requestKey: 'doc-intelligence:degraded',
      data: { overall: 'degraded', modules: [] },
    };

    render(<ConnectionStatus connector={connector} healthState={healthState} />);

    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('shows Document Intelligence as unhealthy when the health check fails', async () => {
    const healthState: ConnectorHealthState = {
      requestKey: 'doc-intelligence:unhealthy',
      data: null,
    };

    render(<ConnectionStatus connector={connector} healthState={healthState} />);

    expect(screen.getByText('Unhealthy')).toBeInTheDocument();
  });

  it('shows Document Intelligence as unhealthy for an unhealthy response', () => {
    const healthState: ConnectorHealthState = {
      requestKey: 'doc-intelligence:unhealthy-response',
      data: { overall: 'unhealthy', modules: [] },
    };

    render(<ConnectionStatus connector={connector} healthState={healthState} />);

    expect(screen.getByText('Unhealthy')).toBeInTheDocument();
  });

  it('shows a loading state while health is being checked', () => {
    render(<ConnectionStatus connector={connector} />);

    expect(screen.getByText('Checking')).toBeInTheDocument();
  });

  it('does not probe health for a disabled connector', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ConnectionStatus connector={{ ...connector, enabled: false }} />);

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves credential-based status for other connector types', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ConnectionStatus connector={{ ...connector, type: 'microsoft-todo' }} />);

    expect(screen.getByText('Not Connected')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows push-only connectors as active while sync mode remains card metadata', () => {
    render(<ConnectionStatus connector={{ ...connector, type: 'scout' }} />);

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText('Push-only')).not.toBeInTheDocument();
  });
});
