import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCOUT_SETTINGS } from '@/lib/connectors/scout/settings';

const createConnector = vi.fn(async () => true);
const ensureSourceLists = vi.fn(async () => undefined);
const getConnector = vi.fn();
const updateConnector = vi.fn(async () => true);
const projectExists = vi.fn(async () => true);

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => ({
    createConnector,
    ensureSourceLists,
    getConnector,
    updateConnector,
    projectExists,
  })),
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    initializeConnectorFromDb: vi.fn(),
    reconcileScheduleFromDb: vi.fn(async () => undefined),
  },
}));

describe('Scout connector settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnector.mockResolvedValue(null);
  });

  it('stores complete defaults for new Scout connectors', async () => {
    const { POST } = await import('@/app/api/connectors/route');
    const response = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'scout-primary',
        type: 'scout',
        name: 'Scout',
        settings: {},
      }),
    }));

    expect(response.status).toBe(201);
    expect(createConnector).toHaveBeenCalledWith(expect.objectContaining({
      id: 'scout-primary',
      settings: DEFAULT_SCOUT_SETTINGS,
    }));
    expect(ensureSourceLists).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ connectorInstanceId: 'scout-primary' }),
    ]));
  });

  it('delegates GitHub creation to the atomic management repository operation', async () => {
    const { POST } = await import('@/app/api/connectors/route');
    const response = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'github-primary',
        type: 'github-issues',
        name: 'GitHub',
        credentials: { token: 'secret' },
        settings: { repos: ['owner/repo'] },
      }),
    }));

    expect(response.status).toBe(201);
    expect(createConnector).toHaveBeenCalledWith(expect.objectContaining({
      id: 'github-primary',
      type: 'github-issues',
    }));
    expect(createConnector).toHaveBeenCalledTimes(1);
  });

  it('rejects GitHub connectors with an untrusted identity origin', async () => {
    const { POST } = await import('@/app/api/connectors/route');
    const response = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'github-insecure',
        type: 'github-issues',
        name: 'GitHub',
        settings: { apiOrigin: 'http://github.example.com/api/v3' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it('rejects invalid Scout settings updates', async () => {
    getConnector.mockResolvedValue({
      id: 'scout-primary',
      type: 'scout',
      settings: DEFAULT_SCOUT_SETTINGS,
      updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const { PATCH } = await import('@/app/api/connectors/route');
    const response = await PATCH(new Request('http://localhost/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'scout-primary',
        settings: {
          ...DEFAULT_SCOUT_SETTINGS,
          landingMode: 'invalid',
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(updateConnector).not.toHaveBeenCalled();
  });

  it('persists validated Scout settings updates', async () => {
    getConnector.mockResolvedValue({
      id: 'scout-primary',
      type: 'scout',
      settings: DEFAULT_SCOUT_SETTINGS,
      updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const { PATCH } = await import('@/app/api/connectors/route');
    const settings = {
      ...DEFAULT_SCOUT_SETTINGS,
      landingMode: 'triage' as const,
      allowedSourceTypes: ['email', 'meeting'] as const,
    };
    const response = await PATCH(new Request('http://localhost/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'scout-primary', settings }),
    }));

    expect(response.status).toBe(200);
    expect(updateConnector).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: 'scout-primary',
      updates: expect.objectContaining({
        settings: {
          ...settings,
          allowedSourceTypes: ['email', 'meeting'],
        },
      }),
    }));
  });
});
