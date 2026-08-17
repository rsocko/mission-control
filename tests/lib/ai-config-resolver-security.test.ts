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
      embeddingModel: 'ollama/snowflake-arctic-embed',
      semanticSearchEnabled: false,
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
