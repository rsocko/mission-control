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

    const { executeSearchWithBranches } = await import('@/lib/search/semantic');
    await expect(executeSearchWithBranches(
      'urgent bug',
      { mode: 'keyword' },
      mocks.semanticSearch,
    )).resolves.toMatchObject({
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

    const { executeSearchWithBranches } = await import('@/lib/search/semantic');
    const execution = await executeSearchWithBranches('project', {
      mode: 'keyword',
      source: 'Project Alpha',
      status: 'in_progress',
      excludeDone: true,
      limit: 20,
    }, mocks.semanticSearch);

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

    const { executeSearchWithBranches } = await import('@/lib/search/semantic');
    await executeSearchWithBranches('project', {
      mode: 'semantic',
      source: 'Project Alpha',
      status: 'in_progress',
      excludeDone: true,
      limit: 20,
    }, mocks.semanticSearch);

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

    const { executeSearchWithBranches } = await import('@/lib/search/semantic');
    const execution = await executeSearchWithBranches(
      'urgent',
      { mode: 'hybrid' },
      mocks.semanticSearch,
    );

    expect(execution.results.map((result) => result.id)).toEqual(['keyword-only']);
    expect(execution.branches.semantic).toMatchObject({ resultCount: 0 });
  });

  it('applies the same eligibility filters to both hybrid channels', async () => {
    mocks.searchFTS.mockResolvedValue([]);
    mocks.semanticSearch.mockResolvedValue([]);

    const { executeSearchWithBranches } = await import('@/lib/search/semantic');
    await executeSearchWithBranches('deploy', {
      mode: 'hybrid',
      source: 'Project Alpha',
      status: 'todo',
      excludeDone: true,
    }, mocks.semanticSearch);

    const expectedFilters = {
      source: 'Project Alpha',
      status: 'todo',
      excludeDone: true,
    };
    expect(mocks.searchFTS).toHaveBeenCalledTimes(2);
    expect(mocks.semanticSearch).toHaveBeenCalledTimes(2);
    for (const scope of ['tasks', 'notifications']) {
      expect(mocks.searchFTS).toHaveBeenCalledWith(
        'deploy',
        expect.objectContaining({ ...expectedFilters, type: scope }),
      );
      expect(mocks.semanticSearch).toHaveBeenCalledWith(
        'deploy',
        expect.objectContaining({ ...expectedFilters, type: scope }),
      );
    }
  });
});
