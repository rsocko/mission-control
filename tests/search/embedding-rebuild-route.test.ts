import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSearchIndexHarness,
  type SearchIndexHarness,
} from './harness';
import { createSemanticTestDatabase } from '../semantic-index/harness';

/**
 * Resolved-route identity behaviour for the embedding route (issue #1661),
 * expressed against the durable semantic index (issue #1664).
 *
 * The old temp-table corpus rebuild these tests used to drive is gone, but the
 * properties it protected are not, so each one is asserted against its durable
 * equivalent:
 *
 * - a Bifrost proxy route must never be recorded as the vector space; the
 *   provider/model the response actually came from is;
 * - a route that moves mid-provisioning must not produce an identity that mixes
 *   two vector spaces, and must leave the existing index untouched;
 * - the query embedding cache must miss after a resolved-route cutover; and
 * - operational status must distinguish the configured route from the resolved
 *   one without leaking credentials.
 *
 * The embedding request path is exercised for real (only `fetch` and the
 * request-context/header helpers are mocked) so the configured *embedding*
 * credentials — not the completion ones — are proven to be the ones used.
 */

const CONTEXT = {
  featureId: 'semantic-embedding' as const,
  sensitivity: 'restricted' as const,
  allowedRoutes: ['ollama'] as const,
  correlationId: 'embedding-correlation',
};

const mocks = vi.hoisted(() => ({
  runtime: null as unknown,
  semanticSearchEnabled: true,
}));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => ({
    // The completion route is deliberately different in every field, so any
    // accidental use of it is visible rather than silently equivalent.
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://completion.example.test/v1',
    apiKey: 'completion-secret',
    configured: true,
    embeddingProvider: 'bifrost',
    embeddingModel: 'ollama/nomic-embed-text:latest',
    embeddingBaseUrl: 'https://bifrost.example.test/v1',
    embeddingApiKey: 'embedding-secret',
    embeddingConfigured: true,
    semanticSearchEnabled: mocks.semanticSearchEnabled,
  }),
}));

vi.mock('@/lib/ai/provider-factory', async () => {
  // The real route resolution is used: it is what turns a Bifrost proxy route
  // plus response metadata into the provider/model that names a vector space.
  const policy = await import('@/lib/ai/sensitivity-policy');
  return {
    AIRoutingDeniedError: policy.AIRoutingDeniedError,
    getAIRequestContext: vi.fn(() => CONTEXT),
    getAIRoutingHeaders: vi.fn(() => ({
      'x-mc-ai-feature-id': CONTEXT.featureId,
      'x-mc-ai-sensitivity': CONTEXT.sensitivity,
      'x-mc-ai-allowed-routes': CONTEXT.allowedRoutes.join(','),
      'x-mc-correlation-id': CONTEXT.correlationId,
    })),
    getAIRouteOutcome: vi.fn((
      context: Parameters<typeof policy.resolveAIRouteOutcome>[0],
      response: { modelId: string; headers?: Record<string, string> },
      metadata?: Parameters<typeof policy.resolveAIRouteOutcome>[4],
      configured?: { provider: string; model: string },
    ) => policy.resolveAIRouteOutcome(
      context,
      configured?.provider ?? 'bifrost',
      configured?.model ?? response.modelId,
      response.headers,
      metadata,
    )),
  };
});

vi.mock('@/lib/semantic-index/runtime', () => ({
  getSemanticIndexRuntime: async () => mocks.runtime,
  scheduleSemanticBackfill: vi.fn(),
  publishSemanticUpsert: vi.fn(),
  publishSemanticDelete: vi.fn(),
}));

const RESOLVED_PROVIDER = 'ollama';
const RESOLVED_MODEL = 'nomic-embed-text:latest';

function embeddingResponse(
  embedding: number[],
  routing?: { provider: string; model: string; fallbackIndex?: number },
) {
  return new Response(JSON.stringify({
    data: [{ embedding }],
    ...(routing
      ? {
          extra_fields: {
            routing_info: {
              provider: routing.provider,
              model: routing.model,
              fallback_index: routing.fallbackIndex ?? 0,
            },
          },
        }
      : {}),
  }), { status: 200 });
}

async function createIndexService() {
  const [
    { SqliteSemanticIndexRepository },
    { SemanticIndexService },
    { AIEmbeddingProvider },
    { FakeSemanticSourcePort },
  ] = await Promise.all([
    import('@/lib/semantic-index/sqlite-repository'),
    import('@/lib/semantic-index/service'),
    import('@/lib/semantic-index/embedding-provider'),
    import('../semantic-index/harness'),
  ]);
  const db = createSemanticTestDatabase();
  const repository = new SqliteSemanticIndexRepository(db, 100);
  let sequence = 0;
  const service = new SemanticIndexService({
    repository,
    source: new FakeSemanticSourcePort(),
    embeddings: new AIEmbeddingProvider(),
    resolveSensitivity: () => 'standard',
    newId: () => `idx-${++sequence}`,
  });
  return { db, repository, service, close: () => db.close() };
}

describe('resolved-route identity provisioning', () => {
  let index: Awaited<ReturnType<typeof createIndexService>>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.semanticSearchEnabled = true;
    index = await createIndexService();
  });

  afterEach(() => {
    index.close();
  });

  it('sends the request to the embedding route, never the completion route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      embeddingResponse([1, 2, 3], { provider: RESOLVED_PROVIDER, model: RESOLVED_MODEL }),
    );

    await index.service.ensureIdentity({ create: true });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://bifrost.example.test/v1/embeddings');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toContain('embedding-secret');
    expect(JSON.stringify(headers)).not.toContain('completion-secret');
    expect(JSON.parse(init?.body as string).model).toBe('ollama/nomic-embed-text:latest');
  });

  it('names the identity after the route that answered, not the configured proxy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      embeddingResponse([1, 2, 3], { provider: RESOLVED_PROVIDER, model: RESOLVED_MODEL }),
    );

    const resolved = await index.service.ensureIdentity({ create: true });

    expect(resolved).toMatchObject({ status: 'ready', created: true });
    if (resolved.status !== 'ready') throw new Error('expected an identity');
    expect(resolved.identity).toMatchObject({
      provider: RESOLVED_PROVIDER,
      model: RESOLVED_MODEL,
      dimensions: 3,
    });
    // The proxy route is never what a vector belongs to.
    expect(resolved.identity.provider).not.toBe('bifrost');
    expect(resolved.identity.model).not.toBe('ollama/nomic-embed-text:latest');
  });

  it('refuses to create an identity when the route falls back mid-provisioning', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      embeddingResponse([1, 2, 3], {
        provider: RESOLVED_PROVIDER,
        model: 'different-embed-model',
        fallbackIndex: 1,
      }),
    );

    const resolved = await index.service.ensureIdentity({ create: true });

    expect(resolved).toMatchObject({
      status: 'unavailable',
      reason: 'dimension-probe-route-mismatch',
    });
    // Nothing is written: a half-named space is worse than no space at all.
    expect(await index.repository.listIdentities()).toEqual([]);
  });

  it('leaves an existing identity untouched when a later probe falls back', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      embeddingResponse([1, 2, 3], { provider: RESOLVED_PROVIDER, model: RESOLVED_MODEL }),
    );
    const first = await index.service.ensureIdentity({ create: true });
    if (first.status !== 'ready') throw new Error('expected an identity');
    await index.repository.retireIdentity(first.identity.id, new Date().toISOString());

    fetchSpy.mockResolvedValue(
      embeddingResponse([1, 2, 3, 4], {
        provider: RESOLVED_PROVIDER,
        model: 'different-embed-model',
        fallbackIndex: 1,
      }),
    );
    const second = await index.service.ensureIdentity({ create: true });

    expect(second).toMatchObject({ status: 'unavailable' });
    const identities = await index.repository.listIdentities();
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      id: first.identity.id,
      provider: RESOLVED_PROVIDER,
      model: RESOLVED_MODEL,
      dimensions: 3,
    });
  });
});

describe('embedding operational status and query cache across a cutover', () => {
  let harness: SearchIndexHarness;
  let semantic: typeof import('@/lib/search/semantic');

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
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

  async function activateResolvedIdentity(model = RESOLVED_MODEL, id = 'idx-resolved') {
    const indexId = await harness.createIdentity({
      id,
      provider: RESOLVED_PROVIDER,
      model,
    });
    await harness.seedEntity({
      indexId,
      entityType: 'task',
      entityId: 'indexed',
      title: 'Indexed task',
      embedding: [1, 0, 0],
      provider: RESOLVED_PROVIDER,
      model,
      metadata: { status: 'todo', connectorType: 'local' },
    });
    await harness.activate(indexId);
    harness.embeddings.route = {
      status: 'ok',
      route: { provider: RESOLVED_PROVIDER, model },
    };
    return indexId;
  }

  it('reports the configured proxy route alongside the resolved identity', async () => {
    await activateResolvedIdentity();

    const status = await semantic.getEmbeddingOperationalStatus();

    expect(status).toMatchObject({
      available: true,
      state: 'ready',
      indexedCount: 1,
      configured: { provider: 'bifrost', model: 'ollama/nomic-embed-text:latest' },
      resolved: { provider: RESOLVED_PROVIDER, model: RESOLVED_MODEL, dimensions: 3 },
    });
    expect(JSON.stringify(status)).not.toContain('embedding-secret');
    expect(JSON.stringify(status)).not.toContain('completion-secret');
  });

  it('never reports a foreign vector space as this route resolved identity', async () => {
    await activateResolvedIdentity('legacy-embed-model', 'idx-legacy');

    await expect(semantic.getEmbeddingOperationalStatus()).resolves.toMatchObject({
      available: false,
      state: 'not-ready',
      indexedCount: 0,
      configured: { provider: 'bifrost', model: 'ollama/nomic-embed-text:latest' },
      resolved: null,
    });
  });

  it('does not reuse a cached query vector after a resolved-route cutover', async () => {
    await activateResolvedIdentity();
    harness.embeddings.enqueueVector([1, 0, 0], {
      provider: RESOLVED_PROVIDER,
      model: RESOLVED_MODEL,
    });

    await semantic.semanticSearch('  Urgent   BUG ');
    await semantic.semanticSearch('urgent bug');
    expect(harness.embeddings.calls).toHaveLength(1);

    // The route falls back to a different model, so a replacement identity is
    // cut over. The cached vector belongs to the previous space and must not be
    // reused for it.
    await activateResolvedIdentity('fallback-embed-model', 'idx-fallback');
    harness.embeddings.enqueueVector([1, 0, 0], {
      provider: RESOLVED_PROVIDER,
      model: 'fallback-embed-model',
    });

    const results = await semantic.semanticSearch('urgent bug');

    expect(harness.embeddings.calls).toHaveLength(2);
    expect(harness.embeddings.calls[1].expect).toMatchObject({
      provider: RESOLVED_PROVIDER,
      model: 'fallback-embed-model',
    });
    expect(results.map((result) => result.id)).toEqual(['indexed']);
  });
});
