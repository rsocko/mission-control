import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSearchIndexHarness,
  DIMENSIONS,
  MODEL,
  PROVIDER,
  T1,
  type SearchIndexHarness,
} from './harness';

const mocks = vi.hoisted(() => ({
  semanticSearchEnabled: true,
  runtime: null as unknown,
  scheduleSemanticBackfill: vi.fn(),
}));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => ({
    provider: 'openai',
    configured: true,
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'test',
    model: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    semanticSearchEnabled: mocks.semanticSearchEnabled,
  }),
}));

vi.mock('@/lib/semantic-index/runtime', () => ({
  getSemanticIndexRuntime: async () => mocks.runtime,
  scheduleSemanticBackfill: mocks.scheduleSemanticBackfill,
  publishSemanticUpsert: vi.fn(),
  publishSemanticDelete: vi.fn(),
}));

describe('semanticSearch over the durable index', () => {
  let harness: SearchIndexHarness;
  let semantic: typeof import('@/lib/search/semantic');

  beforeEach(async () => {
    vi.resetModules();
    mocks.semanticSearchEnabled = true;
    mocks.scheduleSemanticBackfill.mockReset();
    harness = createSearchIndexHarness();
    mocks.runtime = {
      repository: harness.repository,
      embeddings: harness.embeddings,
      config: {},
    };
    semantic = await import('@/lib/search/semantic');
    semantic.resetSemanticSearchStateForTests();
  });

  afterEach(() => {
    harness.close();
  });

  async function seedCorpus() {
    const indexId = await harness.createIdentity();
    await harness.seedEntity({
      entityType: 'task',
      entityId: 'near',
      title: 'Fix the urgent login bug',
      body: 'Sessions expire immediately after sign in.',
      metadata: {
        status: 'todo',
        priority: 'high',
        sourceListName: 'Project Alpha',
        connectorType: 'github-issues',
      },
      embedding: [1, 0.05, 0],
    });
    await harness.seedEntity({
      entityType: 'task',
      entityId: 'far',
      title: 'Water the plants',
      body: 'Weekly chore.',
      metadata: {
        status: 'done',
        priority: 'low',
        sourceListName: 'Home',
        connectorType: 'local',
      },
      embedding: [0, 0, 1],
    });
    await harness.seedEntity({
      entityType: 'alert',
      entityId: 'alert-1',
      title: 'Login service degraded',
      body: 'Error rate above threshold.',
      metadata: {
        level: 'critical',
        category: 'sync',
        readState: 'unread',
        isActionable: true,
        connectorType: 'monitoring',
        receivedAt: T1,
      },
      embedding: [0.95, 0.1, 0],
    });
    await harness.activate(indexId);
    return indexId;
  }

  it('maps task and notification results onto the existing SearchResult contract', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0]);

    const results = await semantic.semanticSearch('login problems', { limit: 10 });

    expect(results.map((result) => result.id)).toEqual(['near', 'alert-1']);
    expect(results[0]).toEqual({
      type: 'task',
      id: 'near',
      title: 'Fix the urgent login bug',
      snippet: 'Sessions expire immediately after sign in.',
      score: expect.any(Number),
      source: 'semantic',
      href: '/?taskId=near',
      metadata: {
        status: 'todo',
        priority: 'high',
        sourceListName: 'Project Alpha',
        connectorType: 'github-issues',
        updatedAt: T1,
      },
    });
    expect(results[1]).toMatchObject({
      type: 'notification',
      id: 'alert-1',
      href: '/notifications?id=alert-1',
      source: 'semantic',
      metadata: {
        severity: 'critical',
        category: 'sync',
        isRead: false,
        isActionable: true,
        connectorType: 'monitoring',
        receivedAt: T1,
      },
    });
  });

  it('scopes retrieval to the requested entity kinds', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0]);

    const tasksOnly = await semantic.semanticSearch('login', { type: 'tasks' });
    expect(tasksOnly.every((result) => result.type === 'task')).toBe(true);

    harness.embeddings.enqueueVector([1, 0, 0]);
    const alertsOnly = await semantic.semanticSearch('login', { type: 'notifications' });
    expect(alertsOnly.map((result) => result.id)).toEqual(['alert-1']);
  });

  it('excludes filtered rows before scoring instead of scanning them', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0]);

    const filtered = await semantic.semanticSearch('anything', {
      source: 'Project Alpha',
    });

    expect(filtered.map((result) => result.id)).toEqual(['near']);
    // Only the surviving candidate reached the scan, so an excluded row can
    // never displace an allowed one at the candidate ceiling.
    expect(semantic.getSemanticSearchMetrics().search.lastCandidates).toBe(1);
  });

  it('applies status and excludeDone filters through portable metadata predicates', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([0, 0, 1]);
    await expect(semantic.semanticSearch('chores', { status: 'done' }))
      .resolves.toMatchObject([{ id: 'far' }]);

    harness.embeddings.enqueueVector([0, 0, 1]);
    const excluded = await semantic.semanticSearch('chores', { excludeDone: true });
    expect(excluded.map((result) => result.id)).not.toContain('far');
    expect(semantic.getSemanticSearchMetrics().search.lastCandidates).toBe(2);
  });

  it('reads only the active identity, never a staged one', async () => {
    await seedCorpus();
    const staged = await harness.createIdentity({ id: 'idx-staged' });
    await harness.seedEntity({
      indexId: staged,
      entityType: 'task',
      entityId: 'staged-only',
      title: 'Staged corpus entry',
      embedding: [1, 0, 0],
      metadata: { status: 'todo', connectorType: 'local' },
    });
    await harness.repository.markIdentityReady(staged, T1);
    harness.embeddings.enqueueVector([1, 0, 0]);

    const results = await semantic.semanticSearch('anything', { limit: 10 });

    expect(results.map((result) => result.id)).not.toContain('staged-only');
    expect(results.map((result) => result.id)).toEqual(['near', 'alert-1']);
  });

  it('refuses to score a query vector from a different route or dimension count', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0], { model: 'other-embed-model' });
    await expect(semantic.semanticSearch('login')).resolves.toEqual([]);

    harness.embeddings.enqueueVector([1, 0, 0, 0]);
    await expect(semantic.semanticSearch('login again')).resolves.toEqual([]);
  });

  it('does not query the old vector space when the configured route moves on', async () => {
    await seedCorpus();
    harness.embeddings.route = {
      status: 'ok',
      route: { provider: PROVIDER, model: 'text-embedding-3-large' },
    };

    await expect(semantic.semanticSearch('login')).resolves.toEqual([]);
    expect(harness.embeddings.calls).toHaveLength(0);
    await expect(semantic.getSemanticSearchStatus()).resolves.toMatchObject({
      available: false,
      state: 'incompatible',
    });
  });

  it('caches the query embedding per identity and re-embeds after a cutover', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0]);

    await semantic.semanticSearch('  Urgent   BUG ');
    await semantic.semanticSearch('urgent bug');
    expect(harness.embeddings.calls).toHaveLength(1);

    const replacement = await harness.createIdentity({ id: 'idx-replacement' });
    await harness.seedEntity({
      indexId: replacement,
      entityType: 'task',
      entityId: 'near',
      title: 'Fix the urgent login bug',
      embedding: [1, 0, 0],
      metadata: { status: 'todo', connectorType: 'github-issues' },
    });
    await harness.activate(replacement, T1);
    harness.embeddings.enqueueVector([1, 0, 0]);

    const afterCutover = await semantic.semanticSearch('urgent bug');
    expect(harness.embeddings.calls).toHaveLength(2);
    expect(afterCutover.map((result) => result.id)).toEqual(['near']);
  });

  it('returns nothing — and embeds nothing — when the index is not ready', async () => {
    await harness.createIdentity();
    await expect(semantic.semanticSearch('login')).resolves.toEqual([]);
    expect(harness.embeddings.calls).toHaveLength(0);
  });

  it('never rebuilds or backfills from an interactive query or status read', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0]);

    await semantic.semanticSearch('login');
    await semantic.getSemanticSearchStatus();

    // Exactly one provider call: the query itself. No corpus embedding, no
    // backfill scheduling from a request path.
    expect(harness.embeddings.calls).toHaveLength(1);
    expect(harness.embeddings.calls[0].expect).toEqual({
      provider: PROVIDER,
      model: MODEL,
      dimensions: DIMENSIONS,
    });
    expect(mocks.scheduleSemanticBackfill).not.toHaveBeenCalled();
  });

  it('reports the bounded scan honestly through retrieval metrics', async () => {
    await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0]);
    await semantic.semanticSearch('login');

    expect(semantic.getSemanticSearchMetrics().search).toMatchObject({
      searches: 1,
      lastCandidates: 3,
      candidateLimit: 100,
      truncatedScans: 0,
    });
  });

  it('turns a rebuild request into a durable backfill schedule', async () => {
    mocks.scheduleSemanticBackfill.mockResolvedValue({
      status: 'scheduled',
      indexId: 'idx-1',
      runId: 'run-1',
      runStatus: 'queued',
    });

    await expect(semantic.rebuildEmbeddingIndex()).resolves.toMatchObject({
      status: 'scheduled',
      runId: 'run-1',
    });
    expect(mocks.scheduleSemanticBackfill).toHaveBeenCalledOnce();
    expect(harness.embeddings.calls).toHaveLength(0);
  });

  it('degrades to keyword-only when the index errors mid-query', async () => {
    const indexId = await seedCorpus();
    harness.embeddings.enqueueVector([1, 0, 0]);
    // The identity is retired between resolution and the scan — the repository
    // then refuses to serve it, which must not surface as a search failure.
    const original = harness.repository.queryVectors.bind(harness.repository);
    harness.repository.queryVectors = async () => {
      harness.repository.queryVectors = original;
      throw new Error(`identity ${indexId} is retired`);
    };

    await expect(semantic.semanticSearch('login')).resolves.toEqual([]);
    expect(semantic.getSemanticSearchMetrics().search.retrievalErrors).toBe(1);

    await expect(semantic.findSimilarTaskEmbeddings('near')).resolves.toMatchObject({
      status: 'available',
    });
  });

  it('degrades neighbour lookups instead of throwing into the graph service', async () => {
    await seedCorpus();
    harness.repository.getVector = async () => {
      throw new Error('storage unavailable');
    };

    await expect(semantic.findSimilarTaskEmbeddings('near')).resolves.toMatchObject({
      status: 'unavailable',
      neighbors: [],
    });
    expect(semantic.getSemanticSearchMetrics().search.retrievalErrors).toBe(1);
  });

  it('degrades status to unconfigured when readiness cannot be read', async () => {
    await seedCorpus();
    harness.repository.getReadiness = async () => {
      throw new Error('storage unavailable');
    };

    await expect(semantic.getSemanticSearchStatus()).resolves.toMatchObject({
      available: false,
      state: 'unconfigured',
      index: null,
    });
  });
});
