import type { AIAdmission } from './admission-controller';
import { loadAIProviderConfiguration } from './provider-configuration-service';
import { createConfiguredAIProvider } from './provider-client';
import {
  createConfiguredAIRequestContext,
  getConfiguredAIRouteOutcome,
} from './provider-routing-core';
import type {
  AIFeatureId,
  AIRequestContext,
  ResolvedAIConfig,
  SensitivityClass,
} from './types';
import type { BifrostRoutingMetadata } from './sensitivity-policy';

interface AsyncAIModelRoute {
  model: ReturnType<ReturnType<typeof createConfiguredAIProvider>>;
  context: AIRequestContext;
  configured: Pick<ResolvedAIConfig, 'provider' | 'model'>;
}

export async function getAsyncAIModel(
  featureId: AIFeatureId,
  options: {
    sources?: string[];
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
    admission?: AIAdmission;
  } = {},
): Promise<AsyncAIModelRoute> {
  const { resolved, routingPolicy } = await loadAIProviderConfiguration();
  const context = createConfiguredAIRequestContext(
    routingPolicy,
    featureId,
    options,
  );
  const provider = createConfiguredAIProvider(
    resolved,
    context,
    options.admission,
  );
  return {
    model: provider(resolved.model),
    context,
    configured: {
      provider: resolved.provider,
      model: resolved.model,
    },
  };
}

export function getAsyncAIRouteOutcome(
  route: Pick<AsyncAIModelRoute, 'context' | 'configured'>,
  response: { modelId: string; headers?: Record<string, string> },
  metadata?: BifrostRoutingMetadata,
) {
  return getConfiguredAIRouteOutcome(
    route.context,
    response,
    route.configured,
    metadata,
  );
}

export async function getAsyncAIProviderConfiguration(): Promise<ResolvedAIConfig> {
  return (await loadAIProviderConfiguration()).resolved;
}
