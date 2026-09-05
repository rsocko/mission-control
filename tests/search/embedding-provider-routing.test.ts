import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allowedRoutes: ['bifrost-copilot', 'azure-private'],
}));

vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration: async () => ({
    resolved: {
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
    },
    routingPolicy: {
      policies: {
        standard: { allowedRoutes: mocks.allowedRoutes },
        restricted: { allowedRoutes: mocks.allowedRoutes },
        'local-only': { allowedRoutes: ['ollama'] },
      },
      featureDefaults: {},
      sourceDefaults: {},
    },
  }),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  requestContext: { getStore: vi.fn(() => undefined) },
}));

describe('embedding provider requests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.allowedRoutes = ['bifrost-copilot', 'azure-private'];
    vi.stubEnv('AI_APPROVED_BIFROST_HOSTS', 'bifrost.example.test');
    vi.stubEnv('MC_DB_PATH', ':memory:');
    vi.stubEnv('MC_EMBEDDING_REQUEST_MAX_RETRIES', '2');
    vi.stubEnv('MC_EMBEDDING_REQUEST_RETRY_BASE_MS', '1');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      'x-mc-ai-feature-id': 'semantic-embedding',
      'x-mc-ai-sensitivity': 'restricted',
      'x-mc-ai-allowed-routes': 'bifrost-copilot,azure-private',
      'x-mc-correlation-id': expect.any(String),
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
    mocks.allowedRoutes = ['ollama'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { testEmbeddingConnection } = await import('@/lib/search/semantic');

    await expect(testEmbeddingConnection()).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a policy-denied embedding route without throwing from status', async () => {
    mocks.allowedRoutes = ['ollama'];
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
