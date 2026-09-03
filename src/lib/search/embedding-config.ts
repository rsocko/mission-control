import { randomUUID } from 'node:crypto';
import {
  assertAIProviderCanReceive,
  createAIRequestContext,
  routeIdForConfiguredProvider,
} from '@/lib/ai/sensitivity-policy';
import type {
  AIRoutingPolicyConfig,
  ResolvedAIConfig,
  SensitivityClass,
} from '@/lib/ai/types';
import type { EmbeddingConfig } from './embedding-transport';

export function getAzureEmbeddingEndpoint(baseUrl: string, deployment: string): string {
  const normalizedBaseUrl = baseUrl
    .replace(/\/$/, '')
    .replace(/\/openai\/v1$/, '')
    .replace(/\/openai\/deployments\/[^/]+$/, '');
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

  return `${normalizedBaseUrl}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`;
}

export function buildEmbeddingConfig(
  resolved: ResolvedAIConfig,
  policy: AIRoutingPolicyConfig,
  sources: string[] = [],
  options: {
    sensitivityOverride?: SensitivityClass;
    correlationId?: string;
  } = {},
): EmbeddingConfig | null {
  const provider = resolved.embeddingProvider ?? resolved.provider;
  const model = resolved.embeddingModel;
  const baseUrl = resolved.embeddingBaseUrl ?? resolved.baseUrl;
  const apiKey = resolved.embeddingApiKey ?? resolved.apiKey;
  if (!(resolved.embeddingConfigured ?? resolved.configured)) return null;

  const context = createAIRequestContext('semantic-embedding', policy, {
    sources,
    override: options.sensitivityOverride,
    correlationId: options.correlationId ?? randomUUID(),
  });
  const route = routeIdForConfiguredProvider(
    provider,
    baseUrl,
    Boolean(apiKey),
    model,
  );
  assertAIProviderCanReceive(context, provider, route);
  const routingHeaders: Record<string, string> = provider === 'bifrost'
    ? {
        'x-mc-ai-feature-id': context.featureId,
        'x-mc-ai-sensitivity': context.sensitivity,
        'x-mc-ai-allowed-routes': context.allowedRoutes.join(','),
        'x-mc-correlation-id': context.correlationId,
      }
    : {};

  if (provider === 'azure') {
    if (!baseUrl || !apiKey) return null;
    return {
      provider,
      baseUrl,
      apiKey,
      model,
      endpoint: getAzureEmbeddingEndpoint(baseUrl, model),
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        ...routingHeaders,
      },
      context,
    };
  }

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    endpoint: baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/embeddings`
      : 'https://api.openai.com/v1/embeddings',
    headers: {
      'Content-Type': 'application/json',
      ...routingHeaders,
      ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
    },
    context,
  };
}
