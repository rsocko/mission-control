import type { ResolvedAIConfig, SavedAIProviderConfig } from './types';

type AIEnvironment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_AI_PROVIDER = 'openai';
export const DEFAULT_AI_MODEL = 'gpt-4o-mini';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_EMBEDDING_PROVIDER = 'bifrost';
export const DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL = 'azure/text-embedding-3-small';

export function parseSavedAIProviderConfig(value: unknown): SavedAIProviderConfig {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as SavedAIProviderConfig
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? value as SavedAIProviderConfig
    : {};
}

export function resolveAIProviderBaseUrl(
  provider: string,
  saved: Pick<SavedAIProviderConfig, 'baseUrl'>,
  allowGenericEnvironment = true,
  environment: AIEnvironment = process.env,
): string | undefined {
  if (provider === 'bifrost') {
    return saved.baseUrl
      || environment.BIFROST_BASE_URL
      || (allowGenericEnvironment ? environment.AI_BASE_URL : undefined);
  }
  if (provider === 'azure') {
    return saved.baseUrl
      || environment.AZURE_OPENAI_ENDPOINT
      || (allowGenericEnvironment ? environment.AI_BASE_URL : undefined);
  }
  if (provider === 'ollama') {
    return saved.baseUrl || environment.AI_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
  }
  return saved.baseUrl || (allowGenericEnvironment ? environment.AI_BASE_URL : undefined);
}

export function resolveAIProviderApiKey(
  provider: string,
  saved: Pick<SavedAIProviderConfig, 'baseUrl' | 'apiKey'>,
  allowGenericEnvironment = true,
  environment: AIEnvironment = process.env,
): string {
  const savedBaseUrl = saved.baseUrl?.replace(/\/+$/, '');
  const environmentBaseUrl = resolveAIProviderBaseUrl(
    provider,
    {},
    allowGenericEnvironment,
    environment,
  )?.replace(/\/+$/, '');
  const mayUseEnvironmentCredential = !savedBaseUrl
    || savedBaseUrl === environmentBaseUrl
    || (provider === 'openai' && savedBaseUrl === 'https://api.openai.com/v1');

  if (saved.apiKey) return saved.apiKey;
  if (!mayUseEnvironmentCredential) return '';
  if (provider === 'bifrost') return environment.BIFROST_API_KEY || '';
  if (provider === 'azure') {
    return environment.AZURE_OPENAI_API_KEY || environment.OPENAI_API_KEY || '';
  }
  return environment.OPENAI_API_KEY || '';
}

export function resolveAICompletionConfig(
  saved: SavedAIProviderConfig,
  environment: AIEnvironment = process.env,
): {
  provider: string;
  model: string;
  baseUrl: string | undefined;
  apiKey: string;
  configured: boolean;
} {
  const provider = saved.provider || environment.AI_PROVIDER || DEFAULT_AI_PROVIDER;
  const model = saved.model || environment.AI_MODEL || DEFAULT_AI_MODEL;
  const baseUrl = resolveAIProviderBaseUrl(provider, saved, true, environment);
  const apiKey = resolveAIProviderApiKey(provider, saved, true, environment);
  return {
    provider,
    model,
    baseUrl,
    apiKey,
    configured: provider === 'ollama' ? Boolean(baseUrl) : Boolean(apiKey || baseUrl),
  };
}

function enabled(
  saved: boolean | undefined,
  environmentValue: string | undefined,
): boolean {
  if (typeof saved === 'boolean') return saved;
  return /^(1|true|yes|on)$/i.test(environmentValue?.trim() ?? '');
}

function defaultEmbeddingModel(provider: string): string {
  if (provider === 'ollama') return 'nomic-embed-text';
  if (provider === 'bifrost') return DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL;
  return 'text-embedding-3-small';
}

/**
 * Resolves completion and embedding configuration without reading persistence.
 * Composition roots can load settings through their selected backend and reuse
 * the same rules without importing a backend-specific database handle.
 */
export function resolveAIConfig(
  saved: SavedAIProviderConfig,
  environment: AIEnvironment = process.env,
): ResolvedAIConfig {
  const completion = resolveAICompletionConfig(saved, environment);
  const { provider, model, baseUrl, apiKey, configured } = completion;
  const legacyEmbeddingProvider = saved.provider || environment.AI_PROVIDER;
  const embeddingProvider = saved.embeddingProvider
    || environment.AI_EMBEDDING_PROVIDER
    || legacyEmbeddingProvider
    || DEFAULT_EMBEDDING_PROVIDER;
  const embeddingModel = saved.embeddingModel
    || environment.AI_EMBEDDING_MODEL
    || defaultEmbeddingModel(embeddingProvider);
  const sharesCompletionTarget = !saved.embeddingProvider
    && !environment.AI_EMBEDDING_PROVIDER
    && embeddingProvider === provider;
  const embeddingTarget = {
    baseUrl: saved.embeddingBaseUrl
      || environment.AI_EMBEDDING_BASE_URL
      || (sharesCompletionTarget ? saved.baseUrl : undefined),
    apiKey: saved.embeddingApiKey
      || environment.AI_EMBEDDING_API_KEY
      || (sharesCompletionTarget ? saved.apiKey : undefined),
  };
  const embeddingBaseUrl = resolveAIProviderBaseUrl(
    embeddingProvider,
    embeddingTarget,
    sharesCompletionTarget,
    environment,
  );
  const embeddingApiKey = resolveAIProviderApiKey(
    embeddingProvider,
    embeddingTarget,
    sharesCompletionTarget,
    environment,
  );
  const embeddingConfigured = embeddingProvider === 'ollama'
    ? Boolean(embeddingBaseUrl)
    : embeddingProvider === 'azure'
      ? Boolean(embeddingBaseUrl && embeddingApiKey)
      : embeddingProvider === 'bifrost'
        ? Boolean(embeddingBaseUrl)
        : Boolean(embeddingApiKey || embeddingBaseUrl);
  const retentionDays = saved.houstonMemoryRetentionDays
    ?? Number(environment.AI_HOUSTON_MEMORY_RETENTION_DAYS);

  return {
    provider,
    model,
    embeddingProvider,
    embeddingModel,
    embeddingBaseUrl,
    embeddingApiKey,
    embeddingConfigured,
    semanticSearchEnabled: enabled(
      saved.semanticSearchEnabled,
      environment.AI_SEMANTIC_SEARCH_ENABLED,
    ),
    houstonMemoryEnabled: enabled(
      saved.houstonMemoryEnabled,
      environment.AI_HOUSTON_MEMORY_ENABLED,
    ),
    houstonMemoryRetentionDays: Number.isSafeInteger(retentionDays)
      ? Math.min(Math.max(retentionDays, 1), 365)
      : 90,
    baseUrl,
    apiKey,
    configured,
  };
}
