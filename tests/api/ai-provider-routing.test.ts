import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  saved: {
    provider: 'bifrost',
    model: 'azure/gpt-4o-mini',
    baseUrl: 'https://bifrost.test/v1',
    apiKey: 'server-secret',
  } as Record<string, string | boolean | number>,
  writes: [] as Array<{ key: string; value: unknown }>,
  failWrites: false,
  routingPolicy: {
    policies: {
      'local-only': { allowedRoutes: ['ollama'] },
      restricted: { allowedRoutes: ['ollama', 'azure-private'] },
      standard: { allowedRoutes: ['bifrost-copilot', 'ollama'] },
    },
    featureDefaults: {},
    sourceDefaults: {},
  },
}));

const routingPolicy = state.routingPolicy;

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    settings: {
      get: async (key: string) => (
        key === 'ai_provider_config' ? state.saved : state.routingPolicy
      ),
      getMany: async (keys: readonly string[]) => Object.fromEntries(
        keys.map((key) => [
          key,
          key === 'ai_provider_config' ? state.saved : state.routingPolicy,
        ]),
      ),
      set: vi.fn(),
      setMany: async (entries: ReadonlyArray<readonly [string, unknown]>) => {
        if (state.failWrites) throw new Error('forced settings write failure');
        for (const [key, value] of entries) {
          state.writes.push({ key, value });
          if (key === 'ai_provider_config') {
            state.saved = value as typeof state.saved;
          } else if (key === 'ai_routing_policy') {
            state.routingPolicy = value as typeof state.routingPolicy;
          }
        }
      },
      delete: vi.fn(),
      getActiveEmbeddingIdentity: async () => null,
    },
  }),
}));

vi.mock('@/db', () => ({
  sqlite: {
    prepare: () => ({
      get: (key: string) => ({
        value: key === 'ai_provider_config' ? state.saved : state.routingPolicy,
      }),
    }),
  },
}));

vi.mock('@/lib/ai/sensitivity-policy', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/ai/sensitivity-policy')
  >('@/lib/ai/sensitivity-policy');
  return {
    ...actual,
    validateAIRoutingPolicy: (value: unknown) => value,
  };
});

vi.mock('@/lib/search/embedding-provider-status', () => ({
  getEmbeddingOperationalStatus: () => ({
    available: true,
    state: 'ready',
    indexedCount: 12,
    configured: { provider: 'bifrost', model: 'azure/text-embedding-3-small' },
    resolved: { provider: 'azure', model: 'text-embedding-3-small', dimensions: 1536 },
  }),
  testEmbeddingConnection: () => ({
    success: true,
    resolved: {
      provider: 'azure',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      fallbackOccurred: false,
    },
  }),
}));

describe('AI provider routing settings', () => {
  beforeEach(async () => {
    vi.stubEnv('BIFROST_BASE_URL', 'https://bifrost.test/v1');
    state.writes.length = 0;
    state.failWrites = false;
    state.saved = {
      provider: 'bifrost',
      model: 'azure/gpt-4o-mini',
      baseUrl: 'https://bifrost.test/v1',
      apiKey: 'server-secret',
    };
    const service = await import('@/lib/ai/provider-configuration-service');
    service.invalidateAIProviderConfigurationCache();
  });

  it('never returns a saved provider credential to the client', async () => {
    const { GET } = await import('@/app/api/ai/provider/route');
    const response = await GET();
    const body = await response.json();

    expect(body.savedConfig).toEqual({
      provider: 'bifrost',
      model: 'azure/gpt-4o-mini',
      baseUrl: 'https://bifrost.test/v1',
      embeddingProvider: 'bifrost',
      embeddingModel: 'azure/text-embedding-3-small',
      embeddingBaseUrl: 'https://bifrost.test/v1',
      semanticSearchEnabled: false,
      hasApiKey: true,
      embeddingHasApiKey: true,
    });
    expect(body.providerHealth).toContainEqual({
      route: 'azure-private',
      status: 'configured',
    });
    expect(body.providerHealth).toContainEqual({
      route: 'bifrost-copilot',
      status: 'unknown',
    });
    expect(JSON.stringify(body)).not.toContain('server-secret');
  });

  it('reports an unconfigured embedding route without failing the settings response', async () => {
    state.saved = {
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: '',
      embeddingProvider: 'bifrost',
      embeddingModel: 'azure/text-embedding-3-small',
      embeddingBaseUrl: '',
      embeddingApiKey: '',
      semanticSearchEnabled: false,
    };
    const { GET } = await import('@/app/api/ai/provider/route');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      providerHealth: expect.arrayContaining([
        { route: 'azure-private', status: 'unavailable' },
      ]),
    });
  });

  it('preserves an existing credential when saving a redacted value', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state.saved,
        apiKey: '********',
        routingPolicy,
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(state.writes[0]?.value).toMatchObject({ apiKey: 'server-secret' });
    expect(body.config.apiKey).toBe('********');
  });

  it('preserves a legacy shared credential when saving explicit embedding settings', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state.saved,
        apiKey: '********',
        embeddingProvider: 'bifrost',
        embeddingModel: 'azure/text-embedding-3-small',
        embeddingBaseUrl: 'https://bifrost.test/v1',
        embeddingApiKey: '********',
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(200);
    expect(state.writes[0]?.value).toMatchObject({
      apiKey: 'server-secret',
      embeddingApiKey: 'server-secret',
    });
  });

  it('preserves a saved embedding key when its endpoint is supplied by the environment', async () => {
    state.saved = {
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
      embeddingProvider: 'bifrost',
      embeddingModel: 'azure/text-embedding-3-small',
      embeddingApiKey: 'saved-embedding-secret',
    };
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3.1:8b',
        baseUrl: 'http://localhost:11434/v1',
        embeddingProvider: 'bifrost',
        embeddingModel: 'azure/text-embedding-3-small',
        embeddingBaseUrl: 'https://bifrost.test/v1',
        embeddingApiKey: '********',
        semanticSearchEnabled: false,
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(200);
    expect(state.writes[0]?.value).toMatchObject({
      embeddingBaseUrl: 'https://bifrost.test/v1',
      embeddingApiKey: 'saved-embedding-secret',
    });
  });

  it('preserves independent embedding settings omitted by a legacy client', async () => {
    state.saved = {
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
      embeddingProvider: 'bifrost',
      embeddingModel: 'azure/text-embedding-3-small',
      embeddingApiKey: 'saved-embedding-secret',
    };
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3.1:8b',
        baseUrl: 'http://localhost:11434/v1',
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(200);
    expect(state.writes[0]?.value).toMatchObject({
      embeddingProvider: 'bifrost',
      embeddingApiKey: 'saved-embedding-secret',
    });
  });

  it('allows completion settings to save while the disabled embedding route is unconfigured', async () => {
    state.saved = {};
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-4.1',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'completion-secret',
        embeddingProvider: 'bifrost',
        embeddingModel: 'azure/text-embedding-3-small',
        embeddingBaseUrl: '',
        embeddingApiKey: '',
        semanticSearchEnabled: false,
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(200);
    expect(state.writes[0]?.value).toMatchObject({
      embeddingProvider: 'bifrost',
      embeddingBaseUrl: '',
      semanticSearchEnabled: false,
    });
  });

  it('persists semantic opt-in and a separate Bifrost embedding model', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state.saved,
        apiKey: '********',
        semanticSearchEnabled: true,
        embeddingModel: 'ollama/nomic-embed-text:latest',
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(200);
    expect(state.writes[0]?.value).toMatchObject({
      semanticSearchEnabled: true,
      embeddingModel: 'ollama/nomic-embed-text:latest',
    });
  });

  it('persists an embedding route independently from completions', async () => {
      const { POST } = await import('@/app/api/ai/provider/route');
      const response = await POST(new Request('http://localhost/api/ai/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'ollama',
          model: 'llama3.1:8b',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: '',
          embeddingProvider: 'bifrost',
          embeddingModel: 'azure/text-embedding-3-small',
          embeddingBaseUrl: 'https://bifrost.test/v1',
          embeddingApiKey: 'embedding-secret',
          semanticSearchEnabled: true,
          routingPolicy,
        }),
      }));

      expect(response.status).toBe(200);
      expect(state.writes[0]?.value).toMatchObject({
        provider: 'ollama',
        model: 'llama3.1:8b',
        embeddingProvider: 'bifrost',
        embeddingModel: 'azure/text-embedding-3-small',
        embeddingBaseUrl: 'https://bifrost.test/v1',
        embeddingApiKey: 'embedding-secret',
      });
      expect(await response.json()).toMatchObject({
        config: {
          apiKey: '',
          embeddingApiKey: '********',
        },
      });
  });

  it('runs the embedding-specific connection test without exposing credentials', async () => {
      const { PUT } = await import('@/app/api/ai/provider/route');
      const response = await PUT(new Request(
        'http://localhost/api/ai/provider?target=embedding',
        { method: 'PUT' },
      ));
      const body = await response.json();

      expect(body).toMatchObject({
        success: true,
        resolved: {
          provider: 'azure',
          model: 'text-embedding-3-small',
          dimensions: 1536,
        },
      });
      expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('rejects an invalid Bifrost embedding model even when search enrichment is off', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state.saved,
        apiKey: '********',
        semanticSearchEnabled: false,
        embeddingModel: 'nomic-embed-text',
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('provider prefix'),
    });
  });

  it('does not carry a credential to a different provider or endpoint', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-4.1',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '********',
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(200);
    expect(state.writes[0]?.value).toMatchObject({ apiKey: '' });
  });

  it('rejects credential-bearing remote HTTP endpoints', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-4.1',
        baseUrl: 'http://api.example.com/v1',
        apiKey: 'secret',
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });

  it('rejects ambiguous Bifrost model names', async () => {
    const { POST } = await import('@/app/api/ai/provider/route');
    const response = await POST(new Request('http://localhost/api/ai/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'bifrost',
        model: 'gpt-4o-mini',
        baseUrl: 'https://bifrost.test/v1',
        apiKey: '********',
        routingPolicy,
      }),
    }));

    expect(response.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });

  it('invalidates isolated legacy caches only after a committed pair', async () => {
    state.saved = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'old-secret',
    };
    const firstResolver = await import('@/lib/ai/config-resolver');
    const firstService = await import('@/lib/ai/provider-configuration-service');
    expect(firstResolver.getResolvedAIConfig().model).toBe('gpt-4o-mini');
    expect((await firstService.loadAIProviderConfiguration()).resolved.model).toBe('gpt-4o-mini');

    vi.resetModules();
    const secondResolver = await import('@/lib/ai/config-resolver');
    expect(secondResolver.getResolvedAIConfig().model).toBe('gpt-4o-mini');
    const epoch = await import('@/lib/ai/provider-routing-core');
    const beforeCommit = epoch.getAIConfigInvalidationEpoch();
    const service = await import('@/lib/ai/provider-configuration-service');

    await service.saveAIProviderConfiguration({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'new-secret',
    }, routingPolicy);

    expect(epoch.getAIConfigInvalidationEpoch()).toBe(beforeCommit + 1);
    expect(firstResolver.getResolvedAIConfig().model).toBe('gpt-4.1');
    expect(secondResolver.getResolvedAIConfig().model).toBe('gpt-4.1');
    expect((await firstService.loadAIProviderConfiguration()).resolved.model).toBe('gpt-4.1');

    state.failWrites = true;
    await expect(service.saveAIProviderConfiguration({
      provider: 'openai',
      model: 'must-not-commit',
    }, routingPolicy)).rejects.toThrow('forced settings write failure');
    expect(epoch.getAIConfigInvalidationEpoch()).toBe(beforeCommit + 1);
  });
});
