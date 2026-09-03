import { sqlite } from '@/db';
import { aiLogger } from '@/lib/logger';
import type { AIRoutingPolicyConfig, SavedAIProviderConfig, ResolvedAIConfig } from './types';
import {
  AIRoutingPolicyValidationError,
  DEFAULT_AI_ROUTING_POLICY,
  validateAIRoutingPolicy,
} from './sensitivity-policy';
import {
  DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  parseSavedAIProviderConfig,
  resolveAIConfig,
} from './config-values';

const SETTINGS_KEY = 'ai_provider_config';
const ROUTING_POLICY_SETTINGS_KEY = 'ai_routing_policy';
const CONFIG_CACHE_TTL = 60_000;
export { DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL, DEFAULT_EMBEDDING_PROVIDER };

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
  cachedConfig = resolveAIConfig(saved);
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
