import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Semantic embedding performance and shared-infrastructure tests.
 *
 * The corpus rebuild these tests used to exercise no longer exists: the durable
 * index worker owns corpus work (issue #1664), so `rebuildEmbeddingIndex` only
 * schedules a run. What remains here is the part that is still shared, still
 * interactive, and still latency-sensitive:
 *
 * - `generateEmbedding` as infrastructure that outlives search enrichment;
 * - the bounded retry/timeout envelope around one embedding request; and
 * - the synthetic cosine scan, which is the cheap half of a semantic query.
 *
 * Unit tests run with mocked fetch (no Ollama needed). The "live" describe block
 * is skipped by default; enable it with OLLAMA_LIVE=1.
 */

const mocks = vi.hoisted(() => ({
  scheduleSemanticBackfill: vi.fn(),
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

vi.mock('@/lib/semantic-index/runtime', () => ({
  getSemanticIndexRuntime: vi.fn(async () => {
    throw new Error('the semantic index runtime must not be touched by these tests');
  }),
  scheduleSemanticBackfill: mocks.scheduleSemanticBackfill,
  publishSemanticUpsert: vi.fn(),
  publishSemanticDelete: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn() },
  semanticIndexLogger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

// Fake embedding (768 dims like nomic-embed-text)
function fakeEmbedding(seed = 0): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) * 0.1);
}

describe('Semantic search — unit tests (mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.scheduleSemanticBackfill.mockReset();
    vi.stubEnv('MC_EMBEDDING_REQUEST_MAX_RETRIES', '2');
    vi.stubEnv('MC_EMBEDDING_REQUEST_RETRY_BASE_MS', '1');
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

  it('bounds retries for a persistently failing provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }),
    );

    const { generateEmbedding } = await import('@/lib/search/semantic');
    await expect(generateEmbedding('bounded')).resolves.toEqual([]);

    // One attempt plus MC_EMBEDDING_REQUEST_MAX_RETRIES; an interactive caller
    // must never sit in an unbounded retry loop.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(
      fetchSpy.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal),
    ).toBe(true);
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
      houstonMemoryEnabled: false,
      houstonMemoryRetentionDays: 90,
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

  it('returns from a rebuild request without embedding a corpus', async () => {
    mocks.scheduleSemanticBackfill.mockResolvedValue({
      status: 'scheduled',
      indexId: 'idx-1',
      runId: 'run-1',
      runStatus: 'queued',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { rebuildEmbeddingIndex } = await import('@/lib/search/semantic');
    const start = performance.now();
    await expect(rebuildEmbeddingIndex()).resolves.toMatchObject({
      status: 'scheduled',
      runId: 'run-1',
    });
    const elapsed = performance.now() - start;

    // Scheduling is a single durable write: it must not depend on corpus size,
    // and it must not issue a provider request from the request path.
    expect(elapsed).toBeLessThan(500);
    expect(fetchSpy).not.toHaveBeenCalled();
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
      let scoreTotal = 0;
      for (const cached of fakeCache) {
        let dot = 0, normA = 0, normB = 0;
        for (let j = 0; j < embedding.length; j++) {
          dot += embedding[j] * cached[j];
          normA += embedding[j] * embedding[j];
          normB += cached[j] * cached[j];
        }
        scoreTotal += dot / (Math.sqrt(normA) * Math.sqrt(normB));
      }
      const scanMs = Math.round(performance.now() - scanStart);

      console.log(`  Embedding: ${embedMs}ms vs Similarity scan: ${scanMs}ms`);
      console.log(`  → Embedding is ${Math.round(embedMs / Math.max(scanMs, 1))}x slower than scan`);

      // The scan should be WAY faster than the embedding call
      expect(Number.isFinite(scoreTotal)).toBe(true);
      expect(scanMs).toBeLessThan(embedMs);
    }, 60_000);
  },
);
