import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchFTS: vi.fn(),
  semanticSearch: vi.fn(),
}));

vi.mock('@/lib/search/fts', () => ({
  searchFTS: mocks.searchFTS,
  indexAlert: vi.fn(),
  indexTask: vi.fn(),
  removeAlertFromIndex: vi.fn(),
  removeTaskFromIndex: vi.fn(),
  rebuildSearchIndex: vi.fn(),
  warmUpFTS: vi.fn(),
}));

vi.mock('@/lib/search/semantic', () => ({
  semanticSearch: mocks.semanticSearch,
  getSemanticSearchMetrics: vi.fn(),
  getSemanticSearchStatus: vi.fn(),
  rebuildEmbeddingIndex: vi.fn(),
}));

vi.mock('@/lib/semantic-index/runtime', () => ({
  publishSemanticUpsert: vi.fn(async () => ({ status: 'published' })),
  publishSemanticDelete: vi.fn(async () => ({ status: 'published' })),
}));

describe('staged search execution', () => {
  beforeEach(() => {
    mocks.searchFTS.mockReset();
    mocks.semanticSearch.mockReset();
  });

  it('returns an explicit keyword request without starting or awaiting semantic work', async () => {
    const keywordResult = {
      type: 'task' as const,
      id: 'task-1',
      title: 'Fix urgent bug',
      snippet: '',
      score: 1,
      source: 'fts' as const,
      href: '/?taskId=task-1',
      metadata: {},
    };
    mocks.searchFTS.mockResolvedValue([keywordResult]);
    mocks.semanticSearch.mockImplementation(() => new Promise(() => undefined));

    const { searchWithBranches } = await import('@/lib/search');
    await expect(searchWithBranches('urgent bug', { mode: 'keyword' })).resolves.toMatchObject({
      results: [keywordResult],
      branches: {
        keyword: { status: 'completed', resultCount: 1 },
      },
    });
    expect(mocks.semanticSearch).not.toHaveBeenCalled();
  });

  it('passes source, status, and done filters into keyword retrieval', async () => {
    mocks.searchFTS.mockResolvedValue([{
      type: 'task',
      id: 'keep',
      title: 'Keep',
      score: 1,
      metadata: {},
    }]);

    const { searchWithBranches } = await import('@/lib/search');
    const execution = await searchWithBranches('project', {
      mode: 'keyword',
      source: 'Project Alpha',
      status: 'in_progress',
      excludeDone: true,
      limit: 20,
    });

    expect(execution.results.map((result) => result.id)).toEqual(['keep']);
    expect(mocks.searchFTS).toHaveBeenCalledWith(
      'project',
      {
        type: 'all',
        limit: 20,
        source: 'Project Alpha',
        status: 'in_progress',
        excludeDone: true,
      },
    );
  });

  it('passes the same filters into semantic retrieval', async () => {
    mocks.semanticSearch.mockResolvedValue([]);

    const { searchWithBranches } = await import('@/lib/search');
    await searchWithBranches('project', {
      mode: 'semantic',
      source: 'Project Alpha',
      status: 'in_progress',
      excludeDone: true,
      limit: 20,
    });

    expect(mocks.semanticSearch).toHaveBeenCalledWith(
      'project',
      {
        type: 'all',
        limit: 20,
        source: 'Project Alpha',
        status: 'in_progress',
        excludeDone: true,
      },
    );
  });

  it('keeps serving keyword results when semantic retrieval returns nothing', async () => {
    mocks.searchFTS.mockResolvedValue([{
      type: 'task',
      id: 'keyword-only',
      title: 'Keyword only',
      snippet: '',
      score: 1,
      source: 'fts',
      href: '/?taskId=keyword-only',
      metadata: {},
    }]);
    mocks.semanticSearch.mockResolvedValue([]);

    const { searchWithBranches } = await import('@/lib/search');
    const execution = await searchWithBranches('urgent', { mode: 'hybrid' });

    expect(execution.results.map((result) => result.id)).toEqual(['keyword-only']);
    expect(execution.branches.semantic).toMatchObject({ resultCount: 0 });
  });
});
