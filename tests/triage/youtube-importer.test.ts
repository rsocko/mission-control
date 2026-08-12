/**
 * YouTube Data API v3 Importer Tests
 *
 * Covers:
 *  - parseDescriptionLinks: URL extraction and domain classification
 *  - importYouTubePlaylist: single page fetch and ingest
 *  - importAllYouTubePlaylist: pagination, safety limits, incremental mode
 *  - importAllYouTubePlaylists: multi-playlist orchestration
 *  - getYouTubeAccessToken: OAuth token exchange
 *  - API route handler: mode dispatch, error handling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockIngest = vi.fn();
const mockUpsertSyncState = vi.fn();

vi.mock('@/lib/triage', () => ({
  ingestTriageImport: mockIngest,
}));

vi.mock('@/lib/triage/sync-state', () => ({
  upsertSyncState: mockUpsertSyncState,
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

const mockFetchWithRateLimit = vi.fn();

vi.mock('@/lib/triage/importers/base-importer', () => ({
  fetchWithRateLimit: mockFetchWithRateLimit,
  IMPORT_USER_AGENT: 'mission-control-triage-importer/1.0',
  MAX_PAGES: 50,
}));

// ─── parseDescriptionLinks ──────────────────────────────────────────────────

describe('parseDescriptionLinks', () => {
  let parseDescriptionLinks: typeof import('@/lib/triage/importers/youtube-importer').parseDescriptionLinks;

  beforeEach(async () => {
    const mod = await import('@/lib/triage/importers/youtube-importer');
    parseDescriptionLinks = mod.parseDescriptionLinks;
  });

  it('extracts GitHub repo URLs as github_repo', () => {
    const links = parseDescriptionLinks('Check out https://github.com/octocat/hello-world for more');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://github.com/octocat/hello-world');
    expect(links[0].category).toBe('github_repo');
    expect(links[0].position).toBe(0);
  });

  it('classifies Thingiverse URLs as 3d_model', () => {
    const links = parseDescriptionLinks('Download: https://www.thingiverse.com/thing:12345');
    expect(links[0].category).toBe('3d_model');
  });

  it('classifies Printables URLs as 3d_model', () => {
    const links = parseDescriptionLinks('Model: https://www.printables.com/model/12345');
    expect(links[0].category).toBe('3d_model');
  });

  it('classifies MakerWorld URLs as 3d_model', () => {
    const links = parseDescriptionLinks('https://makerworld.com/en/models/123');
    expect(links[0].category).toBe('3d_model');
  });

  it('classifies Amazon URLs as product', () => {
    const links = parseDescriptionLinks('Buy here: https://www.amazon.com/dp/B01234 and also https://www.aliexpress.com/item/456.html');
    expect(links[0].category).toBe('product');
    expect(links[1].category).toBe('product');
  });

  it('classifies generic URLs as link', () => {
    const links = parseDescriptionLinks('Visit https://example.com/page for details');
    expect(links[0].category).toBe('link');
  });

  it('strips trailing punctuation from URLs', () => {
    const links = parseDescriptionLinks('See https://github.com/foo/bar.');
    expect(links[0].url).toBe('https://github.com/foo/bar');
  });

  it('handles multiple trailing punctuation characters', () => {
    const links = parseDescriptionLinks('Link: https://example.com/path),');
    expect(links[0].url).toBe('https://example.com/path');
  });

  it('returns empty array for null/undefined description', () => {
    expect(parseDescriptionLinks(null)).toEqual([]);
    expect(parseDescriptionLinks(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseDescriptionLinks('')).toEqual([]);
  });

  it('returns empty array when no links in description', () => {
    expect(parseDescriptionLinks('Just a plain text description with no links')).toEqual([]);
  });

  it('extracts multiple links with correct positions', () => {
    const description = 'First https://github.com/a/b then https://printables.com/model/1 finally https://example.com';
    const links = parseDescriptionLinks(description);
    expect(links).toHaveLength(3);
    expect(links[0].position).toBe(0);
    expect(links[1].position).toBe(1);
    expect(links[2].position).toBe(2);
  });
});

// ─── getYouTubeAccessToken ──────────────────────────────────────────────────

describe('getYouTubeAccessToken', () => {
  let getYouTubeAccessToken: typeof import('@/lib/triage/importers/youtube-importer').getYouTubeAccessToken;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/lib/triage', () => ({ ingestTriageImport: mockIngest }));
    vi.doMock('@/lib/triage/sync-state', () => ({ upsertSyncState: mockUpsertSyncState }));
    vi.doMock('@/lib/triage/importers/base-importer', () => ({
      fetchWithRateLimit: mockFetchWithRateLimit,
      IMPORT_USER_AGENT: 'mission-control-triage-importer/1.0',
      MAX_PAGES: 50,
    }));

    const mod = await import('@/lib/triage/importers/youtube-importer');
    getYouTubeAccessToken = mod.getYouTubeAccessToken;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns access token on successful exchange', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.test-token' }),
    });

    const token = await getYouTubeAccessToken({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    expect(token).toBe('ya29.test-token');
  });

  it('throws on HTTP error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      getYouTubeAccessToken({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'bad-refresh',
      }),
    ).rejects.toThrow('YouTube token exchange failed: 401 Unauthorized');
  });

  it('throws when response lacks access_token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 'invalid_grant' }),
    });

    await expect(
      getYouTubeAccessToken({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      }),
    ).rejects.toThrow('YouTube token exchange did not return access_token');
  });
});

// ─── importYouTubePlaylist ──────────────────────────────────────────────────

describe('importYouTubePlaylist', () => {
  let importYouTubePlaylist: typeof import('@/lib/triage/importers/youtube-importer').importYouTubePlaylist;

  beforeEach(async () => {
    vi.resetModules();
    mockIngest.mockReset();
    mockFetchWithRateLimit.mockReset();
    vi.doMock('@/lib/triage', () => ({ ingestTriageImport: mockIngest }));
    vi.doMock('@/lib/triage/sync-state', () => ({ upsertSyncState: mockUpsertSyncState }));
    vi.doMock('@/lib/triage/importers/base-importer', () => ({
      fetchWithRateLimit: mockFetchWithRateLimit,
      IMPORT_USER_AGENT: 'mission-control-triage-importer/1.0',
      MAX_PAGES: 50,
    }));

    const mod = await import('@/lib/triage/importers/youtube-importer');
    importYouTubePlaylist = mod.importYouTubePlaylist;
  });

  it('imports valid playlist items and returns pagination token', async () => {
    mockFetchWithRateLimit.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        nextPageToken: 'next-page-abc',
        items: [
          {
            snippet: {
              title: 'Cool Video',
              description: 'Check https://github.com/foo/bar',
              publishedAt: '2024-03-15T10:00:00Z',
              videoOwnerChannelTitle: 'Test Channel',
              videoOwnerChannelId: 'UC123',
              thumbnails: { high: { url: 'https://i.ytimg.com/vi/abc/hq.jpg' } },
            },
            contentDetails: { videoId: 'abc123', videoPublishedAt: '2024-01-01T00:00:00Z' },
          },
        ],
      }),
    });
    mockIngest.mockResolvedValue({ status: 'imported' });

    const summary = await importYouTubePlaylist({
      accessToken: 'token',
      playlistId: 'PLtest',
    });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.nextCursor).toBe('next-page-abc');
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePlatform: 'youtube',
        sourceId: 'youtube:video:abc123',
        sourceUrl: 'https://www.youtube.com/watch?v=abc123',
        title: 'Cool Video',
      }),
    );
  });

  it('skips deleted/private videos', async () => {
    mockFetchWithRateLimit.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        items: [
          {
            snippet: { title: 'Deleted video' },
            contentDetails: { videoId: 'del1' },
          },
          {
            snippet: { title: 'Private video' },
            contentDetails: { videoId: 'priv1' },
          },
          {
            snippet: { title: null },
            contentDetails: { videoId: 'noTitle' },
          },
        ],
      }),
    });

    const summary = await importYouTubePlaylist({
      accessToken: 'token',
      playlistId: 'PLtest',
    });

    expect(summary.skipped).toBe(3);
    expect(summary.imported).toBe(0);
    expect(mockIngest).not.toHaveBeenCalled();
    expect(summary.errors).toHaveLength(3);
  });

  it('throws on API error response', async () => {
    mockFetchWithRateLimit.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(
      importYouTubePlaylist({ accessToken: 'token', playlistId: 'PLtest' }),
    ).rejects.toThrow('YouTube playlist import failed (PLtest): 403 Forbidden');
  });

  it('counts duplicate items as skipped', async () => {
    mockFetchWithRateLimit.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        items: [
          {
            snippet: { title: 'Already Seen', description: '' },
            contentDetails: { videoId: 'dup1' },
          },
        ],
      }),
    });
    mockIngest.mockResolvedValue({ status: 'skipped', reason: 'Already ingested' });

    const summary = await importYouTubePlaylist({
      accessToken: 'token',
      playlistId: 'PLtest',
    });

    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

// ─── importAllYouTubePlaylist ───────────────────────────────────────────────

describe('importAllYouTubePlaylist', () => {
  let importAllYouTubePlaylist: typeof import('@/lib/triage/importers/youtube-importer').importAllYouTubePlaylist;

  beforeEach(async () => {
    vi.resetModules();
    mockIngest.mockReset();
    mockFetchWithRateLimit.mockReset();
    mockUpsertSyncState.mockReset();
    vi.doMock('@/lib/triage', () => ({ ingestTriageImport: mockIngest }));
    vi.doMock('@/lib/triage/sync-state', () => ({ upsertSyncState: mockUpsertSyncState }));
    vi.doMock('@/lib/triage/importers/base-importer', () => ({
      fetchWithRateLimit: mockFetchWithRateLimit,
      IMPORT_USER_AGENT: 'mission-control-triage-importer/1.0',
      MAX_PAGES: 50,
    }));

    const mod = await import('@/lib/triage/importers/youtube-importer');
    importAllYouTubePlaylist = mod.importAllYouTubePlaylist;
  });

  it('pages through multiple pages until no nextPageToken', async () => {
    mockFetchWithRateLimit
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          nextPageToken: 'page2',
          items: [{ snippet: { title: 'V1' }, contentDetails: { videoId: 'v1' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          items: [{ snippet: { title: 'V2' }, contentDetails: { videoId: 'v2' } }],
        }),
      });
    mockIngest.mockResolvedValue({ status: 'imported' });
    mockUpsertSyncState.mockResolvedValue(undefined);

    const result = await importAllYouTubePlaylist({
      accessToken: 'token',
      playlistId: 'PLmulti',
    });

    expect(result.pagesProcessed).toBe(2);
    expect(result.imported).toBe(2);
    expect(mockUpsertSyncState).toHaveBeenCalledWith(
      'youtube-PLmulti',
      expect.objectContaining({ imported: 2 }),
    );
  });

  it('stops at safety limit (MAX_PAGES = 50)', async () => {
    // Always return a next page token so it would loop forever without the limit
    mockFetchWithRateLimit.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          nextPageToken: 'next',
          items: [{ snippet: { title: 'V' }, contentDetails: { videoId: 'v' } }],
        }),
      }),
    );
    mockIngest.mockResolvedValue({ status: 'imported' });
    mockUpsertSyncState.mockResolvedValue(undefined);

    const result = await importAllYouTubePlaylist({
      accessToken: 'token',
      playlistId: 'PLhuge',
    });

    expect(result.pagesProcessed).toBe(50);
  });

  it('early exits on consecutive skips in incremental mode', async () => {
    // Return 50 skipped items per page (no imports) to trigger the threshold
    mockFetchWithRateLimit.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          nextPageToken: 'more',
          items: Array.from({ length: 50 }, (_, i) => ({
            snippet: { title: `Old ${i}` },
            contentDetails: { videoId: `old${i}` },
          })),
        }),
      }),
    );
    mockIngest.mockResolvedValue({ status: 'skipped', reason: 'Already ingested' });
    mockUpsertSyncState.mockResolvedValue(undefined);

    const result = await importAllYouTubePlaylist({
      accessToken: 'token',
      playlistId: 'PLincr',
      incremental: true,
    });

    // Should exit after first page (50 consecutive skips >= threshold of 50)
    expect(result.pagesProcessed).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(50);
  });

  it('records sync state with lastCursor', async () => {
    mockFetchWithRateLimit.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        items: [{ snippet: { title: 'Solo' }, contentDetails: { videoId: 'solo1' } }],
      }),
    });
    mockIngest.mockResolvedValue({ status: 'imported' });
    mockUpsertSyncState.mockResolvedValue(undefined);

    await importAllYouTubePlaylist({
      accessToken: 'token',
      playlistId: 'PLsync',
    });

    expect(mockUpsertSyncState).toHaveBeenCalledWith(
      'youtube-PLsync',
      expect.objectContaining({
        imported: 1,
        skipped: 0,
      }),
    );
  });
});

// ─── importAllYouTubePlaylists ──────────────────────────────────────────────

describe('importAllYouTubePlaylists', () => {
  let importAllYouTubePlaylists: typeof import('@/lib/triage/importers/youtube-importer').importAllYouTubePlaylists;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    mockIngest.mockReset();
    mockFetchWithRateLimit.mockReset();
    mockUpsertSyncState.mockReset();
    vi.doMock('@/lib/triage', () => ({ ingestTriageImport: mockIngest }));
    vi.doMock('@/lib/triage/sync-state', () => ({ upsertSyncState: mockUpsertSyncState }));
    vi.doMock('@/lib/triage/importers/base-importer', () => ({
      fetchWithRateLimit: mockFetchWithRateLimit,
      IMPORT_USER_AGENT: 'mission-control-triage-importer/1.0',
      MAX_PAGES: 50,
    }));

    const mod = await import('@/lib/triage/importers/youtube-importer');
    importAllYouTubePlaylists = mod.importAllYouTubePlaylists;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('processes multiple playlists with a single OAuth token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.shared' }),
    });

    // Each playlist returns one item
    mockFetchWithRateLimit.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        items: [{ snippet: { title: 'Item' }, contentDetails: { videoId: 'v1' } }],
      }),
    });
    mockIngest.mockResolvedValue({ status: 'imported' });
    mockUpsertSyncState.mockResolvedValue(undefined);

    const result = await importAllYouTubePlaylists({
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rt',
      playlistIds: ['PL1', 'PL2'],
    });

    // One token exchange
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // Two playlists fetched
    expect(mockFetchWithRateLimit).toHaveBeenCalledTimes(2);
    expect(result.imported).toBe(2);
  });

  it('defaults to WL + LL when no playlist IDs configured', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.default' }),
    });

    mockFetchWithRateLimit.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    });
    mockUpsertSyncState.mockResolvedValue(undefined);

    await importAllYouTubePlaylists({
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rt',
      playlistIds: [],
    });

    // Should have fetched WL and LL
    expect(mockFetchWithRateLimit).toHaveBeenCalledTimes(2);
    const firstCallUrl = mockFetchWithRateLimit.mock.calls[0][0] as URL;
    const secondCallUrl = mockFetchWithRateLimit.mock.calls[1][0] as URL;
    expect(firstCallUrl.searchParams.get('playlistId')).toBe('WL');
    expect(secondCallUrl.searchParams.get('playlistId')).toBe('LL');
  });

  it('catches errors from individual playlists without aborting others', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'ya29.ok' }),
    });

    mockFetchWithRateLimit
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          items: [{ snippet: { title: 'Good' }, contentDetails: { videoId: 'g1' } }],
        }),
      });
    mockIngest.mockResolvedValue({ status: 'imported' });
    mockUpsertSyncState.mockResolvedValue(undefined);

    const result = await importAllYouTubePlaylists({
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rt',
      playlistIds: ['PLbad', 'PLgood'],
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Failed to import playlist PLbad');
    expect(result.imported).toBe(1);
  });
});

// ─── API Route ──────────────────────────────────────────────────────────────

describe('POST /api/triage/import/youtube', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeRequest(body: unknown) {
    return new Request('http://localhost/api/triage/import/youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 400 when credentials are missing', async () => {
    vi.doMock('@/lib/triage/credentials', () => ({
      resolveYouTubeCredentials: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylists: vi.fn(),
      getYouTubeAccessToken: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { POST } = await import('@/app/api/triage/import/youtube/route');
    const res = await POST(makeRequest({ playlistId: 'PL123' }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('credentials');
  });

  it('handles single mode import', async () => {
    const mockSingleImport = vi.fn().mockResolvedValue({
      imported: 2,
      skipped: 0,
      errors: [],
      nextCursor: null,
    });

    vi.doMock('@/lib/triage/credentials', () => ({
      resolveYouTubeCredentials: vi.fn().mockResolvedValue({
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rt',
        playlistIds: ['PL1'],
      }),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importYouTubePlaylist: mockSingleImport,
      importAllYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylists: vi.fn(),
      getYouTubeAccessToken: vi.fn().mockResolvedValue('ya29.test'),
    }));
    vi.doMock('@/lib/logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { POST } = await import('@/app/api/triage/import/youtube/route');
    const res = await POST(makeRequest({ playlistId: 'PL123', mode: 'single' }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary.imported).toBe(2);
    expect(mockSingleImport).toHaveBeenCalledWith(
      expect.objectContaining({ playlistId: 'PL123', accessToken: 'ya29.test' }),
    );
  });

  it('handles full mode import', async () => {
    const mockFullImport = vi.fn().mockResolvedValue({
      imported: 10,
      skipped: 2,
      errors: [],
      pagesProcessed: 3,
      durationMs: 500,
      lastCursor: null,
    });

    vi.doMock('@/lib/triage/credentials', () => ({
      resolveYouTubeCredentials: vi.fn().mockResolvedValue({
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rt',
        playlistIds: ['WL'],
      }),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylists: mockFullImport,
      getYouTubeAccessToken: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { POST } = await import('@/app/api/triage/import/youtube/route');
    const res = await POST(makeRequest({ mode: 'full' }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.imported).toBe(10);
    expect(data.mode).toBe('full');
    expect(mockFullImport).toHaveBeenCalledWith(
      expect.objectContaining({ incremental: false }),
    );
  });

  it('handles incremental mode import', async () => {
    const mockFullImport = vi.fn().mockResolvedValue({
      imported: 3,
      skipped: 5,
      errors: [],
      pagesProcessed: 1,
      durationMs: 200,
      lastCursor: null,
    });

    vi.doMock('@/lib/triage/credentials', () => ({
      resolveYouTubeCredentials: vi.fn().mockResolvedValue({
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'rt',
        playlistIds: ['WL'],
      }),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylists: mockFullImport,
      getYouTubeAccessToken: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { POST } = await import('@/app/api/triage/import/youtube/route');
    const res = await POST(makeRequest({ mode: 'incremental' }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mode).toBe('incremental');
    expect(mockFullImport).toHaveBeenCalledWith(
      expect.objectContaining({ incremental: true }),
    );
  });

  it('returns 500 on unexpected error', async () => {
    vi.doMock('@/lib/triage/credentials', () => ({
      resolveYouTubeCredentials: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylist: vi.fn(),
      importAllYouTubePlaylists: vi.fn(),
      getYouTubeAccessToken: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { POST } = await import('@/app/api/triage/import/youtube/route');
    const res = await POST(makeRequest({ playlistId: 'PL1' }));

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Failed to import');
  });
});
