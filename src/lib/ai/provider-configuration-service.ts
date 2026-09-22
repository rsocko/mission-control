import type { PersistenceJson } from '@/db/persistence/contracts';
import type {
  ActiveEmbeddingIdentity,
  AtomicSettingsRepository,
  SettingsRepository,
} from '@/db/persistence/core-repositories';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { aiLogger } from '@/lib/logger';
import {
  parseSavedAIProviderConfig,
  resolveAIConfig,
} from './config-values';
import {
  advanceAIConfigInvalidationEpoch,
  getAIConfigInvalidationEpoch,
} from './provider-routing-core';
import {
  AIRoutingPolicyValidationError,
  DEFAULT_AI_ROUTING_POLICY,
  validateAIRoutingPolicy,
} from './sensitivity-policy';
import type {
  AIRoutingPolicyConfig,
  ResolvedAIConfig,
  SavedAIProviderConfig,
} from './types';

export const AI_PROVIDER_SETTINGS_KEY = 'ai_provider_config';
export const AI_ROUTING_POLICY_SETTINGS_KEY = 'ai_routing_policy';
const CONFIG_CACHE_TTL_MS = 60_000;

export interface AIProviderConfigurationSnapshot {
  saved: SavedAIProviderConfig;
  resolved: ResolvedAIConfig;
  routingPolicy: AIRoutingPolicyConfig;
}

let cachedSnapshot: AIProviderConfigurationSnapshot | null = null;
let cacheTime = 0;
let cacheGeneration = 0;
let observedInvalidationEpoch = getAIConfigInvalidationEpoch();

function supportsAtomicSettings(
  repository: SettingsRepository,
): repository is AtomicSettingsRepository {
  return (
    typeof repository.getMany === 'function'
    && typeof repository.setMany === 'function'
    && typeof repository.getActiveEmbeddingIdentity === 'function'
  );
}

function requireAtomicSettingsRepository(): AtomicSettingsRepository {
  const repository = getCorePersistenceRepositories().settings;
  if (!supportsAtomicSettings(repository)) {
    throw new Error('The selected persistence backend does not support atomic AI settings');
  }
  return repository;
}

function observeSharedInvalidationEpoch(): number {
  const epoch = getAIConfigInvalidationEpoch();
  if (epoch !== observedInvalidationEpoch) {
    invalidateAIProviderConfigurationCache();
    observedInvalidationEpoch = epoch;
  }
  return epoch;
}

function parseRoutingPolicy(value: PersistenceJson | null): AIRoutingPolicyConfig {
  if (value === null) return DEFAULT_AI_ROUTING_POLICY;
  try {
    return validateAIRoutingPolicy(value);
  } catch (error) {
    if (error instanceof AIRoutingPolicyValidationError || error instanceof SyntaxError) {
      aiLogger.error({ err: error }, 'Stored AI routing policy is invalid; using secure defaults');
      return DEFAULT_AI_ROUTING_POLICY;
    }
    throw error;
  }
}

function routingPolicyToJson(policy: AIRoutingPolicyConfig): PersistenceJson {
  const policies: Record<string, PersistenceJson> = {};
  for (const [sensitivity, value] of Object.entries(policy.policies)) {
    policies[sensitivity] = { allowedRoutes: [...value.allowedRoutes] };
  }
  return {
    policies,
    featureDefaults: { ...policy.featureDefaults },
    sourceDefaults: { ...policy.sourceDefaults },
  };
}

export async function loadAIProviderConfiguration(
  options: { fresh?: boolean } = {},
): Promise<AIProviderConfigurationSnapshot> {
  observeSharedInvalidationEpoch();
  if (
    !options.fresh
    && cachedSnapshot
    && Date.now() - cacheTime < CONFIG_CACHE_TTL_MS
  ) {
    return cachedSnapshot;
  }

  for (;;) {
    const generation = cacheGeneration;
    const invalidationEpoch = observedInvalidationEpoch;
    const values = await requireAtomicSettingsRepository().getMany([
      AI_PROVIDER_SETTINGS_KEY,
      AI_ROUTING_POLICY_SETTINGS_KEY,
    ]);
    if (
      generation !== cacheGeneration
      || invalidationEpoch !== getAIConfigInvalidationEpoch()
    ) {
      observeSharedInvalidationEpoch();
      continue;
    }

    const saved = parseSavedAIProviderConfig(values[AI_PROVIDER_SETTINGS_KEY]);
    cachedSnapshot = {
      saved,
      resolved: resolveAIConfig(saved),
      routingPolicy: parseRoutingPolicy(values[AI_ROUTING_POLICY_SETTINGS_KEY]),
    };
    cacheTime = Date.now();
    return cachedSnapshot;
  }
}

export async function saveAIProviderConfiguration(
  config: PersistenceJson,
  routingPolicy: AIRoutingPolicyConfig,
): Promise<void> {
  await requireAtomicSettingsRepository().setMany([
    [AI_PROVIDER_SETTINGS_KEY, config],
    [AI_ROUTING_POLICY_SETTINGS_KEY, routingPolicyToJson(routingPolicy)],
  ]);
  observedInvalidationEpoch = advanceAIConfigInvalidationEpoch();
  invalidateAIProviderConfigurationCache();
}

export function invalidateAIProviderConfigurationCache(): void {
  cacheGeneration += 1;
  cachedSnapshot = null;
  cacheTime = 0;
}

export async function getActiveEmbeddingIdentity(): Promise<ActiveEmbeddingIdentity | null> {
  return requireAtomicSettingsRepository().getActiveEmbeddingIdentity();
}
