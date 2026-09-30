import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchPageV2 = vi.hoisted(() => vi.fn());
const fetchPage = vi.hoisted(() => vi.fn());
const createCompanionActionClient = vi.hoisted(() => vi.fn(() => ({
  fetchPage,
  fetchPageV2,
})));

vi.mock('@/lib/connectors/rymessage/companion-action-client', () => ({
  createCompanionActionClient,
}));

import { POST } from '@/app/api/connectors/test-pre-save/route';
import { RyMessageConnector } from '@/lib/connectors/rymessage';

const previousToken = process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN;

afterEach(() => {
  vi.clearAllMocks();
  if (previousToken === undefined) {
    delete process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN;
  } else {
    process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN = previousToken;
  }
});

function request(settings: Record<string, unknown>) {
  return new Request('http://localhost/api/connectors/test-pre-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'rymessage', settings }),
  });
}

describe('RyMessage Companion connector setup', () => {
  it('requires exact origins and an environment-only web runtime credential', async () => {
    delete process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN;
    const response = await POST(request({
      mode: 'companion',
      companionBaseUrl: 'http://companion:8080',
      trustedMissionControlOrigin: 'http://localhost:3099',
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('web runtime'),
    });
    expect(createCompanionActionClient).not.toHaveBeenCalled();

    process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN = 'secret';
    const invalidOrigin = await POST(request({
      mode: 'companion',
      companionBaseUrl: 'http://companion:8080',
      trustedMissionControlOrigin: 'http://localhost:3099/path',
    }));
    await expect(invalidOrigin.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('exact Mission Control'),
    });
  });

  it('tests the V2 feed without persisting or returning the bearer', async () => {
    process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN = 'secret-value';
    fetchPageV2.mockResolvedValue({
      schemaVersion: '2.0',
      items: [],
    });
    const response = await POST(request({
      mode: 'companion',
      companionBaseUrl: 'http://companion:8080/',
      trustedMissionControlOrigin: 'HTTP://LOCALHOST:3099',
      credentialEnv: 'RYMESSAGE_COMPANION_ACTION_FEED_TOKEN',
    }));
    const payload = await response.json();
    expect(payload).toMatchObject({
      success: true,
      details: 'Connected to Companion ActionV2 2.0',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-value');
    expect(createCompanionActionClient).toHaveBeenCalledWith({
      baseUrl: 'http://companion:8080',
      credential: 'secret-value',
      maxRetries: 0,
      trustedMissionControlOrigin: 'http://localhost:3099',
    });
    expect(fetchPageV2).toHaveBeenCalledWith(null);
  });

  it('keeps existing ActionV1 connector settings operational without V2 configuration', async () => {
    process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN = 'secret-value';
    fetchPage.mockResolvedValue({ schemaVersion: '1.0', items: [] });
    const connector = new RyMessageConnector();
    await connector.initialize({
      id: 'rymessage-v1',
      type: 'rymessage',
      name: 'Existing RyMessage',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: {
        read: true,
        write: false,
        delete: false,
        sync: true,
        lists: false,
        subtasks: false,
        tags: false,
        tagWriteBack: false,
      },
      credentials: {},
      settings: {
        mode: 'companion',
        companionBaseUrl: 'http://companion:8080',
      },
      syncedLists: [],
    });
    await expect(connector.testConnection()).resolves.toEqual({
      success: true,
      message: expect.stringContaining('ActionV1 feed'),
    });
    expect(fetchPage).toHaveBeenCalledWith(null);
    expect(fetchPageV2).not.toHaveBeenCalled();
  });

  it('uses only ActionV2 for configured connector connection checks', async () => {
    process.env.RYMESSAGE_COMPANION_ACTION_FEED_TOKEN = 'secret-value';
    fetchPage.mockRejectedValue(new Error('integration_scope_required'));
    fetchPageV2.mockResolvedValue({ schemaVersion: '2.0', items: [] });
    const connector = new RyMessageConnector();
    await connector.initialize({
      id: 'rymessage-v2',
      type: 'rymessage',
      name: 'RyMessage',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: {
        read: true,
        write: false,
        delete: false,
        sync: true,
        lists: false,
        subtasks: false,
        tags: false,
        tagWriteBack: false,
      },
      credentials: {},
      settings: {
        mode: 'companion',
        companionBaseUrl: 'http://companion:8080',
        trustedMissionControlOrigin: 'http://localhost:3099',
      },
      syncedLists: [],
    });

    await expect(connector.testConnection()).resolves.toEqual({
      success: true,
      message: 'Connected to Companion ActionV2 feed',
    });
    expect(fetchPageV2).toHaveBeenCalledWith(null);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
