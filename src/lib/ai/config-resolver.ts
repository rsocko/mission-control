import { sqlite } from '@/db';
import { aiLogger } from '@/lib/logger';
import type { AIRoutingPolicyConfig, SavedAIProviderConfig, ResolvedAIConfig } from './types';
import {
  AIRoutingPolicyValidationError,
  DEFAULT_AI_ROUTING_POLICY,
  validateAIRoutingPolicy,
} from './sensitivity-policy';

const SETTINGS_KEY = 'ai_provider_config';
const ROUTING_POLICY_SETTINGS_KEY = 'ai_routing_policy';
const CONFIG_CACHE_TTL = 60_000;
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

let cachedConfig: ResolvedAIConfig | null = null;
let cachedRoutingPolicy: AIRoutingPolicyConfig | null = null;
let cacheTime = 0;
let routingPolicyCacheTime = 0;

function parseSavedAIProviderConfig(value: unknown): SavedAIProviderConfig {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as SavedAIProviderConfig;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  if (typeof value === 'object') {
    return value as SavedAIProviderConfig;
  }

  return {};
}

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

function resolveProviderBaseUrl(provider: string, saved: SavedAIProviderConfig) {
  if (provider === 'bifrost') {
    return saved.baseUrl || process.env.BIFROST_BASE_URL || process.env.AI_BASE_URL;
  }

  if (provider === 'azure') {
    return saved.baseUrl || process.env.AZURE_OPENAI_ENDPOINT || process.env.AI_BASE_URL;
  }

  if (provider === 'ollama') {
    return saved.baseUrl || process.env.AI_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
  }

  return saved.baseUrl || process.env.AI_BASE_URL;
}

function resolveProviderApiKey(provider: string, saved: SavedAIProviderConfig) {
  const savedBaseUrl = saved.baseUrl?.replace(/\/+$/, '');
  const environmentBaseUrl = resolveProviderBaseUrl(provider, {})?.replace(/\/+$/, '');
  const mayUseEnvironmentCredential = !savedBaseUrl
    || savedBaseUrl === environmentBaseUrl
    || (provider === 'openai' && savedBaseUrl === 'https://api.openai.com/v1');

  if (saved.apiKey) {
    return saved.apiKey;
  }
  if (!mayUseEnvironmentCredential) {
    return '';
  }

  if (provider === 'bifrost') {
    return process.env.BIFROST_API_KEY || '';
  }

  if (provider === 'azure') {
    return process.env.AZURE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
  }

  return process.env.OPENAI_API_KEY || '';
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
  const provider = saved.provider || process.env.AI_PROVIDER || DEFAULT_PROVIDER;
  const model = saved.model || process.env.AI_MODEL || DEFAULT_MODEL;
  const baseUrl = resolveProviderBaseUrl(provider, saved);
  const apiKey = resolveProviderApiKey(provider, saved);
  const configured = provider === 'ollama'
    ? Boolean(baseUrl)
    : Boolean(apiKey || baseUrl);

  cachedConfig = {
    provider,
    model,
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
