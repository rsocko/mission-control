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

vi.mock('@/lib/ai', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/ai/sensitivity-policy')
  >('@/lib/ai/sensitivity-policy');
  return {
  AIProviderEndpointValidationError: actual.AIProviderEndpointValidationError,
  AIRoutingPolicyValidationError: actual.AIRoutingPolicyValidationError,
  getAIRoutingPolicy: () => routingPolicy,
  getProviderInfo: () => ({
    provider: 'bifrost',
    model: 'azure/gpt-4o-mini',
    baseUrl: 'https://bifrost.test/v1',
    configured: true,
    embeddingModel: 'ollama/nomic-embed-text:latest',
    semanticSearchEnabled: false,
  }),
  getResolvedAIConfig: () => ({
    provider: 'bifrost',
    model: 'azure/gpt-4o-mini',
    embeddingModel: 'ollama/nomic-embed-text:latest',
    semanticSearchEnabled: false,
    baseUrl: 'https://bifrost.test/v1',
    apiKey: 'server-secret',
    configured: true,
  }),
  invalidateAIConfigCache: vi.fn(),
  validateAIRoutingPolicy: (value: unknown) => value,
  validateProviderEndpoint: actual.validateProviderEndpoint,
  parseBifrostModelId: actual.parseBifrostModelId,
  getAIRequestContext: vi.fn(),
  getAIRouteOutcome: vi.fn(),
  getAIRoutingHeaders: vi.fn(),
  };
});

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
      embeddingModel: 'ollama/nomic-embed-text:latest',
      semanticSearchEnabled: false,
      hasApiKey: true,
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
