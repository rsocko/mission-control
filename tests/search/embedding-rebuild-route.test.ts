import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedding = (seed: number) => [seed, seed + 1, seed + 2];

describe('embedding index rebuild routing', () => {
  let routeOutcomes: Array<{ provider: string; model: string; fallbackOccurred: boolean }>;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.MC_DB_PATH = ':memory:';
    process.env.AI_EMBEDDING_MODEL = 'ollama/nomic-embed-text:latest';
    routeOutcomes = [];

    vi.doMock('@/lib/ai', () => ({
      AIRoutingDeniedError: class AIRoutingDeniedError extends Error {},
      getResolvedAIConfig: vi.fn(() => ({
        provider: 'bifrost',
        configured: true,
        baseUrl: 'https://bifrost.example.test/v1',
        apiKey: undefined,
        model: 'azure/gpt-4o-mini',
        embeddingModel: 'ollama/nomic-embed-text:latest',
        semanticSearchEnabled: true,
      })),
      getAIRequestContext: vi.fn(() => ({
        featureId: 'semantic-embedding',
        sensitivity: 'restricted',
        allowedRoutes: ['ollama'],
        correlationId: 'test-correlation',
      })),
      getAIRoutingHeaders: vi.fn(() => ({})),
      getAIRouteOutcome: vi.fn(() => routeOutcomes.shift() ?? ({
        provider: 'ollama',
        model: 'nomic-embed-text:latest',
        fallbackOccurred: false,
      })),
    }));
    vi.doMock('@/lib/logger', () => ({
      aiLogger: { info: vi.fn(), warn: vi.fn() },
      dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
  });

  async function seedTask(id: string) {
    const database = await import('@/db');
    const schema = await import('@/db/schema');
    await database.default.insert(schema.tasks).values({
      id,
      sourceId: `source-${id}`,
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
      title: `Task ${id}`,
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
      lastSyncedAt: '2030-01-01T00:00:00.000Z',
    });
    return database.sqlite;
  }

  it('stores rebuild rows under the stable resolved route instead of the configured proxy route', async () => {
    const sqlite = await seedTask('stable-route');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: embedding(1) }] }), { status: 200 }),
    );

    const { rebuildEmbeddingIndex } = await import('@/lib/search/semantic');
    await rebuildEmbeddingIndex();

    expect(sqlite.prepare(`
      SELECT provider, model
      FROM search_embeddings
      WHERE entity_id = 'stable-route'
    `).get()).toEqual({
      provider: 'ollama',
      model: 'nomic-embed-text:latest',
    });
  });

  it('retains last-good rows when the resolved route changes during a rebuild', async () => {
    const sqlite = await seedTask('route-a');
    await seedTask('route-b');
    sqlite.exec(`
      CREATE TABLE search_embeddings (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        source_sort_at TEXT
      )
    `);
    sqlite.prepare(`
      INSERT INTO search_embeddings (
        id, entity_type, entity_id, embedding, updated_at, provider, model,
        source_sort_at
      ) VALUES (
        'task:route-a:ollama:nomic-embed-text:latest', 'task', 'route-a', '[1,2,3]',
        '2030-01-01T00:00:00.000Z', 'ollama', 'nomic-embed-text:latest',
        '2030-01-01T00:00:00.000Z'
      )
    `).run();
    routeOutcomes = [
      { provider: 'ollama', model: 'nomic-embed-text:latest', fallbackOccurred: false },
      { provider: 'ollama', model: 'nomic-embed-text:latest', fallbackOccurred: false },
      { provider: 'ollama', model: 'different-embed-model', fallbackOccurred: true },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ data: [{ embedding: embedding(2) }] }), { status: 200 }),
    ));

    const { rebuildEmbeddingIndex } = await import('@/lib/search/semantic');

    await expect(rebuildEmbeddingIndex()).rejects.toThrow('Embedding index rebuild batch failed');
    expect(sqlite.prepare(`
      SELECT embedding, provider, model
      FROM search_embeddings
      WHERE entity_id = 'route-a'
    `).get()).toEqual({
      embedding: '[1,2,3]',
      provider: 'ollama',
      model: 'nomic-embed-text:latest',
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM search_embeddings
      WHERE entity_id = 'route-b'
    `).get()).toEqual({ count: 0 });
  });

  it('backs off repeated seed rebuilds after route instability', async () => {
    await seedTask('retry-a');
    await seedTask('retry-b');
    routeOutcomes = [
      { provider: 'ollama', model: 'nomic-embed-text:latest', fallbackOccurred: false },
      { provider: 'ollama', model: 'nomic-embed-text:latest', fallbackOccurred: false },
      { provider: 'ollama', model: 'different-embed-model', fallbackOccurred: true },
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ data: [{ embedding: embedding(3) }] }), { status: 200 }),
    ));

    const { warmUpEmbeddings } = await import('@/lib/search/semantic');

    await warmUpEmbeddings();
    const callsAfterRouteFailure = fetchSpy.mock.calls.length;
    await warmUpEmbeddings();

    expect(callsAfterRouteFailure).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(callsAfterRouteFailure);
  });
});
