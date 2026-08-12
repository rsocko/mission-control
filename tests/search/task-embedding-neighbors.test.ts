import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai', () => ({
  getResolvedAIConfig: () => ({
    provider: 'ollama',
    configured: true,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: undefined,
  }),
  getAIRequestContext: () => ({
    featureId: 'semantic-embedding',
    sensitivity: 'restricted',
    allowedRoutes: ['ollama'],
    correlationId: 'test-correlation',
  }),
  getAIRoutingHeaders: () => ({}),
  getAIRouteOutcome: vi.fn(() => ({
    provider: 'ollama',
    model: 'nomic-embed-text',
    fallbackOccurred: false,
  })),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('findSimilarTaskEmbeddings', () => {
  let findSimilarTaskEmbeddings:
    typeof import('@/lib/search/semantic').findSimilarTaskEmbeddings;
  let rebuildEmbeddingIndex:
    typeof import('@/lib/search/semantic').rebuildEmbeddingIndex;
  let indexEntityEmbedding:
    typeof import('@/lib/search/semantic').indexEntityEmbedding;
  let sqlite: typeof import('@/db').sqlite;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.resetModules();
    const [database, schema, semantic] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/search/semantic'),
    ]);
    const db = database.default;
    sqlite = database.sqlite;
    findSimilarTaskEmbeddings = semantic.findSimilarTaskEmbeddings;
    rebuildEmbeddingIndex = semantic.rebuildEmbeddingIndex;
    indexEntityEmbedding = semantic.indexEntityEmbedding;
    const task = (id: string, updatedAt: string) => ({
      id,
      sourceId: `source-${id}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: id,
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced' as const,
      createdAt: '2029-01-01T00:00:00.000Z',
      updatedAt,
      lastSyncedAt: updatedAt,
    });
    await db.insert(schema.tasks).values([
      task('source', '2030-01-01T00:00:00.000Z'),
      task('fresh-target', '2029-01-01T00:00:00.000Z'),
      task('stale-target', '2031-01-01T00:00:00.000Z'),
      task('stale-source', '2031-01-01T00:00:00.000Z'),
      task('missing-source', '2030-01-01T00:00:00.000Z'),
      task('incompatible-source', '2030-01-01T00:00:00.000Z'),
      task('wrong-dimension', '2029-01-01T00:00:00.000Z'),
    ]);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS search_embeddings (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provider TEXT,
        model TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS search_embeddings_entity_idx
        ON search_embeddings(entity_type, entity_id);
    `);
    const insert = sqlite.prepare(`
      INSERT INTO search_embeddings (
        id, entity_type, entity_id, embedding, updated_at, provider, model
      )
      VALUES (?, 'task', ?, ?, ?, 'ollama', 'nomic-embed-text')
    `);
    insert.run('task:source', 'source', JSON.stringify([1, 0]), '2030-01-01T00:00:00.000Z');
    insert.run(
      'task:fresh-target',
      'fresh-target',
      JSON.stringify([0.9, 0.1]),
      '2030-01-01T00:00:00.000Z',
    );
    insert.run(
      'task:stale-target',
      'stale-target',
      JSON.stringify([1, 0]),
      '2030-01-01T00:00:00.000Z',
    );
    insert.run(
      'task:stale-source',
      'stale-source',
      JSON.stringify([1, 0]),
      '2030-01-01T00:00:00.000Z',
    );
    sqlite.prepare(`
      INSERT INTO search_embeddings (
        id, entity_type, entity_id, embedding, updated_at, provider, model
      )
      VALUES (?, 'task', ?, ?, ?, 'ollama', 'different-model')
    `).run(
      'task:incompatible-source',
      'incompatible-source',
      JSON.stringify([1, 0]),
      '2030-01-01T00:00:00.000Z',
    );
    insert.run(
      'task:wrong-dimension',
      'wrong-dimension',
      JSON.stringify([1, 0, 0]),
      '2030-01-01T00:00:00.000Z',
    );
    insert.run(
      'task:deleted-task',
      'deleted-task',
      JSON.stringify([1, 0]),
      '2030-01-01T00:00:00.000Z',
    );
  });

  it('returns fresh task embeddings only and includes model metadata', async () => {
    const result = await findSimilarTaskEmbeddings('source', {
      limit: 5,
      minScore: 0,
    });
    expect(result).toMatchObject({
      status: 'available',
      provider: 'ollama',
      model: 'nomic-embed-text',
      sourceUpdatedAt: '2030-01-01T00:00:00.000Z',
    });
    if (result.status !== 'available') throw new Error('Expected available embeddings');
    expect(result.neighbors.map((neighbor) => neighbor.taskId)).toEqual(['fresh-target']);
  });

  it('distinguishes stale and missing source embeddings', async () => {
    await expect(findSimilarTaskEmbeddings('stale-source')).resolves.toMatchObject({
      status: 'stale',
      neighbors: [],
    });
    await expect(findSimilarTaskEmbeddings('missing-source')).resolves.toMatchObject({
      status: 'missing',
      neighbors: [],
    });
    await expect(findSimilarTaskEmbeddings('incompatible-source')).resolves.toMatchObject({
      status: 'incompatible',
      neighbors: [],
    });
  });

  it('uses the source-recency index before applying the candidate limit', () => {
    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT e.id
      FROM search_embeddings e
      WHERE e.provider = ?
        AND e.model = ?
        AND e.source_sort_at IS NOT NULL
        AND e.entity_type = 'task'
      ORDER BY e.source_sort_at DESC, e.entity_type, e.entity_id
      LIMIT ?
    `).all(
      'ollama',
      'nomic-embed-text',
      2_000,
    ) as Array<{ detail: string }>;

    expect(plan.some(({ detail }) => detail.includes('search_embeddings_tasks_idx'))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes('USE TEMP B-TREE'))).toBe(false);
  });

  it('marks notification embeddings invalid when searchable text changes', () => {
    sqlite.prepare(`
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, body,
        level, level_rank, category, state, is_actionable, received_at, sort_at,
        metadata, presentation
      ) VALUES (
        'notification-update', 'source-notification-update', 'local', 'local',
        'Original title', 'Original body', 'fyi', 3, 'system', 'unread', 0,
        '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '{}', '{}'
      )
    `).run();
    sqlite.prepare(`
      INSERT INTO search_embeddings (
        id, entity_type, entity_id, embedding, updated_at, provider, model,
        source_sort_at
      ) VALUES (
        'alert:notification-update', 'alert', 'notification-update', '[1,0]',
        '2030-01-01T00:00:00.000Z', 'ollama', 'nomic-embed-text',
        '2030-01-01T00:00:00.000Z'
      )
    `).run();

    sqlite.prepare(`
      UPDATE notifications SET body = 'Updated body' WHERE id = 'notification-update'
    `).run();

    expect(
      (sqlite.prepare(`
        SELECT source_sort_at AS sourceSortAt
        FROM search_embeddings
        WHERE entity_type = 'alert' AND entity_id = 'notification-update'
      `).get() as { sourceSortAt: string | null }).sourceSortAt,
    ).toBeNull();
  });

  it('stores fallback vectors under the actual routed provider and model', async () => {
    const ai = await import('@/lib/ai');
    vi.mocked(ai.getAIRouteOutcome).mockReturnValueOnce({
      provider: 'fallback-provider',
      model: 'fallback-model',
      fallbackOccurred: true,
      context: ai.getAIRequestContext('semantic-embedding'),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(indexEntityEmbedding(
      'task',
      'source',
      'source',
      [],
      {
        title: 'source',
        body: null,
        sortAt: '2030-01-01T00:00:00.000Z',
      },
    )).resolves.toBe(true);
    expect(
      sqlite.prepare(`
        SELECT provider, model
        FROM search_embeddings
        WHERE entity_type = 'task'
          AND entity_id = 'source'
          AND provider = 'fallback-provider'
      `).get(),
    ).toMatchObject({
      provider: 'fallback-provider',
      model: 'fallback-model',
    });
    sqlite.prepare(`
      DELETE FROM search_embeddings WHERE provider = 'fallback-provider'
    `).run();
  });

  it('keeps the last-good rows when a rebuild batch fails', async () => {
    let request = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      request++;
      if (request === 1) {
        return new Response('provider unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(rebuildEmbeddingIndex()).rejects.toThrow(
      'Embedding index rebuild batch failed',
    );
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM search_embeddings').get() as {
        count: number;
      }).count,
    ).toBe(7);
  });

  it('serializes rebuilds and preserves the live index until replacement rows exist', async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await fetchGate;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    fetchSpy.mockClear();

    const rebuilds = [
      rebuildEmbeddingIndex(),
      rebuildEmbeddingIndex(),
      rebuildEmbeddingIndex(),
    ];
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(5));
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM search_embeddings').get() as {
        count: number;
      }).count,
    ).toBe(7);
    sqlite.prepare(`
      UPDATE tasks
      SET updated_at = '2032-01-01T00:00:00.000Z'
      WHERE id = 'fresh-target'
    `).run();

    releaseFetch();
    await Promise.all(rebuilds);

    expect(fetchSpy).toHaveBeenCalledTimes(8);
    expect(
      (sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM search_embeddings
        WHERE entity_type = 'task' AND entity_id = 'incompatible-source'
      `).get() as { count: number }).count,
    ).toBe(2);
    expect(
      (sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM search_embeddings
        WHERE entity_type = 'task'
          AND entity_id = 'fresh-target'
          AND provider = 'ollama'
          AND model = 'nomic-embed-text'
      `).get() as { count: number }).count,
    ).toBe(0);
  });
});
