import { describe, expect, it, vi } from 'vitest';
import {
  getActiveConnectors,
  getLatestConnectorSync,
  loadConnectorData,
  requestConnectorSync,
} from '@/lib/connectors/client';
import type { ConnectorConfig } from '@/app/settings/components/types';

const connector = (id: string, overrides: Partial<ConnectorConfig & { lastSyncAt: string | null }> = {}) => ({
  id,
  type: 'github-issues',
  name: id,
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: {},
  credentials: {},
  settings: {},
  syncedLists: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  deletedAt: null,
  lastSyncAt: null,
  ...overrides,
});

describe('connector client data semantics', () => {
  it('shares active filtering and latest-sync selection across settings surfaces', () => {
    const connectors = [
      connector('older', { lastSyncAt: '2026-08-01T00:00:00.000Z' }),
      connector('deleted', { deletedAt: '2026-08-02T00:00:00.000Z', lastSyncAt: '2026-08-16T00:00:00.000Z' }),
      connector('newer', { lastSyncAt: '2026-08-08T00:00:00.000Z' }),
    ];

    expect(getActiveConnectors(connectors).map(item => item.id)).toEqual(['older', 'newer']);
    expect(getLatestConnectorSync(connectors)).toBe('2026-08-08T00:00:00.000Z');
  });

  it('uses the same connector and sync requests for desktop and mobile consumers', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ connectors: [connector('one')], sourceLists: [] })))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));

    await expect(loadConnectorData({ includeDeleted: true, fetcher })).resolves.toMatchObject({
      connectors: [expect.objectContaining({ id: 'one' })],
    });
    await requestConnectorSync({ connectorId: 'one', full: true, fetcher });

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/connectors?includeDeleted=true');
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/sync', expect.objectContaining({
      body: JSON.stringify({ connectorId: 'one', full: true }),
    }));
  });
});
