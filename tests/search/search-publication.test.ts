import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  indexTask: vi.fn(async () => undefined),
  indexAlert: vi.fn(async () => undefined),
  removeTaskFromIndex: vi.fn(async () => undefined),
  removeAlertFromIndex: vi.fn(async () => undefined),
  publishSemanticUpsert: vi.fn(async () => ({ status: 'published' as const })),
  publishSemanticDelete: vi.fn(async () => ({ status: 'published' as const })),
}));

vi.mock('@/lib/search/fts', () => ({
  indexTask: mocks.indexTask,
  indexAlert: mocks.indexAlert,
  removeTaskFromIndex: mocks.removeTaskFromIndex,
  removeAlertFromIndex: mocks.removeAlertFromIndex,
  searchFTS: vi.fn(async () => []),
  rebuildSearchIndex: vi.fn(async () => undefined),
  warmUpFTS: vi.fn(async () => undefined),
}));

vi.mock('@/lib/search/semantic', () => ({
  semanticSearch: vi.fn(async () => []),
  getSemanticSearchMetrics: vi.fn(() => ({})),
  getSemanticSearchStatus: vi.fn(async () => ({ available: true, state: 'ready', note: null })),
  rebuildEmbeddingIndex: vi.fn(async () => ({ status: 'scheduled' })),
}));

vi.mock('@/lib/semantic-index/runtime', () => ({
  publishSemanticUpsert: mocks.publishSemanticUpsert,
  publishSemanticDelete: mocks.publishSemanticDelete,
}));

describe('search index publication', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
  });

  it('indexes keywords immediately and publishes a semantic upsert afterwards', async () => {
    const order: string[] = [];
    mocks.indexTask.mockImplementation(async () => { order.push('keyword'); });
    mocks.publishSemanticUpsert.mockImplementation(async () => {
      order.push('semantic');
      return { status: 'published' as const };
    });

    const { indexTaskSearch } = await import('@/lib/search');
    await indexTaskSearch({ id: 'task-1', title: 'Ship it' });

    expect(order).toEqual(['keyword', 'semantic']);
    expect(mocks.publishSemanticUpsert).toHaveBeenCalledWith('task', 'task-1');
  });

  it('publishes an alert upsert alongside keyword indexing', async () => {
    const { indexNotificationSearch } = await import('@/lib/search');
    await indexNotificationSearch({ id: 'alert-1', title: 'Sync failed' });

    expect(mocks.indexAlert).toHaveBeenCalledOnce();
    expect(mocks.publishSemanticUpsert).toHaveBeenCalledWith('alert', 'alert-1');
  });

  it('publishes semantic deletes alongside keyword removal', async () => {
    const { removeNotificationSearch, removeTaskSearch } = await import('@/lib/search');
    await removeTaskSearch('task-2');
    await removeNotificationSearch('alert-2');

    expect(mocks.removeTaskFromIndex).toHaveBeenCalledWith('task-2');
    expect(mocks.publishSemanticDelete).toHaveBeenCalledWith('task', 'task-2');
    expect(mocks.removeAlertFromIndex).toHaveBeenCalledWith('alert-2');
    expect(mocks.publishSemanticDelete).toHaveBeenCalledWith('alert', 'alert-2');
  });

  it('publishes projection-only updates without touching the keyword index', async () => {
    const { publishNotificationSemanticUpdate, publishTaskSemanticUpdate } =
      await import('@/lib/search');
    await publishTaskSemanticUpdate('task-3');
    await publishNotificationSemanticUpdate('alert-3');

    expect(mocks.indexTask).not.toHaveBeenCalled();
    expect(mocks.indexAlert).not.toHaveBeenCalled();
    expect(mocks.publishSemanticUpsert).toHaveBeenCalledWith('task', 'task-3');
    expect(mocks.publishSemanticUpsert).toHaveBeenCalledWith('alert', 'alert-3');
  });

  it('never fails a domain write when publication is dropped', async () => {
    mocks.publishSemanticUpsert.mockResolvedValue({
      status: 'skipped',
      reason: 'publish-failed',
    } as never);

    const { indexTaskSearch } = await import('@/lib/search');
    await expect(indexTaskSearch({ id: 'task-4', title: 'Still fine' })).resolves.toBeUndefined();

    expect(mocks.indexTask).toHaveBeenCalledOnce();
    expect(mocks.publishSemanticUpsert).toHaveBeenCalledWith('task', 'task-4');
  });

  it('never embeds or rebuilds while warming the search indexes', async () => {
    const fts = await import('@/lib/search/fts');
    const semantic = await import('@/lib/search/semantic');
    const { warmUpSearch } = await import('@/lib/search');

    await warmUpSearch();

    expect(fts.warmUpFTS).toHaveBeenCalledOnce();
    expect(semantic.rebuildEmbeddingIndex).not.toHaveBeenCalled();
  });
});
