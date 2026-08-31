import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockBatchIngest = vi.fn();
const mockGetSyncState = vi.fn();
const mockRecordSyncRun = vi.fn();

vi.mock('@/lib/triage/import-capture', () => ({
  ingestTriageImports: mockBatchIngest,
}));

vi.mock('@/lib/triage/sync-state', () => ({
  getSyncState: mockGetSyncState,
  recordSyncRun: mockRecordSyncRun,
}));

vi.mock('@/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe('Reddit scheduled importer', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSyncState.mockResolvedValue(null);
    mockRecordSyncRun.mockResolvedValue({ status: 'applied' });
    mockBatchIngest.mockImplementation(async (inputs: unknown[]) =>
      inputs.map(() => ({ status: 'imported' })));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('persists each remote page as one ordered capture batch', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          after: null,
          children: [
            {
              kind: 't3',
              data: {
                name: 't3_first',
                permalink: '/r/test/comments/first',
                title: 'First',
                created_utc: 1,
              },
            },
            {
              kind: 't1',
              data: {
                name: 't1_second',
                permalink: '/r/test/comments/second',
                body: 'Second',
                created_utc: 2,
              },
            },
          ],
        },
      }), { status: 200 }));
    const { importRedditSaved } = await import('@/lib/triage/importers/reddit-importer');

    const summary = await importRedditSaved({
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      refreshToken: 'synthetic-refresh',
      username: 'octocat',
      startIndex: 10,
    });

    expect(summary).toMatchObject({ imported: 2, skipped: 0 });
    expect(mockBatchIngest).toHaveBeenCalledTimes(1);
    expect(mockBatchIngest.mock.calls[0][0]).toMatchObject([
      { sourceId: 'reddit:t3_first', sourceOrder: 10 },
      { sourceId: 'reddit:t1_second', sourceOrder: 11 },
    ]);
  });

  it('returns a secret-safe failure and records it once', async () => {
    const secret = 'synthetic-reddit-secret';
    global.fetch = vi.fn().mockRejectedValue(new Error(`network failed ${secret}`));
    const { importAllRedditSaved } = await import('@/lib/triage/importers/reddit-importer');

    const result = await importAllRedditSaved({
      clientId: 'synthetic-client',
      clientSecret: secret,
      refreshToken: 'synthetic-refresh',
      username: 'octocat',
    });

    expect(result.outcome).toBe('failure');
    expect(JSON.stringify(result.errors)).not.toContain(secret);
    expect(JSON.stringify(mockRecordSyncRun.mock.calls)).not.toContain(secret);
    expect(mockRecordSyncRun).toHaveBeenCalledTimes(1);
  });
});
