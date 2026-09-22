import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIEmbeddingProvider } from '@/lib/semantic-index/embedding-provider';

function provider() {
  return new AIEmbeddingProvider({
    getEmbeddingConfig: async () => ({
      provider: 'ollama',
      model: 'synthetic-embedding',
      endpoint: 'http://127.0.0.1:11434/v1/embeddings',
      headers: { 'Content-Type': 'application/json' },
      context: {
        featureId: 'semantic-embedding',
        sensitivity: 'standard',
        allowedRoutes: ['ollama'],
        correlationId: 'packaged-provider-test',
      },
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('packaged AI embedding provider composition', () => {
  it('uses the production request transport with an explicit loopback route', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: [1, 0, 0] }],
    }), { status: 200 }));

    await expect(provider().embed({
      text: 'Index this task',
      sensitivity: 'standard',
      expect: { provider: 'ollama', model: 'synthetic-embedding', dimensions: 3 },
    })).resolves.toMatchObject({
      status: 'ok',
      provider: 'ollama',
      model: 'synthetic-embedding',
      dimensions: 3,
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'synthetic-embedding', input: 'Index this task' }),
      }),
    );
  });

  it('preserves production retry and malformed-response classification', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'retry-after': '2' },
      }))
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }));

    await expect(provider().embed({
      text: 'retry',
      sensitivity: 'standard',
    })).resolves.toMatchObject({ status: 'retryable', reason: 'http-429' });
    await expect(provider().embed({
      text: 'malformed',
      sensitivity: 'standard',
    })).resolves.toMatchObject({ status: 'failed', reason: 'malformed-response' });
  });

  it('does not issue a production request after cancellation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    controller.abort();

    await expect(provider().embed({
      text: 'cancelled',
      sensitivity: 'standard',
      signal: controller.signal,
    })).resolves.toMatchObject({ status: 'aborted' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
