import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  saved: {} as Record<string, string | boolean>,
}));

vi.mock('@/db', () => ({
  sqlite: {
    prepare: () => ({
      get: () => ({ value: state.saved }),
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { warn: vi.fn() },
}));

describe('AI provider credential resolution', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    state.saved = {};
    const { invalidateAIConfigCache } = await import('@/lib/ai/config-resolver');
    invalidateAIConfigCache();
  });

  it('does not send an environment credential to a saved endpoint override', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'environment-secret');
    state.saved = {
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://attacker.example/v1',
    };

    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');
    expect(getResolvedAIConfig().apiKey).toBe('');
  });

  it('keeps an environment credential bound to its environment endpoint', async () => {
    vi.stubEnv('AI_PROVIDER', 'bifrost');
    vi.stubEnv('BIFROST_BASE_URL', 'https://trusted-bifrost.example/v1');
    vi.stubEnv('BIFROST_API_KEY', 'environment-secret');
    state.saved = {
      provider: 'bifrost',
      model: 'gpt-4.1',
      baseUrl: 'https://trusted-bifrost.example/v1/',
    };

    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');
    expect(getResolvedAIConfig().apiKey).toBe('environment-secret');
  });

  it('keeps semantic search off by default and resolves its model separately', async () => {
    vi.stubEnv('AI_PROVIDER', 'bifrost');
    vi.stubEnv('AI_MODEL', 'azure/gpt-4o-mini');
    vi.stubEnv('AI_EMBEDDING_MODEL', 'ollama/snowflake-arctic-embed');

    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');
    expect(getResolvedAIConfig()).toMatchObject({
      model: 'azure/gpt-4o-mini',
      embeddingProvider: 'bifrost',
      embeddingModel: 'ollama/snowflake-arctic-embed',
      semanticSearchEnabled: false,
    });
  });

  it('recommends Bifrost to Azure embeddings without changing completion defaults', async () => {
    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');

    expect(getResolvedAIConfig()).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      embeddingProvider: 'bifrost',
      embeddingModel: 'azure/text-embedding-3-small',
    });
  });

  it('resolves an explicitly independent embedding target and credential', async () => {
    vi.stubEnv('AI_PROVIDER', 'ollama');
    vi.stubEnv('AI_EMBEDDING_PROVIDER', 'bifrost');
    vi.stubEnv('AI_EMBEDDING_MODEL', 'azure/embedding-deployment');
    vi.stubEnv('AI_EMBEDDING_BASE_URL', 'https://bifrost.example/v1');
    vi.stubEnv('AI_EMBEDDING_API_KEY', 'embedding-secret');

    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');

    expect(getResolvedAIConfig()).toMatchObject({
      provider: 'ollama',
      embeddingProvider: 'bifrost',
      embeddingModel: 'azure/embedding-deployment',
      embeddingBaseUrl: 'https://bifrost.example/v1',
      embeddingApiKey: 'embedding-secret',
      embeddingConfigured: true,
    });
  });

  it('does not reuse the completion base URL for an independent embedding route', async () => {
    vi.stubEnv('AI_PROVIDER', 'ollama');
    vi.stubEnv('AI_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('AI_EMBEDDING_PROVIDER', 'bifrost');
    vi.stubEnv('BIFROST_BASE_URL', '');

    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');

    expect(getResolvedAIConfig()).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      embeddingProvider: 'bifrost',
      embeddingBaseUrl: undefined,
      embeddingConfigured: false,
    });
  });

  it('lets a persisted semantic opt-in override the environment fallback', async () => {
    vi.stubEnv('AI_SEMANTIC_SEARCH_ENABLED', 'false');
    state.saved = {
      provider: 'ollama',
      model: 'llama3.1',
      embeddingModel: 'mxbai-embed-large',
      semanticSearchEnabled: true,
    };

    const { getResolvedAIConfig } = await import('@/lib/ai/config-resolver');
    expect(getResolvedAIConfig()).toMatchObject({
      embeddingModel: 'mxbai-embed-large',
      semanticSearchEnabled: true,
    });
  });
});
