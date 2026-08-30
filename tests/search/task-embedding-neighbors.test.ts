import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSearchIndexHarness,
  MODEL,
  PROVIDER,
  T1,
  T2,
  type SearchIndexHarness,
} from './harness';

const mocks = vi.hoisted(() => ({
  semanticSearchEnabled: true,
  runtime: null as unknown,
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
  scheduleSemanticBackfill: vi.fn(),
  publishSemanticUpsert: vi.fn(),
  publishSemanticDelete: vi.fn(),
}));

describe('findSimilarTaskEmbeddings', () => {
  let harness: SearchIndexHarness;
  let semantic: typeof import('@/lib/search/semantic');

  beforeEach(async () => {
    vi.resetModules();
    mocks.semanticSearchEnabled = true;
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

  async function seedNeighbourCorpus() {
    const indexId = await harness.createIdentity();
    await harness.seedEntity({
      entityType: 'task',
      entityId: 'source',
      title: 'Source task',
      embedding: [1, 0, 0],
      embeddedAt: T1,
    });
    await harness.seedEntity({
      entityType: 'task',
      entityId: 'near',
      title: 'Near task',
      embedding: [0.9, 0.1, 0],
      embeddedAt: T2,
      metadata: { connectorInstanceId: 'deleted-connector' },
    });
    await harness.seedEntity({
      entityType: 'task',
      entityId: 'far',
      title: 'Far task',
      embedding: [0, 0, 1],
      metadata: { connectorInstanceId: 'active-connector' },
    });
    await harness.seedEntity({
      entityType: 'alert',
      entityId: 'alert-near',
      title: 'Near alert',
      embedding: [1, 0, 0],
    });
    await harness.activate(indexId);
    return indexId;
  }

  it('ranks neighbours from the stored vector without embedding anything', async () => {
    const indexId = await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', { limit: 5, minScore: 0 });

    expect(result).toMatchObject({
      status: 'available',
      provider: PROVIDER,
      model: MODEL,
      indexId,
      projectionVersion: 1,
      sourceUpdatedAt: T1,
      sourceEmbeddedAt: T1,
    });
    if (result.status !== 'available') throw new Error('expected available neighbours');
    // Self is excluded, alerts are out of scope, and the closer task ranks first.
    expect(result.neighbors.map((neighbor) => neighbor.taskId)).toEqual(['near', 'far']);
    expect(result.neighbors[0]).toMatchObject({
      sourceUpdatedAt: T1,
      embeddedAt: T2,
    });
    expect(result.neighbors[0].score).toBeGreaterThan(result.neighbors[1].score);
    expect(harness.embeddings.calls).toHaveLength(0);
  });

  it('reports the resolved route identity that produced the neighbour vectors', async () => {
    // The active identity was created from a real provider response, so it may
    // name a fallback route rather than the configured one. Callers render this
    // identity, so it must be the resolved route and never the configured proxy.
    const fallbackIndexId = await harness.createIdentity({
      id: 'idx-fallback',
      model: 'fallback-embed-model',
    });
    await harness.seedEntity({
      indexId: fallbackIndexId,
      entityType: 'task',
      entityId: 'source',
      title: 'Source task',
      embedding: [1, 0, 0],
      embeddedAt: T1,
      model: 'fallback-embed-model',
    });
    await harness.seedEntity({
      indexId: fallbackIndexId,
      entityType: 'task',
      entityId: 'near',
      title: 'Near task',
      embedding: [0.9, 0.1, 0],
      embeddedAt: T2,
      model: 'fallback-embed-model',
    });
    await harness.activate(fallbackIndexId);
    harness.embeddings.route = {
      status: 'ok',
      route: { provider: PROVIDER, model: 'fallback-embed-model' },
    };

    const result = await semantic.findSimilarTaskEmbeddings('source', { limit: 5, minScore: 0 });

    expect(result).toMatchObject({
      status: 'available',
      provider: PROVIDER,
      model: 'fallback-embed-model',
    });
    if (result.status !== 'available') throw new Error('expected available neighbours');
    expect(result.neighbors.map((neighbor) => neighbor.taskId)).toEqual(['near']);
    expect(harness.embeddings.calls).toHaveLength(0);
  });

  it('bounds the neighbour count', async () => {
    await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', { limit: 1, minScore: 0 });
    if (result.status !== 'available') throw new Error('expected available neighbours');
    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0].taskId).toBe('near');
  });

  it('applies eligibility before scoring and candidate counts', async () => {
    await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', {
      limit: 5,
      minScore: 0,
      eligibleTaskIds: ['far'],
    });

    if (result.status !== 'available') throw new Error('expected available neighbours');
    expect(result.neighbors.map((neighbor) => neighbor.taskId)).toEqual(['far']);
    expect(result.candidateCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('accepts large eligibility scopes without expanding SQL parameters', async () => {
    await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', {
      limit: 5,
      minScore: 0,
      eligibleTaskIds: [
        ...Array.from({ length: 40_000 }, (_, index) => `eligible-${index}`),
        'far',
      ],
    });

    if (result.status !== 'available') throw new Error('expected available neighbours');
    expect(result.neighbors.map((neighbor) => neighbor.taskId)).toEqual(['far']);
    expect(result.candidateCount).toBe(1);
  });

  it('returns no candidates for an explicitly empty eligibility scope', async () => {
    await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', {
      limit: 5,
      minScore: 0,
      eligibleTaskIds: [],
    });

    if (result.status !== 'available') throw new Error('expected available neighbours');
    expect(result.neighbors).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('excludes deleted connector instances before scoring', async () => {
    await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', {
      limit: 5,
      minScore: 0,
      excludedConnectorInstanceIds: ['deleted-connector'],
    });

    if (result.status !== 'available') throw new Error('expected available neighbours');
    expect(result.neighbors.map((neighbor) => neighbor.taskId)).toEqual(['far']);
    expect(result.candidateCount).toBe(1);
  });

  it('honours the minimum score', async () => {
    await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', { limit: 5 });
    if (result.status !== 'available') throw new Error('expected available neighbours');
    expect(result.neighbors.map((neighbor) => neighbor.taskId)).toEqual(['near']);
  });

  it('reports partial when the bounded repository scan reaches its ceiling', async () => {
    harness.close();
    harness = createSearchIndexHarness(1);
    mocks.runtime = {
      repository: harness.repository,
      embeddings: harness.embeddings,
      config: {},
    };
    await seedNeighbourCorpus();

    const result = await semantic.findSimilarTaskEmbeddings('source', {
      limit: 5,
      minScore: 0,
    });

    expect(result).toMatchObject({
      status: 'partial',
      candidateCount: 1,
      truncated: true,
      note: expect.stringContaining('partial'),
    });
  });

  it('reports missing when the task has no vector in the active identity', async () => {
    await seedNeighbourCorpus();

    await expect(semantic.findSimilarTaskEmbeddings('never-indexed')).resolves.toMatchObject({
      status: 'missing',
      neighbors: [],
    });
  });

  it('reports stale when the document has moved past its vector', async () => {
    const indexId = await harness.createIdentity();
    await harness.seedEntity({
      entityType: 'task',
      entityId: 'drifted',
      title: 'Drifted task',
      embedding: [1, 0, 0],
      stale: true,
    });
    await harness.activate(indexId);

    await expect(semantic.findSimilarTaskEmbeddings('drifted')).resolves.toMatchObject({
      status: 'stale',
      neighbors: [],
    });
    expect(harness.embeddings.calls).toHaveLength(0);
  });

  it('reports incompatible when the stored vector is in a foreign space', async () => {
    const indexId = await seedNeighbourCorpus();
    // Only legacy/adopted rows can be in a foreign space beneath a live
    // identity, so this is written beneath the repository's write validation.
    harness.db.prepare(`
      UPDATE semantic_vectors SET model = 'legacy-model'
      WHERE index_id = ? AND entity_type = 'task' AND entity_id = 'source'
    `).run(indexId);

    await expect(semantic.findSimilarTaskEmbeddings('source')).resolves.toMatchObject({
      status: 'incompatible',
      neighbors: [],
    });
  });

  it('reports unavailable when no identity is active or the feature is off', async () => {
    await harness.createIdentity();
    await expect(semantic.findSimilarTaskEmbeddings('source')).resolves.toMatchObject({
      status: 'unavailable',
      neighbors: [],
    });

    mocks.semanticSearchEnabled = false;
    await expect(semantic.findSimilarTaskEmbeddings('source')).resolves.toMatchObject({
      status: 'unavailable',
      neighbors: [],
    });
  });

  it('reports unavailable rather than querying an old space after a route change', async () => {
    await seedNeighbourCorpus();
    harness.embeddings.route = {
      status: 'ok',
      route: { provider: PROVIDER, model: 'text-embedding-3-large' },
    };

    await expect(semantic.findSimilarTaskEmbeddings('source')).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(harness.embeddings.calls).toHaveLength(0);
  });
});
