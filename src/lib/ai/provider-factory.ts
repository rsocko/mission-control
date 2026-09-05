import { getAIRoutingPolicy, getResolvedAIConfig } from './config-resolver';
import { createConfiguredAIProvider } from './provider-client';
import {
  createConfiguredAIRequestContext,
  getConfiguredAIRouteOutcome,
  getConfiguredAIRoutingHeaders,
} from './provider-routing-core';
import type { BifrostRoutingMetadata } from './sensitivity-policy';
import type {
  AIFeatureId,
  AIRequestContext,
  SensitivityClass,
} from './types';
import type { AIAdmission } from './admission-controller';

export { AIRoutingDeniedError, resolveAIRouteOutcome } from './sensitivity-policy';

export function getAIRequestContext(
  featureId: AIFeatureId,
  options: {
    sources?: string[];
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
  } = {},
) {
  return createConfiguredAIRequestContext(getAIRoutingPolicy(), featureId, options);
}

export function getAIRoutingHeaders(
  context: AIRequestContext,
  provider: string,
  baseUrl?: string,
  hasCredentials = false,
  model?: string,
) {
  return getConfiguredAIRoutingHeaders(
    context,
    provider,
    baseUrl,
    hasCredentials,
    model,
  );
}

export function getAIRouteOutcome(
  context: AIRequestContext,
  response: { modelId: string; headers?: Record<string, string> },
  metadata?: BifrostRoutingMetadata,
  configured?: { provider: string; model: string },
) {
  const config = getResolvedAIConfig();
  return getConfiguredAIRouteOutcome(
    context,
    response,
    configured ?? config,
    metadata,
  );
}

export function getAIProvider(context?: AIRequestContext, admission?: AIAdmission) {
  const config = getResolvedAIConfig();
  return createConfiguredAIProvider(config, context, admission);
}

export function getModelId(): string {
  return getResolvedAIConfig().model;
}

export function getProviderInfo() {
  const config = getResolvedAIConfig();

  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl || 'default',
    configured: config.configured,
  };
}

export function getAIModel(
  featureId: AIFeatureId,
  options: {
    sources?: string[];
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
    admission?: AIAdmission;
  } = {},
) {
  const config = getResolvedAIConfig();
  const context = getAIRequestContext(featureId, options);
  const provider = getAIProvider(context, options.admission);
  return {
    model: provider(config.model),
    context,
  };
}
