import { sqlite } from '@/db';
import { aiLogger } from '@/lib/logger';
import type { AIRoutingPolicyConfig, SavedAIProviderConfig, ResolvedAIConfig } from './types';
import {
  AIRoutingPolicyValidationError,
  DEFAULT_AI_ROUTING_POLICY,
  validateAIRoutingPolicy,
} from './sensitivity-policy';
import {
  parseSavedAIProviderConfig,
  resolveAICompletionConfig,
  resolveAIProviderApiKey,
  resolveAIProviderBaseUrl,
} from './config-values';

const SETTINGS_KEY = 'ai_provider_config';
const ROUTING_POLICY_SETTINGS_KEY = 'ai_routing_policy';
const CONFIG_CACHE_TTL = 60_000;
export const DEFAULT_EMBEDDING_PROVIDER = 'bifrost';
export const DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL = 'azure/text-embedding-3-small';

let cachedConfig: ResolvedAIConfig | null = null;
let cachedRoutingPolicy: AIRoutingPolicyConfig | null = null;
let cacheTime = 0;
let routingPolicyCacheTime = 0;

function loadSavedAIProviderConfigSync(): SavedAIProviderConfig {
  try {
    const row = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
      .get(SETTINGS_KEY) as { value?: unknown } | undefined;

    return parseSavedAIProviderConfig(row?.value);
  } catch {
    return {};
  }
}

function getDefaultEmbeddingModel(provider: string) {
  if (provider === 'ollama') return 'nomic-embed-text';
  if (provider === 'bifrost') return DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL;
  return 'text-embedding-3-small';
}

function resolveSemanticSearchEnabled(saved: SavedAIProviderConfig) {
  if (typeof saved.semanticSearchEnabled === 'boolean') {
    return saved.semanticSearchEnabled;
  }
  return /^(1|true|yes|on)$/i.test(process.env.AI_SEMANTIC_SEARCH_ENABLED?.trim() ?? '');
}

function resolveHoustonMemoryEnabled(saved: SavedAIProviderConfig) {
  if (typeof saved.houstonMemoryEnabled === 'boolean') return saved.houstonMemoryEnabled;
  return /^(1|true|yes|on)$/i.test(process.env.AI_HOUSTON_MEMORY_ENABLED?.trim() ?? '');
}

function resolveHoustonMemoryRetentionDays(saved: SavedAIProviderConfig) {
  const value = saved.houstonMemoryRetentionDays
    ?? Number(process.env.AI_HOUSTON_MEMORY_RETENTION_DAYS);
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 365) : 90;
}

export function invalidateAIConfigCache() {
  cachedConfig = null;
  cachedRoutingPolicy = null;
  cacheTime = 0;
  routingPolicyCacheTime = 0;
}

export function getResolvedAIConfig(): ResolvedAIConfig {
  if (cachedConfig && Date.now() - cacheTime < CONFIG_CACHE_TTL) {
    return cachedConfig;
  }

  const saved = loadSavedAIProviderConfigSync();
  const completion = resolveAICompletionConfig(saved);
  const { provider, model, baseUrl, apiKey, configured } = completion;
  const legacyEmbeddingProvider = saved.provider || process.env.AI_PROVIDER;
  const embeddingProvider = saved.embeddingProvider
    || process.env.AI_EMBEDDING_PROVIDER
    || legacyEmbeddingProvider
    || DEFAULT_EMBEDDING_PROVIDER;
  const embeddingModel = saved.embeddingModel
    || process.env.AI_EMBEDDING_MODEL
    || getDefaultEmbeddingModel(embeddingProvider);
  const sharesCompletionTarget = !saved.embeddingProvider
    && !process.env.AI_EMBEDDING_PROVIDER
    && embeddingProvider === provider;
  const embeddingTarget = {
    baseUrl: saved.embeddingBaseUrl
      || process.env.AI_EMBEDDING_BASE_URL
      || (sharesCompletionTarget ? saved.baseUrl : undefined),
    apiKey: saved.embeddingApiKey
      || process.env.AI_EMBEDDING_API_KEY
      || (sharesCompletionTarget ? saved.apiKey : undefined),
  };
  const embeddingBaseUrl = resolveAIProviderBaseUrl(
    embeddingProvider,
    embeddingTarget,
    sharesCompletionTarget,
  );
  const embeddingApiKey = resolveAIProviderApiKey(
    embeddingProvider,
    embeddingTarget,
    sharesCompletionTarget,
  );
  const embeddingConfigured = embeddingProvider === 'ollama'
    ? Boolean(embeddingBaseUrl)
    : embeddingProvider === 'azure'
      ? Boolean(embeddingBaseUrl && embeddingApiKey)
      : embeddingProvider === 'bifrost'
        ? Boolean(embeddingBaseUrl)
        : Boolean(embeddingApiKey || embeddingBaseUrl);

  cachedConfig = {
    provider,
    model,
    embeddingProvider,
    embeddingModel,
    embeddingBaseUrl,
    embeddingApiKey,
    embeddingConfigured,
    semanticSearchEnabled: resolveSemanticSearchEnabled(saved),
    houstonMemoryEnabled: resolveHoustonMemoryEnabled(saved),
    houstonMemoryRetentionDays: resolveHoustonMemoryRetentionDays(saved),
    baseUrl,
    apiKey,
    configured,
  };
  cacheTime = Date.now();

  return cachedConfig;
}

export function getAIRoutingPolicy(): AIRoutingPolicyConfig {
  if (cachedRoutingPolicy && Date.now() - routingPolicyCacheTime < CONFIG_CACHE_TTL) {
    return cachedRoutingPolicy;
  }

  try {
    const row = sqlite
      .prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
      .get(ROUTING_POLICY_SETTINGS_KEY) as { value?: unknown } | undefined;
    cachedRoutingPolicy = row?.value
      ? validateAIRoutingPolicy(typeof row.value === 'string' ? JSON.parse(row.value) : row.value)
      : DEFAULT_AI_ROUTING_POLICY;
  } catch (error) {
    if (error instanceof AIRoutingPolicyValidationError || error instanceof SyntaxError) {
      aiLogger.error({ err: error }, 'Stored AI routing policy is invalid; using secure defaults');
    } else {
      aiLogger.warn({ err: error }, 'Unable to load AI routing policy; using secure defaults');
    }
    cachedRoutingPolicy = DEFAULT_AI_ROUTING_POLICY;
  }

  routingPolicyCacheTime = Date.now();
  return cachedRoutingPolicy;
}
