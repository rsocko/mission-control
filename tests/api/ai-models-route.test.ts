import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  failure: null as Error | null,
  config: {
    provider: 'bifrost',
    model: 'azure/gpt-4o-mini',
    baseUrl: 'https://bifrost.test/v1',
    apiKey: 'gateway-key',
    configured: true,
  },
}));

vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration: async () => {
    if (state.failure) throw state.failure;
    return {
      saved: {},
      resolved: state.config,
      routingPolicy: {
        policies: {
          'local-only': { allowedRoutes: ['ollama'] },
          restricted: { allowedRoutes: ['ollama', 'azure-private'] },
          standard: { allowedRoutes: ['bifrost-copilot', 'ollama'] },
        },
        featureDefaults: {},
        sourceDefaults: {},
      },
    };
  },
}));

describe('AI model discovery', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('BIFROST_BASE_URL', 'https://bifrost.test/v1');
    state.failure = null;
    state.config = {
      provider: 'bifrost',
      model: 'azure/gpt-4o-mini',
      baseUrl: 'https://bifrost.test/v1',
      apiKey: 'gateway-key',
      configured: true,
    };
  });

  it('uses the environment gateway credential before Bifrost becomes active', async () => {
    state.config = {
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      configured: true,
    };
    vi.stubEnv('BIFROST_API_KEY', 'environment-gateway-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'azure/gpt-4o-mini' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/ai/models/route');
    await GET(new Request('http://localhost/api/ai/models?provider=bifrost'));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bifrost.test/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer environment-gateway-key' },
      }),
    );
  });

  it('loads provider-qualified models from the configured Bifrost gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'azure/gpt-4o-mini' },
        { id: 'ollama/llama3.1:8b' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/ai/models/route');
    const response = await GET(new Request(
      'http://localhost/api/ai/models?provider=bifrost&baseUrl=https%3A%2F%2Fbifrost.test%2Fv1',
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [
        { name: 'azure/gpt-4o-mini' },
        { name: 'ollama/llama3.1:8b' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bifrost.test/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer gateway-key' },
      }),
    );
  });

  it('rejects an unapproved Bifrost discovery endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/ai/models/route');
    const response = await GET(new Request(
      'http://localhost/api/ai/models?provider=bifrost&baseUrl=https%3A%2F%2Funtrusted.test%2Fv1',
    ));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a structured error when provider configuration cannot be loaded', async () => {
    state.failure = new Error('settings unavailable');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/ai/models/route');
    const response = await GET(new Request(
      'http://localhost/api/ai/models?provider=bifrost',
    ));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Failed to load Bifrost models: settings unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
