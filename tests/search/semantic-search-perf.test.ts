import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Semantic search performance tests.
 *
 * - Unit tests run with mocked fetch (no Ollama needed).
 * - The "live" describe block is skipped by default; enable with
 *   OLLAMA_LIVE=1 to test against a real Ollama instance.
 */

// Mock the db/schema imports before importing semantic module
vi.mock('@/db', () => {
  const prepareFn = vi.fn((sql: string) => ({
    run: vi.fn(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(
      sql.includes('FROM search_embedding_index_state')
        ? {
            provider: 'ollama',
            model: 'nomic-embed-text',
            dimensions: 768,
            configuredProvider: 'ollama',
            configuredModel: 'nomic-embed-text',
          }
        : { count: 0 },
    ),
  }));
  const fakeDb = {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([]) }),
  };
  return {
    default: fakeDb,
    sqlite: { exec: vi.fn(), prepare: prepareFn },
  };
});

vi.mock('@/db/schema', () => ({
  tasks: 'tasks',
  notifications: 'notifications',
}));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: vi.fn().mockReturnValue({
    provider: 'ollama',
    configured: true,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: undefined,
    embeddingModel: 'nomic-embed-text',
    semanticSearchEnabled: true,
  }),
}));

vi.mock('@/lib/ai/provider-factory', () => ({
  AIRoutingDeniedError: class AIRoutingDeniedError extends Error {},
  getAIRequestContext: vi.fn(() => ({
    featureId: 'semantic-embedding',
    sensitivity: 'restricted',
    allowedRoutes: ['ollama'],
    correlationId: 'test-correlation',
  })),
  getAIRoutingHeaders: vi.fn(() => ({})),
  getAIRouteOutcome: vi.fn(() => ({
    provider: 'ollama',
    model: 'nomic-embed-text',
    fallbackOccurred: false,
  })),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn() },
}));

// Fake embedding (768 dims like nomic-embed-text)
function fakeEmbedding(seed = 0): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) * 0.1);
}

describe('Semantic search — unit tests (mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('generateEmbedding calls Ollama with correct payload', async () => {
    const mockEmbedding = fakeEmbedding(42);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: mockEmbedding }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { generateEmbedding } = await import('@/lib/search/semantic');
    const result = await generateEmbedding('test query');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('/embeddings');
    const body = JSON.parse(opts?.body as string);
    expect(body.model).toBe('nomic-embed-text');
    expect(body.input).toBe('test query');
    expect(result).toHaveLength(768);
  });

  it('generateEmbedding returns [] on timeout/error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));

    const { generateEmbedding } = await import('@/lib/search/semantic');
    const result = await generateEmbedding('test');
    expect(result).toEqual([]);
  });

  it('keeps shared embedding infrastructure available when search enrichment is disabled', async () => {
    const ai = await import('@/lib/ai/config-resolver');
    vi.mocked(ai.getResolvedAIConfig).mockReturnValueOnce({
      provider: 'ollama',
      configured: true,
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      model: 'llama3.1:8b',
      embeddingProvider: 'ollama',
      embeddingModel: 'nomic-embed-text',
      embeddingBaseUrl: 'http://localhost:11434/v1',
      embeddingApiKey: undefined,
      embeddingConfigured: true,
      semanticSearchEnabled: false,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: fakeEmbedding(7) }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { generateEmbedding } = await import('@/lib/search/semantic');
    await expect(generateEmbedding('graph neighbor')).resolves.toHaveLength(768);
  });

  it('propagates entity connector sources into embedding routing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: fakeEmbedding() }] }), { status: 200 }),
    );
    const ai = await import('@/lib/ai/provider-factory');
    const { generateEmbedding } = await import('@/lib/search/semantic');

    await generateEmbedding('private message', { sources: ['rymessage'] });

    expect(ai.getAIRequestContext).toHaveBeenCalledWith(
      'semantic-embedding',
      { sources: ['rymessage'] },
    );
  });

  it('cosine similarity computation is fast for 1000 items', () => {
    const queryVec = fakeEmbedding(1);
    const cache = Array.from({ length: 1000 }, (_, i) => fakeEmbedding(i));

    const start = performance.now();
    const scores: number[] = [];
    for (const stored of cache) {
      let dot = 0, normA = 0, normB = 0;
      for (let j = 0; j < queryVec.length; j++) {
        dot += queryVec[j] * stored[j];
        normA += queryVec[j] * queryVec[j];
        normB += stored[j] * stored[j];
      }
      scores.push(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
    }
    const elapsed = performance.now() - start;

    // In-memory cosine scan should be <50ms even for 1000 items
    expect(elapsed).toBeLessThan(200);
    expect(scores).toHaveLength(1000);
  });

  it('rebuild with 0 entities completes instantly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: fakeEmbedding() }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { rebuildEmbeddingIndex } = await import('@/lib/search/semantic');
    const start = performance.now();
    await rebuildEmbeddingIndex();
    const elapsed = performance.now() - start;

    // With no entities, rebuild should be near-instant
    expect(elapsed).toBeLessThan(500);
  });

  it('coalesces normalized interactive queries without rebuilding the index', async () => {
    const mockEmbedding = fakeEmbedding(9);
    let resolveFetch!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const dbModule = await import('@/db');
    const { semanticSearch } = await import('@/lib/search/semantic');
    vi.mocked(dbModule.sqlite.exec).mockClear();

    const first = semanticSearch('  Urgent   BUG ');
    const second = semanticSearch('urgent bug');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    resolveFetch(new Response(
      JSON.stringify({ data: [{ embedding: mockEmbedding }] }),
      { status: 200 },
    ));

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(dbModule.sqlite.exec).not.toHaveBeenCalledWith(
      expect.stringContaining('search_embeddings_rebuild'),
    );
  });

  it('pushes optional filters into semantic candidate selection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: fakeEmbedding(12) }] }), {
        status: 200,
      }),
    );
    const dbModule = await import('@/db');
    const { semanticSearch } = await import('@/lib/search/semantic');
    vi.mocked(dbModule.sqlite.prepare).mockClear();

    await semanticSearch('filtered query', {
      source: 'Project Alpha',
      status: 'in_progress',
      excludeDone: true,
    });

    const candidateSql = vi.mocked(dbModule.sqlite.prepare).mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('LEFT JOIN tasks t'));
    expect(candidateSql).toContain('t.source_list_name = ? OR t.connector_type = ?');
    expect(candidateSql).toContain('n.connector_type = ?');
    expect(candidateSql).toContain('COALESCE(t.status, n.category) = ?');
    expect(candidateSql).toContain("<> 'done'");
  });
});

describe.skipIf(!process.env.OLLAMA_LIVE)(
  'Semantic search — live Ollama tests',
  () => {
    const OLLAMA_BASE = process.env.AI_BASE_URL || 'http://localhost:11434/v1';
    const MODEL = process.env.AI_EMBEDDING_MODEL || 'nomic-embed-text';

    async function liveEmbedding(text: string): Promise<{ embedding: number[]; durationMs: number }> {
      const start = performance.now();
      const resp = await fetch(`${OLLAMA_BASE}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: text }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
      return {
        embedding: data.data[0].embedding,
        durationMs: Math.round(performance.now() - start),
      };
    }

    it('single embedding generation time', async () => {
      // Warm up
      await liveEmbedding('warm up');

      const { durationMs, embedding } = await liveEmbedding(
        'Fix the login timeout bug in the auth service',
      );

      console.log(`  Single embedding: ${durationMs}ms (${embedding.length} dims)`);
      expect(embedding.length).toBeGreaterThan(0);
    }, 60_000);

    it('batch of 10 sequential embeddings', async () => {
      await liveEmbedding('warm up');

      const queries = [
        'overdue tasks', 'payment errors', 'deploy to prod',
        'meeting notes', 'urgent bug', 'database migration',
        'API rate limit', 'user onboarding', 'security audit',
        'performance regression',
      ];

      const start = performance.now();
      for (const q of queries) {
        await liveEmbedding(q);
      }
      const totalMs = Math.round(performance.now() - start);
      const avgMs = Math.round(totalMs / queries.length);

      console.log(`  10 sequential: ${totalMs}ms total, ${avgMs}ms avg`);
      expect(totalMs).toBeGreaterThan(0);
    }, 120_000);

    it('batch of 10 concurrent embeddings', async () => {
      await liveEmbedding('warm up');

      const queries = [
        'overdue tasks', 'payment errors', 'deploy to prod',
        'meeting notes', 'urgent bug', 'database migration',
        'API rate limit', 'user onboarding', 'security audit',
        'performance regression',
      ];

      const start = performance.now();
      await Promise.all(queries.map((q) => liveEmbedding(q)));
      const totalMs = Math.round(performance.now() - start);

      console.log(`  10 concurrent: ${totalMs}ms total`);
      expect(totalMs).toBeGreaterThan(0);
    }, 120_000);

    it('query latency is the UX bottleneck, not similarity scan', async () => {
      await liveEmbedding('warm up');
      const { durationMs: embedMs, embedding } = await liveEmbedding('overdue payment');

      // Time a 1000-item cosine scan
      const fakeCache = Array.from({ length: 1000 }, () =>
        embedding.map(() => Math.random()),
      );
      const scanStart = performance.now();
      for (const cached of fakeCache) {
        let dot = 0, normA = 0, normB = 0;
        for (let j = 0; j < embedding.length; j++) {
          dot += embedding[j] * cached[j];
          normA += embedding[j] * embedding[j];
          normB += cached[j] * cached[j];
        }
      }
      const scanMs = Math.round(performance.now() - scanStart);

      console.log(`  Embedding: ${embedMs}ms vs Similarity scan: ${scanMs}ms`);
      console.log(`  → Embedding is ${Math.round(embedMs / Math.max(scanMs, 1))}x slower than scan`);

      // The scan should be WAY faster than the embedding call
      expect(scanMs).toBeLessThan(embedMs);
    }, 60_000);
  },
);
