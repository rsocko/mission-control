import { afterEach, describe, expect, it, vi } from 'vitest';

// outlook-email/outlook-calendar route Graph requests through the shared graph-client,
// which resolves tokens via '@/lib/auth' (getValidToken auto-refreshes, invalidateToken
// forces a refresh on 401). Mock it directly rather than exercising the real persistence-
// backed refresh flow — that's covered separately in tests/lib/auth.
vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(async () => 'test-token'),
  getSubstrateToken: vi.fn(async () => 'test-token'),
  invalidateToken: vi.fn(),
}));

// Import the connectors barrel first: it eagerly wires up `registerDefaultConnectorFactories()`
// during module evaluation, and that function reads each connector's factory export
// synchronously. Importing an individual connector submodule first here would create a
// circular-require ordering issue (connectors/index.ts <-> outlook-email/index.ts) where
// the factory is read before its module finishes evaluating, crashing with
// "Cannot read properties of undefined (reading 'notificationTypes')".
import '@/lib/connectors';
import { outlookEmailFactory } from '@/lib/connectors/outlook-email';
import { outlookCalendarFactory } from '@/lib/connectors/outlook-calendar';
import type { ConnectorConfig } from '@/types';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'conn-1',
    type: 'outlook-email',
    name: 'Test',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 10,
    capabilities: {} as ConnectorConfig['capabilities'],
    credentials: { accessToken: 'expired-token' },
    settings: {},
    syncedLists: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OutlookEmailConnector — auth failure surfacing', () => {
  it('throws instead of silently returning [] when the Graph token is expired (fetchNotifications)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    const connector = outlookEmailFactory.create();
    await connector.initialize(makeConfig());

    await expect(connector.fetchNotifications()).rejects.toThrow(/token expired/i);
  });

  it('throws instead of silently returning [] when the Graph token is expired (fetchSourceLists)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    const connector = outlookEmailFactory.create();
    await connector.initialize(makeConfig());

    await expect(connector.fetchSourceLists()).rejects.toThrow(/token expired/i);
  });
});

describe('OutlookEmailConnector — folder scope', () => {
  it('fetches notifications from Inbox only by default', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => (
      Response.json({ value: [] }, { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const connector = outlookEmailFactory.create();
    await connector.initialize(makeConfig());

    await connector.fetchNotifications(new Date('2026-09-01T00:00:00.000Z'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/me/mailFolders/inbox/messages?');
    expect(fetchMock.mock.calls[0][0]).not.toContain('/me/messages?');
  });

  it('fetches only explicitly configured folders when present', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => (
      Response.json({ value: [] }, { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const connector = outlookEmailFactory.create();
    await connector.initialize(makeConfig({
      syncedLists: ['conn-1:folder-a', 'folder-b'],
    }));

    await connector.fetchNotifications(new Date('2026-09-01T00:00:00.000Z'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining('/me/mailFolders/folder-a/messages?'),
      expect.stringContaining('/me/mailFolders/folder-b/messages?'),
    ]);
  });
});

describe('OutlookCalendarConnector — auth failure surfacing', () => {
  it('throws instead of silently returning [] when the Graph token is expired (fetchNotifications)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    const connector = outlookCalendarFactory.create();
    await connector.initialize(makeConfig({ type: 'outlook-calendar' }));

    await expect(connector.fetchNotifications()).rejects.toThrow(/token expired/i);
  });

  it('throws instead of silently returning [] when the Graph token is expired (fetchSourceLists)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    const connector = outlookCalendarFactory.create();
    await connector.initialize(makeConfig({ type: 'outlook-calendar' }));

    await expect(connector.fetchSourceLists()).rejects.toThrow(/token expired/i);
  });
});

describe('OutlookEmailConnector / OutlookCalendarConnector — token auto-refresh', () => {
  it('resolves the access token via getValidToken (not a static cached token) and invalidates it on a 401 before giving up', async () => {
    const auth = await import('@/lib/auth');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

    const connector = outlookEmailFactory.create();
    await connector.initialize(makeConfig());

    await expect(connector.fetchNotifications()).rejects.toThrow(/token expired/i);

    // Proves the connector no longer captures accessToken once at initialize() and
    // reuses it forever — it asks the shared auth layer for a (possibly refreshed)
    // token on every Graph call, and forces a refresh when Graph rejects it with 401.
    expect(auth.getValidToken).toHaveBeenCalledWith('conn-1');
    expect(auth.invalidateToken).toHaveBeenCalledWith('conn-1');
  });

  it('recovers on a subsequent call once getValidToken returns a fresh token', async () => {
    const auth = await import('@/lib/auth');
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount += 1;
      // The shared graph-client retries once in-place on a 401 (invalidating the
      // cached token first), so a fully-stale token causes two 401 responses within
      // a single connector call before it gives up. Simulate that stale run, then a
      // later run where the (now refreshed) token succeeds immediately.
      return callCount <= 2
        ? new Response('{}', { status: 401 })
        : Response.json({ value: [] }, { status: 200 });
    }));

    const connector = outlookCalendarFactory.create();
    await connector.initialize(makeConfig({ type: 'outlook-calendar' }));

    await expect(connector.fetchSourceLists()).rejects.toThrow(/token expired/i);
    await expect(connector.fetchSourceLists()).resolves.toEqual([]);

    expect(auth.getValidToken).toHaveBeenCalledWith('conn-1');
  });
});
