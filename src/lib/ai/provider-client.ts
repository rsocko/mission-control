import { createOpenAI } from '@ai-sdk/openai';
import { aiLogger } from '@/lib/logger';
import {
  assertAIProviderCanReceive,
  resolveAIRouteOutcome,
  routeIdForConfiguredProvider,
} from './sensitivity-policy';
import type { AIRequestContext, ResolvedAIConfig } from './types';
import {
  acquireOllamaAdmissionWithTimeout,
  getAIAdmissionConfig,
  type AIAdmission,
} from './admission-controller';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

function buildRoutingHeaders(context: AIRequestContext) {
  return {
    'x-mc-ai-feature-id': context.featureId,
    'x-mc-ai-sensitivity': context.sensitivity,
    'x-mc-ai-allowed-routes': context.allowedRoutes.join(','),
    'x-mc-correlation-id': context.correlationId,
  };
}

function createTrackedFetch(
  context: AIRequestContext,
  configuredProvider: string,
  configuredModel: string,
  sharedAdmission?: AIAdmission,
) {
  let sharedAdmissionUsed = false;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = Date.now();
    const timeoutSignal = configuredProvider === 'ollama'
      ? AbortSignal.timeout(getAIAdmissionConfig().timeoutMs)
      : null;
    const signals = [init?.signal, timeoutSignal].filter(
      (signal): signal is AbortSignal => signal instanceof AbortSignal,
    );
    const signal = signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);
    let admission: AIAdmission | null = sharedAdmission ?? null;
    const ownsAdmission = !sharedAdmission;
    if (configuredProvider === 'ollama' && !admission) {
      admission = await acquireOllamaAdmissionWithTimeout(init?.signal ?? undefined);
    }
    const queueTimeMs = sharedAdmission && sharedAdmissionUsed
      ? 0
      : admission?.queueTimeMs ?? 0;
    sharedAdmissionUsed = true;
    let released = false;
    const finish = (response?: Response) => {
      if (released) return;
      released = true;
      if (ownsAdmission) admission?.release();
      const outcome = response
        ? resolveAIRouteOutcome(
            context,
            configuredProvider,
            configuredModel,
            Object.fromEntries(response.headers.entries()),
          )
        : null;
      aiLogger.info({
        event: 'ai_provider_request_completed',
        featureId: context.featureId,
        sensitivity: context.sensitivity,
        allowedRoutes: context.allowedRoutes,
        correlationId: context.correlationId,
        provider: outcome?.provider ?? configuredProvider,
        model: outcome?.model ?? configuredModel,
        fallbackOccurred: outcome?.fallbackOccurred ?? false,
        status: response?.status,
        queueTimeMs,
        providerTimeMs: Date.now() - startedAt - queueTimeMs,
      }, 'AI provider request completed');
    };

    try {
      const response = await fetch(input, { ...init, signal });
      if (!response.body) {
        finish(response);
        return response;
      }

      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              finish(response);
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            finish(response);
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finish(response);
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      finish();
      throw error;
    }
  };
}

export function createConfiguredAIProvider(
  config: ResolvedAIConfig,
  context?: AIRequestContext,
  admission?: AIAdmission,
) {
  const baseUrl = config.provider === 'ollama'
    ? config.baseUrl || DEFAULT_OLLAMA_BASE_URL
    : config.baseUrl;
  const route = routeIdForConfiguredProvider(
    config.provider,
    baseUrl,
    Boolean(config.apiKey),
    config.model,
  );
  if (context) {
    assertAIProviderCanReceive(context, config.provider, route);
  }
  const requestOptions = context
    ? {
        headers: config.provider === 'bifrost' ? buildRoutingHeaders(context) : undefined,
        fetch: createTrackedFetch(context, config.provider, config.model, admission),
      }
    : {};

  switch (config.provider) {
    case 'azure':
      return createOpenAI({
        apiKey: config.apiKey || '',
        baseURL: baseUrl,
        ...requestOptions,
      });
    case 'ollama':
      return createOpenAI({
        apiKey: 'ollama',
        baseURL: baseUrl,
        ...requestOptions,
      });
    case 'bifrost':
      return createOpenAI({
        name: 'bifrost',
        apiKey: config.apiKey || '',
        baseURL: baseUrl,
        ...requestOptions,
      });
    default:
      return createOpenAI({
        apiKey: config.apiKey || '',
        baseURL: baseUrl,
        ...requestOptions,
      });
  }
}
