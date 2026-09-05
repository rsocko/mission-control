import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  getSearchStatus: vi.fn(),
  listDeletedIds: vi.fn(),
  searchWithBranches: vi.fn(),
}));

vi.mock('@/lib/search/semantic', () => mocks);
vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    connectors: { listDeletedIds: mocks.listDeletedIds },
  }),
}));
vi.mock('@/lib/telemetry/operations', () => ({
  withRuntimeOperation: vi.fn((_operation, run: () => unknown) => run()),
}));

describe('AI search route', () => {
  beforeEach(() => {
    mocks.getSearchStatus.mockReset();
    mocks.listDeletedIds.mockReset();
    mocks.searchWithBranches.mockReset();
    mocks.calls.length = 0;
    mocks.listDeletedIds.mockResolvedValue(['deleted-connector']);
    mocks.getSearchStatus.mockResolvedValue({
      available: true,
      enabled: true,
      state: 'ready',
      note: null,
      semanticMetrics: {
        queryCache: { hits: 2 },
        index: {
          active: {
            id: 'idx-1',
            provider: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 3,
            vectorCount: 12,
          },
          staging: [],
          totals: { documents: 12, vectors: 12, stale: 0, incompatible: 0, expired: 0 },
          intents: { queued: 0, permanentFailures: 0 },
          scan: { kind: 'bounded-in-process', candidateCeiling: 5000 },
        },
      },
    });
  });

  it('reports semantic opt-in, readiness, and cache metrics without searching', async () => {
    const { GET } = await import('@/app/api/ai/search/route');
    const response = await GET(new Request(
      'http://localhost/api/ai/search?q=__status_check__&mode=hybrid',
    ));
    const body = await response.json();

    expect(body).toMatchObject({
      semanticEnabled: true,
      semanticAvailable: true,
      semanticState: 'ready',
      semanticMetrics: { queryCache: { hits: 2 } },
      branches: {},
      results: [],
    });
    expect(body.semanticIndex).toMatchObject({
      active: { provider: 'openai', model: 'text-embedding-3-small', vectorCount: 12 },
      staging: [],
      totals: { stale: 0, incompatible: 0 },
      scan: { kind: 'bounded-in-process' },
    });
    expect(JSON.stringify(body)).not.toContain('embedding":[');
    expect(mocks.searchWithBranches).not.toHaveBeenCalled();
    expect(mocks.listDeletedIds).not.toHaveBeenCalled();
  });

  it('returns explicit branch timings with keyword results', async () => {
    mocks.searchWithBranches.mockResolvedValue({
      results: [{ type: 'task', id: 'task-1' }],
      branches: {
        keyword: { status: 'completed', durationMs: 3, resultCount: 1 },
      },
    });
    mocks.getSearchStatus.mockResolvedValue({
      available: true,
      enabled: false,
      state: 'not-requested',
      note: null,
      semanticMetrics: null,
    });
    const { GET } = await import('@/app/api/ai/search/route');
    const response = await GET(new Request(
      'http://localhost/api/ai/search?q=urgent&mode=keyword&source=Project%20Alpha&status=in_progress&excludeDone=true',
    ));
    const body = await response.json();

    expect(body).toMatchObject({
      mode: 'keyword',
      total: 1,
      branches: {
        keyword: { status: 'completed', durationMs: 3, resultCount: 1 },
      },
    });
    expect(mocks.searchWithBranches).toHaveBeenCalledWith(
      'urgent',
      {
        type: 'all',
        mode: 'keyword',
        limit: 20,
        source: 'Project Alpha',
        status: 'in_progress',
        excludeDone: true,
      },
    );
  });

  it('derives the Universe visibility scope before searching', async () => {
    mocks.searchWithBranches.mockResolvedValue({ results: [], branches: {} });
    const { GET } = await import('@/app/api/ai/search/route');
    await GET(new Request(
      'http://localhost/api/ai/search?q=planning&type=tasks&mode=hybrid&universeEligible=true',
    ));

    expect(mocks.searchWithBranches).toHaveBeenCalledWith('planning', expect.objectContaining({
      type: 'tasks',
      universeEligible: true,
      excludeConnectorInstanceIds: ['deleted-connector'],
    }));
  });

  it('starts search and status concurrently only after resolving the privacy scope', async () => {
    let resolveDeletedIds!: (ids: string[]) => void;
    const deletedIds = new Promise<string[]>((resolve) => {
      resolveDeletedIds = resolve;
    });
    mocks.listDeletedIds.mockImplementation(async () => {
      mocks.calls.push('privacy-start');
      const ids = await deletedIds;
      mocks.calls.push('privacy-end');
      return ids;
    });
    mocks.searchWithBranches.mockImplementation(async () => {
      mocks.calls.push('search');
      return { results: [], branches: {} };
    });
    mocks.getSearchStatus.mockImplementation(async () => {
      mocks.calls.push('status');
      return {
        available: true,
        enabled: false,
        state: 'not-requested',
        note: null,
        semanticMetrics: null,
      };
    });

    const { GET } = await import('@/app/api/ai/search/route');
    const response = GET(new Request(
      'http://localhost/api/ai/search?q=planning&mode=hybrid&universeEligible=true',
    ));
    await Promise.resolve();
    expect(mocks.calls).toEqual(['privacy-start']);

    resolveDeletedIds(['deleted-b', 'deleted-a']);
    await expect(response).resolves.toHaveProperty('status', 200);
    expect(mocks.calls).toEqual(['privacy-start', 'privacy-end', 'search', 'status']);
  });

  it('does not start search or status when privacy scope resolution fails', async () => {
    mocks.listDeletedIds.mockRejectedValue(new Error('visibility unavailable'));

    const { GET } = await import('@/app/api/ai/search/route');
    await expect(GET(new Request(
      'http://localhost/api/ai/search?q=planning&mode=hybrid&universeEligible=true',
    ))).rejects.toThrow('visibility unavailable');
    expect(mocks.searchWithBranches).not.toHaveBeenCalled();
    expect(mocks.getSearchStatus).not.toHaveBeenCalled();
  });
});
