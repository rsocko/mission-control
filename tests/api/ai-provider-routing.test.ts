import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  saved: {
    provider: 'bifrost',
    model: 'azure/gpt-4o-mini',
    baseUrl: 'https://bifrost.test/v1',
    apiKey: 'server-secret',
  } as Record<string, string | boolean>,
  writes: [] as Array<{ key: string; value: unknown }>,
}));

const routingPolicy = {
  policies: {
    'local-only': { allowedRoutes: ['ollama'] },
    restricted: { allowedRoutes: ['ollama', 'azure-private'] },
    standard: { allowedRoutes: ['bifrost-copilot', 'ollama'] },
  },
  featureDefaults: {},
  sourceDefaults: {},
};

vi.mock('@/db/schema', () => ({
  appSettings: { key: 'key' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'condition'),
  sql: vi.fn(() => 'sql'),
}));

vi.mock('@/db', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [{ value: state.saved }],
  };
  const tx = {
    insert: () => ({
      values: (value: { key: string; value: unknown }) => {
        state.writes.push(value);
        return { onConflictDoUpdate: () => ({ run: () => undefined }) };
      },
    }),
  };
  return {
    default: {
      select: () => selectChain,
      transaction: (callback: (transaction: typeof tx) => void) => callback(tx),
    },
  };
});

vi.mock('@/lib/ai/sensitivity-policy', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/ai/sensitivity-policy')
  >('@/lib/ai/sensitivity-policy');
  return {
    ...actual,
    validateAIRoutingPolicy: (value: unknown) => value,
  };
});

vi.mock('@/lib/ai/config-resolver', () => ({
  getAIRoutingPolicy: () => routingPolicy,
  getResolvedAIConfig: () => ({
    provider: 'bifrost',
    model: 'azure/gpt-4o-mini',
    embeddingProvider: 'bifrost',
    embeddingModel: 'azure/text-embedding-3-small',
    embeddingBaseUrl: 'https://bifrost.test/v1',
    embeddingApiKey: 'embedding-secret',
    embeddingConfigured: true,
    semanticSearchEnabled: false,
    baseUrl: 'https://bifrost.test/v1',
    apiKey: 'server-secret',
    configured: true,
  }),
  invalidateAIConfigCache: vi.fn(),
}));

vi.mock('@/lib/ai/provider-factory', () => ({
  getProviderInfo: () => ({
    provider: 'bifrost',
    model: 'azure/gpt-4o-mini',
    baseUrl: 'https://bifrost.test/v1',
    configured: true,
    embeddingModel: 'ollama/nomic-embed-text:latest',
    semanticSearchEnabled: false,
  }),
  getAIRequestContext: vi.fn(),
  getAIRouteOutcome: vi.fn(),
  getAIRoutingHeaders: vi.fn(),
}));

vi.mock('@/lib/search/semantic', () => ({
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
  beforeEach(() => {
    vi.stubEnv('BIFROST_BASE_URL', 'https://bifrost.test/v1');
    state.writes.length = 0;
    state.saved = {
      provider: 'bifrost',
      model: 'azure/gpt-4o-mini',
      baseUrl: 'https://bifrost.test/v1',
      apiKey: 'server-secret',
    };
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
});
