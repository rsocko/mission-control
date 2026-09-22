import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSearchIndexHarness,
  MODEL,
  PROVIDER,
  T0,
  T1,
  type SearchIndexHarness,
} from './harness';
import { resetProcessRuntimeRegistries } from '../helpers/process-runtime-registries';

const mocks = vi.hoisted(() => ({
  semanticSearchEnabled: true,
  runtimeError: null as Error | null,
}));

vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration: async () => ({
    resolved: {
      provider: 'openai',
      configured: true,
      baseUrl: 'https://api.openai.test/v1',
      apiKey: 'super-secret-key',
      model: 'gpt-4o-mini',
      embeddingModel: 'text-embedding-3-small',
      semanticSearchEnabled: mocks.semanticSearchEnabled,
    },
    routingPolicy: {
      policies: {
        standard: { allowedRoutes: ['openai'] },
        restricted: { allowedRoutes: ['openai'] },
        'local-only': { allowedRoutes: ['ollama'] },
      },
      featureDefaults: {},
      sourceDefaults: {},
    },
  }),
}));

describe('semantic search status and readiness observability', () => {
  let harness: SearchIndexHarness;
  let semantic: typeof import('@/lib/search/semantic');

  beforeEach(async () => {
    resetProcessRuntimeRegistries();
    vi.resetModules();
    mocks.semanticSearchEnabled = true;
    mocks.runtimeError = null;
    harness = createSearchIndexHarness();
    semantic = await import('@/lib/search/semantic');
    semantic.registerSemanticSearchRuntime({
      resolve: async () => {
        if (mocks.runtimeError) throw mocks.runtimeError;
        return {
          repository: harness.repository,
          embeddings: harness.embeddings,
        };
      },
      scheduleBackfill: vi.fn(),
    });
    semantic.resetSemanticSearchStateForTests();
  });

  afterEach(() => {
    resetProcessRuntimeRegistries();
    harness.close();
  });

  async function seedReadyIndex(options: { stale?: boolean } = {}) {
    const indexId = await harness.createIdentity();
    await harness.seedEntity({
      entityType: 'task',
      entityId: 'indexed',
      title: 'Confidential launch checklist',
      body: 'Secret internal body text that must never appear in status output.',
      metadata: { status: 'todo', connectorType: 'local' },
      embedding: [1, 0, 0],
      stale: options.stale,
    });
    await harness.activate(indexId);
    return indexId;
  }

  it('reports disabled without touching storage or the provider', async () => {
    mocks.semanticSearchEnabled = false;
    const status = await semantic.getSemanticSearchStatus();

    expect(status).toMatchObject({ available: false, state: 'disabled', index: null });
    expect(harness.embeddings.routeCalls).toHaveLength(0);
  });

  it('reports unconfigured when no embedding route resolves', async () => {
    await seedReadyIndex();
    harness.embeddings.route = { status: 'unconfigured', reason: 'provider-unconfigured' };

    await expect(semantic.getSemanticSearchStatus()).resolves.toMatchObject({
      available: false,
      state: 'unconfigured',
    });
  });

  it('reports unconfigured when the index storage is unreachable', async () => {
    mocks.runtimeError = new Error('database unavailable');

    await expect(semantic.getSemanticSearchStatus()).resolves.toMatchObject({
      available: false,
      state: 'unconfigured',
      index: null,
    });
  });

  it('distinguishes building from not-ready', async () => {
    const staging = await harness.createIdentity();
    const building = await semantic.getSemanticSearchStatus();
    expect(building).toMatchObject({ available: false, state: 'building' });
    expect(building.index?.staging).toEqual([
      expect.objectContaining({ id: staging, status: 'building', provider: PROVIDER }),
    ]);

    await harness.repository.retireIdentity(staging, T1);
    await expect(semantic.getSemanticSearchStatus()).resolves.toMatchObject({
      available: false,
      state: 'not-ready',
    });
  });

  it('reports not-ready when the active identity holds no vectors', async () => {
    const indexId = await harness.createIdentity();
    await harness.repository.upsertDocument({
      id: 'doc-empty',
      indexId,
      entityType: 'task',
      entityId: 'empty',
      title: 'No vector yet',
      body: '',
      keywords: [],
      metadata: {},
      sourceRevision: 'rev-empty',
      contentFingerprint: 'fp-empty',
      projectionVersion: 1,
      sensitivity: 'standard',
      retainUntil: null,
      sourceUpdatedAt: T1,
      now: T1,
    });
    await harness.activate(indexId);

    const status = await semantic.getSemanticSearchStatus();
    expect(status).toMatchObject({ available: false, state: 'not-ready', indexedCount: 0 });
    expect(status.index?.byEntityType.find((kind) => kind.entityType === 'task'))
      .toMatchObject({ documents: 1, vectors: 0, stale: 1 });
  });

  it('reports incompatible when the configured route no longer names the active space', async () => {
    await seedReadyIndex();
    harness.embeddings.route = {
      status: 'ok',
      route: { provider: PROVIDER, model: 'text-embedding-3-large' },
    };

    const status = await semantic.getSemanticSearchStatus();
    expect(status).toMatchObject({ available: false, state: 'incompatible' });
    expect(status.index?.routeMatchesActiveIdentity).toBe(false);
    expect(status.index?.configuredRoute).toEqual({
      provider: PROVIDER,
      model: 'text-embedding-3-large',
    });
  });

  it('serves in a degraded state while part of the corpus is stale', async () => {
    await seedReadyIndex({ stale: true });

    const status = await semantic.getSemanticSearchStatus();
    expect(status).toMatchObject({ available: true, state: 'degraded' });
    expect(status.index?.totals).toMatchObject({ stale: 1, incompatible: 0 });
  });

  it('reports incompatible vectors per entity kind without scoring them', async () => {
    const indexId = await seedReadyIndex();
    // Only a legacy/adopted row can be in a foreign space under a live
    // identity, so it is written beneath the repository's write validation.
    harness.db.prepare(`
      INSERT INTO semantic_vectors (
        id, index_id, document_id, document_version, entity_type, entity_id,
        source_revision, content_fingerprint, projection_version, provider,
        model, dimensions, sensitivity, embedding, norm, source_updated_at,
        embedded_at, index_run_id, intent_id, expires_at, created_at, updated_at
      ) VALUES (
        'vec-foreign', ?, ?, 1, 'task', 'foreign', 'rev-foreign', 'fp-foreign', 1,
        'openai', 'legacy-model', 3, 'standard', '[1,0,0]', '1', ?, ?, NULL, NULL,
        NULL, ?, ?
      )
    `).run(indexId, `doc-${indexId}-task-indexed`, T1, T1, T1, T1);

    const status = await semantic.getSemanticSearchStatus();
    expect(status.state).toBe('degraded');
    expect(status.index?.totals.incompatible).toBe(1);
  });

  it('exposes queue depth, retries, permanent failures, and run progress', async () => {
    const indexId = await seedReadyIndex();
    await harness.repository.enqueueIntent({
      id: 'intent-queued',
      idempotencyKey: 'key-queued',
      indexId,
      kind: 'upsert',
      entityType: 'task',
      entityId: 'queued-entity',
      requestedAt: T0,
      now: T0,
    });
    await harness.repository.enqueueIntent({
      id: 'intent-doomed',
      idempotencyKey: 'key-doomed',
      indexId,
      kind: 'upsert',
      entityType: 'task',
      entityId: 'doomed-entity',
      requestedAt: T0,
      now: T0,
    });
    const claimed = await harness.repository.claimIntents({
      indexId, owner: 'worker-1', limit: 5, leaseMs: 60_000, now: T0,
    });
    await harness.repository.failIntent({
      id: claimed[0].id,
      owner: 'worker-1',
      attempt: claimed[0].attempt,
      error: 'nope',
      now: T0,
      terminal: true,
    });
    await harness.repository.createRun({
      id: 'run-1',
      indexId,
      kind: 'backfill',
      idempotencyKey: 'run-key-1',
      now: T0,
    });
    await harness.repository.claimRun({ owner: 'worker-1', leaseMs: 7_200_000, now: T0 });
    await harness.repository.checkpointRun({
      id: 'run-1',
      owner: 'worker-1',
      attempt: 0,
      now: T1,
      checkpoint: 'task:cursor-42',
      processedDelta: 7,
    });

    const status = await semantic.getSemanticSearchStatus();
    expect(status.index?.intents).toMatchObject({ permanentFailures: 1 });
    expect(status.index?.intents.oldestRunningAgeMs).toBeGreaterThanOrEqual(0);
    expect(status.index?.runs).toMatchObject({ running: 1 });
    expect(status.index?.latestRuns).toEqual([
      expect.objectContaining({
        kind: 'backfill',
        status: 'running',
        checkpoint: 'task:cursor-42',
        processedCount: 7,
      }),
    ]);
    expect(status.index?.scan).toEqual({
      kind: 'bounded-in-process',
      candidateCeiling: 100,
      guaranteesFullRecall: false,
      guaranteedScale: 100,
    });
  });

  it('never leaks document content, query text, vectors, or credentials', async () => {
    await seedReadyIndex();
    harness.embeddings.enqueueVector([1, 0, 0]);
    await semantic.semanticSearch('extremely sensitive query text');

    const serialized = JSON.stringify({
      status: await semantic.getSemanticSearchStatus(),
      metrics: semantic.getSemanticSearchMetrics(),
    });

    expect(serialized).not.toContain('Confidential launch checklist');
    expect(serialized).not.toContain('Secret internal body text');
    expect(serialized).not.toContain('extremely sensitive query text');
    expect(serialized).not.toContain('super-secret-key');
    expect(serialized).not.toContain('"embedding"');
    expect(serialized).not.toMatch(/\[\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,/);
    expect(serialized).toContain(MODEL);
  });

  it('mirrors the last observed index snapshot into retrieval metrics', async () => {
    await seedReadyIndex();
    expect(semantic.getSemanticSearchMetrics().index).toBeNull();

    await semantic.getSemanticSearchStatus();
    const metrics = semantic.getSemanticSearchMetrics();
    expect(metrics.index?.active).toMatchObject({
      provider: PROVIDER,
      model: MODEL,
      dimensions: 3,
      vectorCount: 1,
    });
    expect(metrics.queryCache).toMatchObject({ hits: 0, misses: 0 });
  });
});
