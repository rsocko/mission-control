import { randomUUID } from 'node:crypto';
import { requestContext } from '@/lib/logger';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';
import {
  assertAIProviderCanReceive,
  createAIRequestContext,
  parseBifrostModelId,
  resolveAIRouteOutcome,
  routeIdForConfiguredProvider,
} from './sensitivity-policy';
import type { BifrostRoutingMetadata } from './sensitivity-policy';
import type {
  AIFeatureId,
  AIRequestContext,
  AIRoutingPolicyConfig,
  ResolvedAIConfig,
  SensitivityClass,
} from './types';

interface AIConfigInvalidationEpoch {
  epoch: number;
}

const AI_CONFIG_INVALIDATION_EPOCH_KEY = 'mission-control.ai-config-invalidation-epoch';
const AI_CONFIG_INVALIDATION_EPOCH_SCHEMA_VERSION = 1;

function invalidationEpoch(): AIConfigInvalidationEpoch {
  return getProcessRuntimeSlot(
    AI_CONFIG_INVALIDATION_EPOCH_KEY,
    AI_CONFIG_INVALIDATION_EPOCH_SCHEMA_VERSION,
    () => ({ epoch: 0 }),
  );
}

export function getAIConfigInvalidationEpoch(): number {
  return invalidationEpoch().epoch;
}

export function advanceAIConfigInvalidationEpoch(): number {
  const state = invalidationEpoch();
  state.epoch += 1;
  return state.epoch;
}

function buildRoutingHeaders(context: AIRequestContext) {
  return {
    'x-mc-ai-feature-id': context.featureId,
    'x-mc-ai-sensitivity': context.sensitivity,
    'x-mc-ai-allowed-routes': context.allowedRoutes.join(','),
    'x-mc-correlation-id': context.correlationId,
  };
}

export function createConfiguredAIRequestContext(
  policy: AIRoutingPolicyConfig,
  featureId: AIFeatureId,
  options: {
    sources?: string[];
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
  } = {},
): AIRequestContext {
  return createAIRequestContext(featureId, policy, {
    sources: options.sources,
    override: options.sensitivityOverride,
    correlationId: options.correlationId
      ?? requestContext.getStore()?.traceId
      ?? randomUUID(),
  });
}

export function getConfiguredAIRoutingHeaders(
  context: AIRequestContext,
  provider: string,
  baseUrl?: string,
  hasCredentials = false,
  model?: string,
): Record<string, string> {
  const route = routeIdForConfiguredProvider(provider, baseUrl, hasCredentials, model);
  assertAIProviderCanReceive(context, provider, route);
  return provider === 'bifrost' ? buildRoutingHeaders(context) : {};
}

export function getConfiguredAIRouteOutcome(
  context: AIRequestContext,
  response: { modelId: string; headers?: Record<string, string> },
  configured: Pick<ResolvedAIConfig, 'provider' | 'model'>,
  metadata?: BifrostRoutingMetadata,
) {
  const model = configured.provider === 'bifrost' && !response.modelId.includes('/')
    ? configured.model
    : response.modelId;
  return resolveAIRouteOutcome(
    context,
    configured.provider,
    model,
    response.headers,
    metadata,
  );
}

export function getConfiguredProviderInfo(config: ResolvedAIConfig) {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl || 'default',
    configured: config.configured,
  };
}

export function getConfiguredProviderOperationalStatus(
  resolved: ResolvedAIConfig,
  routingPolicy: AIRoutingPolicyConfig,
) {
  const bifrostRoute = resolved.provider === 'bifrost'
    ? parseBifrostModelId(resolved.model)?.route
    : undefined;
  const embeddingRoute = resolved.embeddingProvider === 'bifrost'
    ? parseBifrostModelId(resolved.embeddingModel)?.route
    : resolved.embeddingProvider === 'azure'
      ? 'azure-private'
      : resolved.embeddingProvider === 'ollama'
        ? 'ollama'
        : resolved.embeddingProvider === 'openai'
          ? 'openai'
          : undefined;
  const routeNames = new Set(
    Object.values(routingPolicy.policies).flatMap((policy) => policy.allowedRoutes),
  );

  return {
    providerHealth: [...routeNames].map((route) => ({
      route,
      status: (
        (
          route === resolved.provider
          || (resolved.provider === 'azure' && route === 'azure-private')
          || route === bifrostRoute
        ) && resolved.configured
      ) || (route === embeddingRoute && resolved.embeddingConfigured)
        ? 'configured'
        : route === resolved.provider
          || (resolved.provider === 'azure' && route === 'azure-private')
          || route === bifrostRoute
          || route === embeddingRoute
          ? 'unavailable'
          : 'unknown',
    })),
    entitlement: {
      status: resolved.provider === 'bifrost' ? 'managed' : 'not-applicable',
      detail: resolved.provider === 'bifrost'
        ? 'Managed by Bifrost; credentials and account identifiers are redacted.'
        : 'No gateway entitlement is used by the active provider.',
    },
    quota: {
      status: resolved.provider === 'bifrost' ? 'unknown' : 'not-reported',
      detail: resolved.provider === 'bifrost'
        ? 'Bifrost has not reported quota state.'
        : 'The active provider does not expose quota through Mission Control.',
    },
  };
}
