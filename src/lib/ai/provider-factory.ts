import {
  getConfiguredAIRouteOutcome,
  getConfiguredAIRoutingHeaders,
} from './provider-routing-core';
import { createConfiguredAIProvider } from './provider-client';
import {
  getAsyncAIModel,
  getAsyncAIProviderConfiguration,
} from './provider-runtime';
import type { BifrostRoutingMetadata } from './sensitivity-policy';
import type {
  AIFeatureId,
  AIRequestContext,
  ResolvedAIConfig,
  SensitivityClass,
} from './types';
import type { AIAdmission } from './admission-controller';

export { AIRoutingDeniedError, resolveAIRouteOutcome } from './sensitivity-policy';

type LegacyAIModelRoute = Awaited<ReturnType<typeof getAsyncAIModel>>;

export function getAIRequestContext(
  featureId: AIFeatureId,
  options: {
    sources?: string[];
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
  } = {},
): AIRequestContext {
  throw new Error(
    `Synchronous AI model resolution is unavailable for ${featureId}; `
    + `use getAsyncAIModel (${Object.keys(options).length} options supplied)`,
  );
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
  if (!configured) {
    throw new Error('Configured AI route is required for synchronous outcome resolution');
  }
  return getConfiguredAIRouteOutcome(
    context,
    response,
    configured,
    metadata,
  );
}

export function getAIProvider(
  context?: AIRequestContext,
  admission?: AIAdmission,
): ReturnType<typeof createConfiguredAIProvider> {
  throw new Error(
    'Synchronous AI provider resolution is unavailable; use getAsyncAIModel'
    + ` (context=${Boolean(context)}, admission=${Boolean(admission)})`,
  );
}

export function getModelId(): string {
  throw new Error('Synchronous AI configuration access is unavailable');
}

export function getProviderInfo(): Pick<
  ResolvedAIConfig,
  'provider' | 'model' | 'configured'
> & { baseUrl: string } {
  throw new Error('Synchronous AI configuration access is unavailable');
}

export function getAIModel(
  featureId: AIFeatureId,
  options: {
    sources?: string[];
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
    admission?: AIAdmission;
  } = {},
): LegacyAIModelRoute {
  throw new Error(
    `Synchronous AI model resolution is unavailable for ${featureId}; `
    + `use getAsyncAIModel (${Object.keys(options).length} options supplied)`,
  );
}

export { getAsyncAIModel, getAsyncAIProviderConfiguration };
