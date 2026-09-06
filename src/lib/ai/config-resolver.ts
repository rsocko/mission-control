import {
  invalidateAIProviderConfigurationCache,
  loadAIProviderConfiguration,
} from './provider-configuration-service';
import {
  DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
} from './config-values';
import type { AIRoutingPolicyConfig, ResolvedAIConfig } from './types';

export { DEFAULT_BIFROST_AZURE_EMBEDDING_MODEL, DEFAULT_EMBEDDING_PROVIDER };

export function invalidateAIConfigCache() {
  invalidateAIProviderConfigurationCache();
}

export async function loadResolvedAIConfig(): Promise<ResolvedAIConfig> {
  return (await loadAIProviderConfiguration()).resolved;
}

export async function loadAIRoutingPolicy(): Promise<AIRoutingPolicyConfig> {
  return (await loadAIProviderConfiguration()).routingPolicy;
}

/**
 * @deprecated Persistence-backed configuration is asynchronous. Use
 * `loadResolvedAIConfig` or `getAsyncAIProviderConfiguration`.
 */
export function getResolvedAIConfig(): ResolvedAIConfig {
  throw new Error('Synchronous AI configuration access is unavailable; use loadResolvedAIConfig');
}

/**
 * @deprecated Persistence-backed configuration is asynchronous. Use
 * `loadAIRoutingPolicy` or `getAsyncAIModel`.
 */
export function getAIRoutingPolicy(): AIRoutingPolicyConfig {
  throw new Error('Synchronous AI routing policy access is unavailable; use loadAIRoutingPolicy');
}
