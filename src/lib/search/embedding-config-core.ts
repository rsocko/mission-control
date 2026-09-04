import {
  createConfiguredAIRequestContext,
  getConfiguredAIRoutingHeaders,
} from '@/lib/ai/provider-routing-core';
import type {
  AIRoutingPolicyConfig,
  ResolvedAIConfig,
  SensitivityClass,
} from '@/lib/ai/types';
import {
  requestEmbeddingResult,
  type EmbeddingConfig,
  type EmbeddingRequestResult,
} from './embedding-transport';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getAzureEmbeddingEndpoint(baseUrl: string, deployment: string): string {
  const normalizedBaseUrl = baseUrl
    .replace(/\/$/, '')
    .replace(/\/openai\/v1$/, '')
    .replace(/\/openai\/deployments\/[^/]+$/, '');
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';
  return `${normalizedBaseUrl}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`;
}

export function getEmbeddingConfigForResolvedAI(
  resolved: ResolvedAIConfig,
  routingPolicy: AIRoutingPolicyConfig,
  sources: string[] = [],
  options: { sensitivityOverride?: SensitivityClass } = {},
): EmbeddingConfig | null {
  const provider = resolved.embeddingProvider ?? resolved.provider;
  const model = resolved.embeddingModel;
  const baseUrl = resolved.embeddingBaseUrl ?? resolved.baseUrl;
  const apiKey = resolved.embeddingApiKey ?? resolved.apiKey;
  if (!(resolved.embeddingConfigured ?? resolved.configured)) return null;

  const context = createConfiguredAIRequestContext(
    routingPolicy,
    'semantic-embedding',
    options.sensitivityOverride
      ? { sources, sensitivityOverride: options.sensitivityOverride }
      : { sources },
  );
  const routingHeaders = getConfiguredAIRoutingHeaders(
    context,
    provider,
    baseUrl,
    Boolean(apiKey),
    model,
  );

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
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    context,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function requestEmbeddingWithRetriesForConfig(
  text: string,
  config: EmbeddingConfig,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
  } = {},
): Promise<EmbeddingRequestResult> {
  const configuredRetries = nonNegativeInteger(
    process.env.MC_EMBEDDING_REQUEST_MAX_RETRIES,
    2,
  );
  const maxRetries = Math.min(
    Math.max(Math.trunc(options.maxRetries ?? configuredRetries), 0),
    5,
  );
  const baseDelayMs = positiveInteger(process.env.MC_EMBEDDING_REQUEST_RETRY_BASE_MS, 100);
  const maxDelayMs = positiveInteger(process.env.MC_EMBEDDING_REQUEST_RETRY_MAX_MS, 2_000);

  let last: EmbeddingRequestResult | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await requestEmbeddingResult(text, config, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      attempt,
    });
    if (last.status !== 'retryable' || attempt === maxRetries) return last;
    const hinted = last.retryAfter ? Date.parse(last.retryAfter) - Date.now() : Number.NaN;
    const delayMs = Number.isFinite(hinted) ? hinted : baseDelayMs * (2 ** attempt);
    if (delayMs > maxDelayMs) return last;
    await sleep(Math.max(0, delayMs));
  }
  return last!;
}
