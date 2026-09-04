import {
  getActiveEmbeddingIdentity,
  loadAIProviderConfiguration,
  type AIProviderConfigurationSnapshot,
} from '@/lib/ai/provider-configuration-service';
import { AIRoutingDeniedError } from '@/lib/ai/sensitivity-policy';
import { aiLogger } from '@/lib/logger';
import {
  getConfiguredEmbeddingRoute,
  type EmbeddingConfig,
} from './embedding-transport';
import {
  getEmbeddingConfigForResolvedAI,
  requestEmbeddingWithRetriesForConfig,
} from './embedding-config-core';

export interface EmbeddingRouteIdentity {
  provider: string;
  model: string;
}

export interface EmbeddingResolvedIdentity extends EmbeddingRouteIdentity {
  dimensions: number;
}

export type EmbeddingOperationalState =
  | 'denied'
  | 'unconfigured'
  | 'not-ready'
  | 'ready';

export interface EmbeddingOperationalStatus {
  available: boolean;
  state: EmbeddingOperationalState;
  note?: string;
  indexedCount?: number;
  configured: EmbeddingRouteIdentity;
  resolved?: EmbeddingResolvedIdentity | null;
}

async function readActiveEmbeddingIdentity(config: EmbeddingConfig) {
  try {
    const route = getConfiguredEmbeddingRoute(config);
    const identity = await getActiveEmbeddingIdentity();
    if (
      !identity
      || identity.provider !== route.provider
      || identity.model !== route.model
    ) {
      return null;
    }
    return identity;
  } catch (error) {
    aiLogger.warn({
      featureId: 'semantic-embedding',
      err: error,
    }, 'Embedding operational status could not read the semantic index');
    return null;
  }
}

export async function getEmbeddingOperationalStatus(
  supplied?: AIProviderConfigurationSnapshot,
): Promise<EmbeddingOperationalStatus> {
  const snapshot = supplied ?? await loadAIProviderConfiguration();
  const configuredFallback: EmbeddingRouteIdentity = {
    provider: snapshot.resolved.embeddingProvider ?? snapshot.resolved.provider,
    model: snapshot.resolved.embeddingModel,
  };

  let config: EmbeddingConfig | null;
  try {
    config = getEmbeddingConfigForResolvedAI(
      snapshot.resolved,
      snapshot.routingPolicy,
    );
  } catch (error) {
    if (error instanceof AIRoutingDeniedError) {
      return {
        available: false,
        state: 'denied',
        note: 'The routing policy does not permit this embedding route.',
        configured: configuredFallback,
      };
    }
    throw error;
  }
  if (!config) {
    return {
      available: false,
      state: 'unconfigured',
      note: 'An embedding route endpoint or credential is required.',
      configured: configuredFallback,
    };
  }

  const configured = { provider: config.provider, model: config.model };
  const active = await readActiveEmbeddingIdentity(config);
  if (!active) {
    return {
      available: false,
      state: 'not-ready',
      note: 'A compatible embedding index is not active yet. Save the route and run a rebuild.',
      indexedCount: 0,
      configured,
      resolved: null,
    };
  }

  return {
    available: true,
    state: 'ready',
    indexedCount: active.vectorCount,
    configured,
    resolved: {
      provider: active.provider,
      model: active.model,
      dimensions: active.dimensions,
    },
  };
}

export async function testEmbeddingConnection(
  supplied?: AIProviderConfigurationSnapshot,
) {
  const snapshot = supplied ?? await loadAIProviderConfiguration();
  const config = getEmbeddingConfigForResolvedAI(
    snapshot.resolved,
    snapshot.routingPolicy,
  );
  if (!config) {
    return {
      success: false as const,
      error: 'Embedding route is not configured',
    };
  }
  const startedAt = Date.now();
  const result = await requestEmbeddingWithRetriesForConfig(
    'Mission Control embedding connection test',
    config,
  );
  if (result.status !== 'ok') {
    return {
      success: false as const,
      error: 'Embedding provider did not return a valid vector',
      latencyMs: Date.now() - startedAt,
    };
  }
  return {
    success: true as const,
    latencyMs: Date.now() - startedAt,
    configured: { provider: config.provider, model: config.model },
    resolved: {
      provider: result.provider,
      model: result.model,
      dimensions: result.embedding.length,
      fallbackOccurred: result.fallbackOccurred,
    },
  };
}
