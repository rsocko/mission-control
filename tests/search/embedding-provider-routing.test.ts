import { beforeEach, describe, expect, it, vi } from 'vitest';

const routingHeaders = {
  'x-mc-ai-feature-id': 'semantic-embedding',
  'x-mc-ai-sensitivity': 'restricted',
  'x-mc-ai-allowed-routes': 'azure-private',
  'x-mc-correlation-id': 'embedding-correlation',
};

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => ({
    provider: 'ollama',
    model: 'llama3.1:8b',
    configured: true,
    baseUrl: 'http://localhost:11434/v1',
    embeddingProvider: 'bifrost',
    embeddingModel: 'azure/text-embedding-3-small',
    embeddingBaseUrl: 'https://bifrost.example.test/v1',
    embeddingApiKey: 'embedding-secret',
    embeddingConfigured: true,
    semanticSearchEnabled: true,
  }),
}));

vi.mock('@/lib/ai/provider-factory', () => ({
  AIRoutingDeniedError: class AIRoutingDeniedError extends Error {},
  getAIRequestContext: () => ({
    featureId: 'semantic-embedding',
    sensitivity: 'restricted',
    allowedRoutes: ['azure-private'],
    correlationId: 'embedding-correlation',
  }),
  getAIRoutingHeaders: vi.fn(() => routingHeaders),
  getAIRouteOutcome: (
    context: unknown,
    _response: unknown,
    metadata?: { provider?: string; model?: string; fallbackOccurred?: boolean },
  ) => ({
    provider: metadata?.provider || 'azure',
    model: metadata?.model || 'text-embedding-3-small',
    fallbackOccurred: metadata?.fallbackOccurred ?? false,
    context,
  }),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('embedding provider requests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv('MC_DB_PATH', ':memory:');
    vi.stubEnv('MC_EMBEDDING_REQUEST_MAX_RETRIES', '2');
    vi.stubEnv('MC_EMBEDDING_REQUEST_RETRY_BASE_MS', '1');
    vi.resetModules();
  });

  it('sends credentials and complete policy metadata and records Bifrost fallback identity', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{ embedding: [1, 2, 3] }],
        extra_fields: {
          routing_info: {
            provider: 'azure',
            model: 'fallback-embedding',
            fallback_index: 1,
          },
        },
      }), { status: 200 }),
    );
    const { testEmbeddingConnection } = await import('@/lib/search/semantic');

    await expect(testEmbeddingConnection()).resolves.toMatchObject({
      success: true,
      resolved: {
        provider: 'azure',
        model: 'fallback-embedding',
        dimensions: 3,
        fallbackOccurred: true,
      },
    });
    const request = fetchSpy.mock.calls[0][1];
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer embedding-secret',
      ...routingHeaders,
    });
  });

  it('retries transient failures and succeeds without changing the configured route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }),
      );
    const { testEmbeddingConnection } = await import('@/lib/search/semantic');

    await expect(testEmbeddingConnection()).resolves.toMatchObject({
      success: true,
      configured: {
        provider: 'bifrost',
        model: 'azure/text-embedding-3-small',
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated timeout failures and returns a redacted error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    );
    const { testEmbeddingConnection } = await import('@/lib/search/semantic');

    const result = await testEmbeddingConnection();

    expect(result).toMatchObject({
      success: false,
      error: 'Embedding provider did not return a valid vector',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain('embedding-secret');
    expect(fetchSpy.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('stops before egress when sensitivity policy denies the embedding route', async () => {
    const ai = await import('@/lib/ai/provider-factory');
    vi.mocked(ai.getAIRoutingHeaders).mockImplementationOnce(() => {
      throw new ai.AIRoutingDeniedError('bifrost', {
        featureId: 'semantic-embedding',
        sensitivity: 'restricted',
        allowedRoutes: ['azure-private'],
        correlationId: 'embedding-correlation',
      });
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { testEmbeddingConnection } = await import('@/lib/search/semantic');

    await expect(testEmbeddingConnection()).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a policy-denied embedding route without throwing from status', async () => {
    const ai = await import('@/lib/ai/provider-factory');
    vi.mocked(ai.getAIRoutingHeaders).mockImplementationOnce(() => {
      throw new ai.AIRoutingDeniedError('bifrost', {
        featureId: 'semantic-embedding',
        sensitivity: 'restricted',
        allowedRoutes: ['azure-private'],
        correlationId: 'embedding-correlation',
      });
    });
    const { getEmbeddingOperationalStatus } = await import('@/lib/search/semantic');

    await expect(getEmbeddingOperationalStatus()).resolves.toMatchObject({
      available: false,
      state: 'denied',
      configured: {
        provider: 'bifrost',
        model: 'azure/text-embedding-3-small',
      },
    });
  });
});
