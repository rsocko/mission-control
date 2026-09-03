import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import {
  parseSavedAIProviderConfig,
  resolveAIConfig,
} from '@/lib/ai/config-values';
import {
  assertAIProviderCanReceive,
  createAIRequestContext,
  DEFAULT_AI_ROUTING_POLICY,
  routeIdForConfiguredProvider,
  validateAIRoutingPolicy,
} from '@/lib/ai/sensitivity-policy';
import type { AIRoutingPolicyConfig } from '@/lib/ai/types';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import {
  buildEnrichmentPrompt,
  parseAIEnrichmentResult,
  shouldEnrichWithAI,
} from './ai-enrichment';
import type { NotificationEnrichmentExecutor } from './worker';

function routingPolicy(value: unknown): AIRoutingPolicyConfig {
  if (value === null) return DEFAULT_AI_ROUTING_POLICY;
  return validateAIRoutingPolicy(
    typeof value === 'string' ? JSON.parse(value) : value,
  );
}

export async function createPackagedNotificationEnrichmentExecutor(): Promise<
  NotificationEnrichmentExecutor
> {
  const settings = getCorePersistenceRepositories().settings;
  const [saved, savedPolicy] = await Promise.all([
    settings.get('ai_provider_config'),
    settings.get('ai_routing_policy'),
  ]);
  const config = resolveAIConfig(parseSavedAIProviderConfig(saved));
  const policy = routingPolicy(savedPolicy);
  if (!config.configured) {
    throw new Error(
      'PostgreSQL notification enrichment requires a configured AI provider',
    );
  }
  const route = routeIdForConfiguredProvider(
    config.provider,
    config.baseUrl,
    Boolean(config.apiKey),
    config.model,
  );
  const provider = createOpenAI({
    ...(config.provider === 'bifrost' ? { name: 'bifrost' } : {}),
    apiKey: config.provider === 'ollama' ? 'ollama' : config.apiKey || '',
    baseURL: config.baseUrl,
  });

  return async (input, options) => {
    if (!shouldEnrichWithAI(input)) return null;
    const context = createAIRequestContext(
      'notification-enrichment',
      policy,
      {
        sources: [input.connectorType],
        correlationId: randomUUID(),
      },
    );
    assertAIProviderCanReceive(context, config.provider, route);
    const { text } = await generateText({
      model: provider(config.model),
      prompt: buildEnrichmentPrompt(input),
      abortSignal: options.signal,
      headers: config.provider === 'bifrost'
        ? {
            'x-mc-ai-feature-id': context.featureId,
            'x-mc-ai-sensitivity': context.sensitivity,
            'x-mc-ai-allowed-routes': context.allowedRoutes.join(','),
            'x-mc-correlation-id': context.correlationId,
          }
        : undefined,
    });
    return parseAIEnrichmentResult(text);
  };
}
