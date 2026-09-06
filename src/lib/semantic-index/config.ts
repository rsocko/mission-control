/**
 * Worker/service tunables for the durable semantic index.
 *
 * Every bound is explicit and every default is conservative: the index worker
 * shares a process with the sync worker, so it must never be able to consume
 * the whole event loop, hold a lease past its heartbeat, or run forever.
 */

import { loadAIProviderConfiguration } from '@/lib/ai/provider-configuration-service';
import { getAIConfigInvalidationEpoch } from '@/lib/ai/provider-routing-core';
import type { AIRoutingPolicyConfig, ResolvedAIConfig } from '@/lib/ai/types';
import { semanticIndexLogger } from '@/lib/logger';
import {
  SEMANTIC_SOURCE_ENTITY_TYPES,
  type SemanticSourceEntityType,
} from './source/contracts';
import {
  resolveSemanticWorkerConfig,
  type SemanticWorkerConfig,
} from './worker-config';

export type { SemanticWorkerConfig } from './worker-config';

const CONFIG_CACHE_TTL_MS = 60_000;

interface SemanticIndexConfiguration {
  ai: ResolvedAIConfig;
  routingPolicy: AIRoutingPolicyConfig;
  worker: SemanticWorkerConfig;
}

let cachedConfiguration: SemanticIndexConfiguration | null = null;
let cacheTime = 0;
let cachedEpoch = getAIConfigInvalidationEpoch();
let refreshPromise: Promise<SemanticIndexConfiguration> | null = null;

function workerConfigFor(ai: ResolvedAIConfig): SemanticWorkerConfig {
  const entityTypes = SEMANTIC_SOURCE_ENTITY_TYPES.filter((entityType) =>
    entityType === 'houston-summary'
      ? ai.houstonMemoryEnabled
      : ai.semanticSearchEnabled
  );
  return resolveSemanticWorkerConfig(entityTypes);
}

function observeInvalidation(): void {
  const epoch = getAIConfigInvalidationEpoch();
  if (epoch === cachedEpoch) return;
  cachedEpoch = epoch;
  cachedConfiguration = null;
  cacheTime = 0;
}

export async function loadSemanticIndexConfiguration(): Promise<SemanticIndexConfiguration> {
  observeInvalidation();
  if (cachedConfiguration && Date.now() - cacheTime < CONFIG_CACHE_TTL_MS) {
    return cachedConfiguration;
  }
  if (!refreshPromise) {
    const refresh = (async () => {
      for (;;) {
        const epoch = getAIConfigInvalidationEpoch();
        const { resolved, routingPolicy } = await loadAIProviderConfiguration();
        if (epoch !== getAIConfigInvalidationEpoch()) {
          observeInvalidation();
          continue;
        }
        cachedEpoch = epoch;
        cachedConfiguration = {
          ai: resolved,
          routingPolicy,
          worker: workerConfigFor(resolved),
        };
        cacheTime = Date.now();
        return cachedConfiguration;
      }
    })();
    const trackedRefresh = refresh.finally(() => {
      if (refreshPromise === trackedRefresh) refreshPromise = null;
    });
    refreshPromise = trackedRefresh;
  }
  return refreshPromise;
}

function refreshAfterInvalidation(): void {
  void loadSemanticIndexConfiguration().catch((error) => {
    semanticIndexLogger.warn({
      event: 'semantic_configuration_refresh_failed',
      err: error,
    }, 'Semantic index configuration refresh failed');
  });
}

export function getSemanticWorkerConfig(): SemanticWorkerConfig {
  observeInvalidation();
  if (!cachedConfiguration || Date.now() - cacheTime >= CONFIG_CACHE_TTL_MS) {
    refreshAfterInvalidation();
  }
  if (!cachedConfiguration) {
    return resolveSemanticWorkerConfig([]);
  }
  return cachedConfiguration.worker;
}

/**
 * The index is only maintained when semantic search enrichment is switched on.
 * When it is off the worker still starts, but parks immediately and performs no
 * reads, writes, or provider calls.
 */
export function isSemanticIndexEnabled(): boolean {
  if (/^(1|true|yes|on)$/i.test(process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED?.trim() ?? '')) {
    return false;
  }
  observeInvalidation();
  if (!cachedConfiguration || Date.now() - cacheTime >= CONFIG_CACHE_TTL_MS) {
    refreshAfterInvalidation();
  }
  // This synchronous function is only a cheap publication/worker preflight.
  // The async runtime rechecks persisted settings before provider or storage I/O.
  if (!cachedConfiguration) return true;
  return Boolean(
    cachedConfiguration.ai.semanticSearchEnabled
    || cachedConfiguration.ai.houstonMemoryEnabled
  );
}

export function isSemanticEntityTypeEnabled(entityType: SemanticSourceEntityType): boolean {
  observeInvalidation();
  if (!cachedConfiguration || Date.now() - cacheTime >= CONFIG_CACHE_TTL_MS) {
    refreshAfterInvalidation();
  }
  if (!cachedConfiguration) return true;
  return entityType === 'houston-summary'
    ? cachedConfiguration.ai.houstonMemoryEnabled
    : cachedConfiguration.ai.semanticSearchEnabled;
}

export function getSemanticRoutingPolicy(): AIRoutingPolicyConfig {
  observeInvalidation();
  if (!cachedConfiguration || Date.now() - cacheTime >= CONFIG_CACHE_TTL_MS) {
    refreshAfterInvalidation();
    throw new Error('Semantic routing policy is refreshing');
  }
  return cachedConfiguration.routingPolicy;
}
