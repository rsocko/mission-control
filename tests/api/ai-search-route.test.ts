import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSearchStatus: vi.fn(),
  searchWithBranches: vi.fn(),
}));

vi.mock('@/lib/search', () => mocks);
vi.mock('@/lib/telemetry/operations', () => ({
  withRuntimeOperation: vi.fn((_operation, run: () => unknown) => run()),
}));

describe('AI search route', () => {
  beforeEach(() => {
    mocks.getSearchStatus.mockReset();
    mocks.searchWithBranches.mockReset();
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
});
