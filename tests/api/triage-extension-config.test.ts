import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSettingsGet = vi.fn();
const mockSettingsSet = vi.fn();

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositoriesForBackend: async () => ({
    settings: {
      get: mockSettingsGet,
      set: mockSettingsSet,
    },
  }),
}));
vi.mock('@/lib/triage/capture-auth', () => ({
  hasValidTriageCaptureKey: () => true,
}));

function request(method: 'GET' | 'PUT', body?: unknown): Request {
  return new Request('http://localhost/api/triage/extension-config', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('triage extension config API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsGet.mockResolvedValue(null);
    mockSettingsSet.mockResolvedValue(undefined);
  });

  it('returns the extension defaults when no override is stored', async () => {
    const { GET } = await import('@/app/api/triage/extension-config/route');

    const response = await GET(request('GET'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      config: {
        platforms: {
          reddit: { enabled: true, maxPages: 50, batchSize: 25, includedLists: [], excludedLists: [] },
          instagram: { enabled: true, maxPages: 50, batchSize: 25, includedLists: [], excludedLists: [] },
          facebook: { enabled: true, maxPages: 60, batchSize: 25, includedLists: [], excludedLists: [] },
          tiktok: { enabled: true, maxPages: 100, batchSize: 25, includedLists: [], excludedLists: [] },
          pinterest: { enabled: true, maxPages: 100, batchSize: 25, includedLists: [], excludedLists: [] },
        },
      },
    });
  });

  it('merges stored platform overrides with defaults', async () => {
    mockSettingsGet.mockResolvedValue({
      platforms: {
        instagram: {
          enabled: false,
          maxPages: 12,
        },
      },
    });
    const { GET } = await import('@/app/api/triage/extension-config/route');

    const response = await GET(request('GET'));
    const body = await response.json();

    expect(body.config.platforms.instagram).toEqual({
      enabled: false,
      maxPages: 12,
      batchSize: 25,
      includedLists: [],
      excludedLists: [],
    });
    expect(body.config.platforms.reddit.maxPages).toBe(50);
  });

  it('merges a valid patch and persists the complete config', async () => {
    mockSettingsGet.mockResolvedValue({
      platforms: {
        instagram: {
          enabled: true,
          maxPages: 40,
          batchSize: 25,
          includedLists: [],
          excludedLists: [],
        },
      },
    });
    const { PUT } = await import('@/app/api/triage/extension-config/route');

    const response = await PUT(request('PUT', {
      platforms: {
        instagram: {
          enabled: false,
          maxPages: 30,
          includedLists: ['saved'],
        },
      },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.config.platforms.instagram).toEqual({
      enabled: false,
      maxPages: 30,
      batchSize: 25,
      includedLists: ['saved'],
      excludedLists: [],
    });
    expect(mockSettingsSet).toHaveBeenCalledWith(
      'triage_extension_scrape_config',
      {
        platforms: expect.objectContaining({
          instagram: {
            enabled: false,
            maxPages: 30,
            batchSize: 25,
            includedLists: ['saved'],
            excludedLists: [],
          },
        }),
      },
    );
  });

  it('rejects invalid platform fields without writing persistence', async () => {
    const { PUT } = await import('@/app/api/triage/extension-config/route');

    const response = await PUT(request('PUT', {
      platforms: {
        instagram: {
          maxPages: 0,
        },
      },
    }));

    expect(response.status).toBe(400);
    expect(mockSettingsSet).not.toHaveBeenCalled();
  });
});
