import { afterEach, describe, expect, it, vi } from 'vitest';
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
