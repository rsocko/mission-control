/**
 * GitHub Stars Importer Tests — #162
 *
 * Covers:
 *  - importGitHubStars: single-page fetch, response parsing, dedup
 *  - importAllGitHubStars: pagination, incremental early-stop, sync-state upsert
 *  - parseGitHubNextCursor: Link-header parsing
 *  - fetchWithRateLimit: 429 retry logic
 *  - API route handler: mode dispatch and error handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRun = vi.fn();

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(),
    })),
    run: mockRun,
  },
}));

vi.mock('@/db/schema', () => ({
  triageSyncState: { id: 'id' },
  triageItems: {
    id: 'id',
    sourcePlatform: 'source_platform',
    sourceId: 'source_id',
    sourceUrl: 'source_url',
    canonicalUrl: 'canonical_url',
  },
}));

vi.mock('@/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

// We mock the triage capture module so ingestTriageImport is controllable
const mockIngest = vi.fn();
vi.mock('@/lib/triage/capture', () => ({
  ingestTriageImport: mockIngest,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStarResponse(repos: Array<{ full_name: string; html_url: string; description?: string }>, linkNext?: number) {
  const body = repos.map((r) => ({
    starred_at: '2026-06-01T00:00:00Z',
    repo: {
      full_name: r.full_name,
      html_url: r.html_url,
      description: r.description ?? null,
      stargazers_count: 42,
      language: 'TypeScript',
      topics: ['test'],
      owner: { login: r.full_name.split('/')[0] },
      fork: false,
    },
  }));

  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (linkNext) {
    headers.set('link', `<https://api.github.com/user/starred?page=${linkNext}>; rel="next"`);
  }

  return new Response(JSON.stringify(body), { status: 200, headers });
}

function make429Response(retryAfter?: string) {
  const headers = new Headers();
  if (retryAfter) headers.set('Retry-After', retryAfter);
  return new Response('rate limited', { status: 429, headers });
}

// ─── importGitHubStars ──────────────────────────────────────────────────────

describe('importGitHubStars', () => {
  let importGitHubStars: typeof import('@/lib/triage/importers').importGitHubStars;

  beforeEach(async () => {
    vi.resetModules();
    global.fetch = vi.fn();
    mockIngest.mockReset();

    // Re-mock the ingest at the module level
    vi.doMock('@/lib/triage', () => ({
      ingestTriageImport: mockIngest,
    }));

    const mod = await import('@/lib/triage/importers');
    importGitHubStars = mod.importGitHubStars;
  });

  it('should import starred repos from a single page', async () => {
    const repos = [
      { full_name: 'octocat/hello-world', html_url: 'https://github.com/octocat/hello-world' },
      { full_name: 'octocat/spoon-knife', html_url: 'https://github.com/octocat/spoon-knife' },
    ];
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeStarResponse(repos));
    mockIngest.mockResolvedValue({ status: 'imported' });

    const summary = await importGitHubStars({ token: 'ghp_test123' });

    expect(summary.imported).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toHaveLength(0);

    // Verify fetch was called with correct params
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as URL;
    expect(url.toString()).toContain('/user/starred');
    expect(url.searchParams.get('sort')).toBe('created');
    expect(url.searchParams.get('direction')).toBe('desc');

    const headers = fetchCall[1].headers;
    expect(headers.Accept).toBe('application/vnd.github.star+json');
    expect(headers.Authorization).toContain('Bearer');
  });

  it('should use username endpoint when username is provided', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeStarResponse([]));

    await importGitHubStars({ token: 'ghp_test', username: 'testuser' });

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(url.toString()).toContain('/users/testuser/starred');
  });

  it('should count skipped items when ingest returns skipped', async () => {
    const repos = [
      { full_name: 'octocat/hello-world', html_url: 'https://github.com/octocat/hello-world' },
    ];
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeStarResponse(repos));
    mockIngest.mockResolvedValue({ status: 'skipped', reason: 'Already ingested' });

    const summary = await importGitHubStars({ token: 'ghp_test' });

    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('should skip rows missing full_name or html_url', async () => {
    const body = [{ starred_at: '2026-01-01', repo: { full_name: '', html_url: '' } }];
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const summary = await importGitHubStars({ token: 'ghp_test' });

    expect(summary.skipped).toBe(1);
    expect(summary.errors).toContain('Skipped GitHub row missing full_name/html_url');
  });

  it('should parse nextCursor from Link header', async () => {
    const repos = [{ full_name: 'a/b', html_url: 'https://github.com/a/b' }];
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeStarResponse(repos, 3));
    mockIngest.mockResolvedValue({ status: 'imported' });

    const summary = await importGitHubStars({ token: 'ghp_test' });

    expect(summary.nextCursor).toBe('3');
  });

  it('should throw on non-ok response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    await expect(importGitHubStars({ token: 'bad' })).rejects.toThrow('GitHub stars import failed: 401');
  });

  it('should clamp perPage between 1 and 100', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeStarResponse([]));

    await importGitHubStars({ token: 'ghp_test', perPage: 200 });

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as URL;
    expect(url.searchParams.get('per_page')).toBe('100');
  });
});

// ─── importAllGitHubStars ───────────────────────────────────────────────────

describe('importAllGitHubStars', () => {
  let importAllGitHubStars: typeof import('@/lib/triage/importers').importAllGitHubStars;

  beforeEach(async () => {
    vi.resetModules();
    global.fetch = vi.fn();
    mockIngest.mockReset();
    mockRun.mockReset();

    vi.doMock('@/lib/triage', () => ({
      ingestTriageImport: mockIngest,
    }));

    const mod = await import('@/lib/triage/importers');
    importAllGitHubStars = mod.importAllGitHubStars;
  });

  it('should paginate through all pages until no nextCursor', async () => {
    const repos1 = [{ full_name: 'a/one', html_url: 'https://github.com/a/one' }];
    const repos2 = [{ full_name: 'a/two', html_url: 'https://github.com/a/two' }];

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeStarResponse(repos1, 2))
      .mockResolvedValueOnce(makeStarResponse(repos2)); // no next link → stop

    mockIngest.mockResolvedValue({ status: 'imported' });

    const result = await importAllGitHubStars({ token: 'ghp_test' });

    expect(result.imported).toBe(2);
    expect(result.pagesProcessed).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should stop early in incremental mode after consecutive skips', async () => {
    // Simulate all items already ingested (all skipped)
    const repos = Array.from({ length: 25 }, (_, i) => ({
      full_name: `org/repo-${i}`,
      html_url: `https://github.com/org/repo-${i}`,
    }));

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeStarResponse(repos, 2));
    mockIngest.mockResolvedValue({ status: 'skipped', reason: 'Already ingested' });

    const result = await importAllGitHubStars({ token: 'ghp_test', incremental: true });

    // Should stop after first page since 25 consecutive skips >= threshold of 20
    expect(result.pagesProcessed).toBe(1);
    expect(result.skipped).toBe(25);
    expect(result.imported).toBe(0);
  });

  it('should upsert sync state after completion', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeStarResponse([]));

    await importAllGitHubStars({ token: 'ghp_test' });

    expect(mockRun).toHaveBeenCalled();
  });
});

// ─── fetchWithRateLimit (tested via importGitHubStars) ──────────────────────

describe('rate limit handling', () => {
  let importGitHubStars: typeof import('@/lib/triage/importers').importGitHubStars;

  beforeEach(async () => {
    vi.resetModules();
    global.fetch = vi.fn();
    mockIngest.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vi.doMock('@/lib/triage', () => ({
      ingestTriageImport: mockIngest,
    }));

    const mod = await import('@/lib/triage/importers');
    importGitHubStars = mod.importGitHubStars;
  });

  it('should retry on 429 and succeed on subsequent attempt', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(make429Response('1'))
      .mockResolvedValueOnce(makeStarResponse([{ full_name: 'a/b', html_url: 'https://github.com/a/b' }]));
    mockIngest.mockResolvedValue({ status: 'imported' });

    const summaryPromise = importGitHubStars({ token: 'ghp_test' });

    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(2000);
    const summary = await summaryPromise;

    expect(summary.imported).toBe(1);
    expect((global.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

// ─── API Route ──────────────────────────────────────────────────────────────

describe('POST /api/triage/import/github-stars', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return 400 if no GitHub credentials are configured', async () => {
    vi.doMock('@/lib/triage/credentials', () => ({
      resolveGitHubCredentials: vi.fn(() => Promise.resolve(null)),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importGitHubStars: vi.fn(),
      importAllGitHubStars: vi.fn(),
    }));

    const { POST } = await import('@/app/api/triage/import/github-stars/route');

    const req = new Request('http://localhost/api/triage/import/github-stars', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toContain('GitHub PAT is required');
  });

  it('should call importAllGitHubStars for full mode', async () => {
    const mockFullImport = vi.fn().mockResolvedValue({
      imported: 10,
      skipped: 2,
      pagesProcessed: 3,
      durationMs: 1500,
      errors: [],
      lastCursor: null,
    });

    vi.doMock('@/lib/triage/credentials', () => ({
      resolveGitHubCredentials: vi.fn(() =>
        Promise.resolve({ token: 'ghp_test', source: 'env' as const }),
      ),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importGitHubStars: vi.fn(),
      importAllGitHubStars: mockFullImport,
    }));

    const { POST } = await import('@/app/api/triage/import/github-stars/route');

    const req = new Request('http://localhost/api/triage/import/github-stars', {
      method: 'POST',
      body: JSON.stringify({ mode: 'full' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.result.imported).toBe(10);
    expect(data.mode).toBe('full');
    expect(mockFullImport).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'ghp_test', incremental: false }),
    );
  });

  it('should call importGitHubStars for single mode', async () => {
    const mockSingleImport = vi.fn().mockResolvedValue({
      imported: 5,
      skipped: 0,
      errors: [],
      nextCursor: '2',
    });

    vi.doMock('@/lib/triage/credentials', () => ({
      resolveGitHubCredentials: vi.fn(() =>
        Promise.resolve({ token: 'ghp_test', source: 'env' as const }),
      ),
    }));
    vi.doMock('@/lib/triage/importers', () => ({
      importGitHubStars: mockSingleImport,
      importAllGitHubStars: vi.fn(),
    }));

    const { POST } = await import('@/app/api/triage/import/github-stars/route');

    const req = new Request('http://localhost/api/triage/import/github-stars', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.summary.imported).toBe(5);
  });
});
