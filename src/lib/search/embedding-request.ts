/**
 * The embedding provider request path, extracted so that both the interactive
 * search surface (`src/lib/search/semantic.ts`) and the durable semantic index
 * worker use **one** implementation of endpoint resolution, routing headers,
 * sensitivity enforcement, and response route verification.
 *
 * Nothing here is index-aware and nothing here touches a database beyond the
 * existing AI config resolver.
 *
 * Two properties this module is responsible for:
 *
 * 1. **The embedding route is independent of the completion route.** Every
 *    field is read from the `embedding*` side of the resolved AI config, with
 *    the shared/completion field only as a legacy fallback for configurations
 *    (and tests) written before the routes were split.
 * 2. **The resolved route comes from the response, not the request.** A Bifrost
 *    deployment may answer from a different provider/model than the one it was
 *    asked for; the routing metadata in the response body and headers is what
 *    names the vector space, so callers never record the proxy route.
 *
 * Failures are *classified* rather than collapsed to `null`, because a durable
 * queue has to distinguish "retry later", "retry after this instant", and
 * "never retry". `requestEmbeddingWithRetries` layers the bounded interactive
 * retry loop on top of that same single-attempt primitive, so there is still
 * only one request implementation.
 */

import {
  getAIRequestContext,
  getAIRouteOutcome,
  getAIRoutingHeaders,
  AIRoutingDeniedError,
} from '@/lib/ai/provider-factory';
import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import { extractBifrostRoutingMetadata } from '@/lib/ai/sensitivity-policy';
import type { AIRequestContext, SensitivityClass } from '@/lib/ai/types';
import { aiLogger } from '@/lib/logger';

export interface EmbeddingConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  context: AIRequestContext;
}

export interface EmbeddingRoute {
  provider: string;
  model: string;
}

export const DEFAULT_EMBEDDING_TIMEOUT_MS = 20_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Request timeout for a single attempt. */
function embeddingTimeoutMs(): number {
  return positiveInteger(
    process.env.MC_EMBEDDING_REQUEST_TIMEOUT_MS,
    DEFAULT_EMBEDDING_TIMEOUT_MS,
  );
}

/** Retries *after* the first attempt, hard-capped so a request cannot hang. */
function embeddingMaxRetries(): number {
  return Math.min(nonNegativeInteger(process.env.MC_EMBEDDING_REQUEST_MAX_RETRIES, 2), 5);
}

function embeddingRetryBaseMs(): number {
  return positiveInteger(process.env.MC_EMBEDDING_REQUEST_RETRY_BASE_MS, 100);
}

/**
 * The longest an interactive caller will ever wait between attempts. A provider
 * `Retry-After` beyond this is respected by *giving up*, not by parking the
 * request: durable work reschedules itself, interactive work must return.
 */
function embeddingRetryMaxDelayMs(): number {
  return positiveInteger(process.env.MC_EMBEDDING_REQUEST_RETRY_MAX_MS, 2_000);
}

export function getAzureEmbeddingEndpoint(baseUrl: string, deployment: string): string {
  const normalizedBaseUrl = baseUrl
    .replace(/\/$/, '')
    .replace(/\/openai\/v1$/, '')
    .replace(/\/openai\/deployments\/[^/]+$/, '');
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

  return `${normalizedBaseUrl}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`;
}

/**
 * Resolves the embedding endpoint, credentials, and routing headers for the
 * configured **embedding** provider.
 *
 * Provider, base URL, credential, and configured-ness are all read from the
 * embedding-specific fields; the completion fields are only consulted as a
 * fallback so a legacy single-route configuration keeps working.
 *
 * `getAIRoutingHeaders` asserts the configured provider is allowed to receive
 * this request's sensitivity class, so a denied route throws
 * `AIRoutingDeniedError` **before** any endpoint or credential is assembled —
 * that assertion is the pre-egress gate, and it must not be bypassed.
 *
 * Returns `null` when no embedding provider is configured.
 */
export async function getEmbeddingConfig(
  sources: string[] = [],
  options: { sensitivityOverride?: SensitivityClass } = {},
): Promise<EmbeddingConfig | null> {
  const resolved = getResolvedAIConfig();
  const provider = resolved.embeddingProvider ?? resolved.provider;
  const model = resolved.embeddingModel;
  const baseUrl = resolved.embeddingBaseUrl ?? resolved.baseUrl;
  const apiKey = resolved.embeddingApiKey ?? resolved.apiKey;
  if (!(resolved.embeddingConfigured ?? resolved.configured)) {
    return null;
  }

  const context = getAIRequestContext(
    'semantic-embedding',
    options.sensitivityOverride
      ? { sources, sensitivityOverride: options.sensitivityOverride }
      : { sources },
  );
  const routingHeaders = getAIRoutingHeaders(
    context,
    provider,
    baseUrl,
    Boolean(apiKey),
    model,
  );

  if (provider === 'azure') {
    if (!baseUrl || !apiKey) {
      return null;
    }

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

/**
 * The provider/model this configuration would resolve to without egress.
 *
 * The configured **embedding** identity is passed explicitly so the outcome is
 * never resolved against the completion provider/model.
 */
export function getConfiguredEmbeddingRoute(config: EmbeddingConfig): EmbeddingRoute {
  const outcome = getAIRouteOutcome(
    config.context,
    { modelId: config.model },
    undefined,
    { provider: config.provider, model: config.model },
  );
  return {
    provider: outcome.provider,
    model: outcome.model,
  };
}

export interface EmbeddingRequestSuccess {
  status: 'ok';
  embedding: number[];
  /** The provider that actually answered, per response routing metadata. */
  provider: string;
  /** The model that actually answered, per response routing metadata. */
  model: string;
  /** True when the resolved route differs from the configured one. */
  fallbackOccurred: boolean;
  correlationId: string;
}

export type EmbeddingRequestFailureStatus =
  /** Policy refusal. Terminal: retrying cannot make the route allowed. */
  | 'denied'
  /** Provider is busy/unavailable, or the network blipped. Safe to retry. */
  | 'retryable'
  /** Malformed or unusable response. Retrying the same input will not help. */
  | 'failed'
  /** The caller's `AbortSignal` fired; no attempt was consumed. */
  | 'aborted';

export interface EmbeddingRequestFailure {
  status: EmbeddingRequestFailureStatus;
  /** Short, non-sensitive reason code suitable for logs and durable rows. */
  reason: string;
  /** Provider-supplied `Retry-After`, normalized to an ISO instant. */
  retryAfter: string | null;
  httpStatus: number | null;
  cause?: unknown;
}

export type EmbeddingRequestResult = EmbeddingRequestSuccess | EmbeddingRequestFailure;

/**
 * Parses an HTTP `Retry-After` header (delta-seconds or HTTP-date) into an ISO
 * instant. Returns `null` for absent or nonsensical values so the caller falls
 * back to its own backoff instead of trusting a bad hint.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // A day is already far beyond any useful queue delay; treat larger hints as
    // hostile rather than parking work for a week.
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) return null;
    return new Date(now + seconds * 1_000).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= now) return new Date(now).toISOString();
  if (parsed - now > 86_400_000) return null;
  return new Date(parsed).toISOString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeoutSignal]) : timeoutSignal;
}

/**
 * Performs one embedding request and classifies the outcome.
 *
 * Classification rules:
 * - `AIRoutingDeniedError` (pre-request assertion or post-response route
 *   verification) -> `denied`;
 * - HTTP 429/503 -> `retryable`, honouring `Retry-After`;
 * - other HTTP 5xx and 408 -> `retryable`;
 * - other non-2xx -> `failed`;
 * - a caller abort -> `aborted`; a request timeout -> `retryable`;
 * - any other network/transport error -> `retryable`;
 * - a response without a usable numeric embedding -> `failed`.
 *
 * Request and response bodies are never logged, and neither are credentials.
 */
export async function requestEmbeddingResult(
  text: string,
  config: EmbeddingConfig,
  options: { signal?: AbortSignal; timeoutMs?: number; attempt?: number } = {},
): Promise<EmbeddingRequestResult> {
  const timeoutMs = options.timeoutMs ?? embeddingTimeoutMs();
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify(
        config.provider === 'azure'
          ? { input: text }
          : { model: config.model, input: text },
      ),
      signal: combineSignals(options.signal, timeoutMs),
    });
  } catch (error) {
    if (error instanceof AIRoutingDeniedError) {
      return { status: 'denied', reason: 'routing-denied', retryAfter: null, httpStatus: null, cause: error };
    }
    if (options.signal?.aborted) {
      return { status: 'aborted', reason: 'aborted', retryAfter: null, httpStatus: null, cause: error };
    }
    aiLogger.warn({
      featureId: config.context.featureId,
      sensitivity: config.context.sensitivity,
      correlationId: config.context.correlationId,
      attempt: options.attempt,
      err: error,
    }, 'AI embedding request failed');
    return {
      status: 'retryable',
      reason: isAbortError(error) ? 'timeout' : 'network-error',
      retryAfter: null,
      httpStatus: null,
      cause: error,
    };
  }

  if (!response.ok) {
    aiLogger.warn({
      featureId: config.context.featureId,
      sensitivity: config.context.sensitivity,
      correlationId: config.context.correlationId,
      status: response.status,
      attempt: options.attempt,
    }, 'AI embedding request failed');
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const retryable = response.status === 429
      || response.status === 408
      || response.status >= 500;
    return {
      status: retryable ? 'retryable' : 'failed',
      reason: `http-${response.status}`,
      retryAfter,
      httpStatus: response.status,
    };
  }

  let payload: { data?: Array<{ embedding?: number[] }>; extra_fields?: unknown };
  try {
    payload = await response.json() as {
      data?: Array<{ embedding?: number[] }>;
      extra_fields?: unknown;
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: 'malformed-response',
      retryAfter: null,
      httpStatus: response.status,
      cause: error,
    };
  }

  // The resolved route is read from the response: Bifrost reports the provider
  // and model it actually used in the body, and any route header is honoured
  // too, so a fallback is never mistaken for the configured route.
  let outcome: { provider: string; model: string; fallbackOccurred: boolean };
  try {
    outcome = getAIRouteOutcome(
      config.context,
      {
        modelId: config.model,
        headers: Object.fromEntries(response.headers.entries()),
      },
      config.provider === 'bifrost' ? extractBifrostRoutingMetadata(payload) : undefined,
      { provider: config.provider, model: config.model },
    );
  } catch (error) {
    if (error instanceof AIRoutingDeniedError) {
      return {
        status: 'denied',
        reason: 'response-route-denied',
        retryAfter: null,
        httpStatus: response.status,
        cause: error,
      };
    }
    throw error;
  }

  const embedding = payload.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
    return {
      status: 'failed',
      reason: 'empty-embedding',
      retryAfter: null,
      httpStatus: response.status,
    };
  }

  aiLogger.info({
    featureId: config.context.featureId,
    sensitivity: config.context.sensitivity,
    allowedRoutes: config.context.allowedRoutes,
    correlationId: config.context.correlationId,
    provider: outcome.provider,
    model: outcome.model,
    dimensions: embedding.length,
    fallbackOccurred: outcome.fallbackOccurred,
    status: response.status,
  }, 'AI embedding request completed');

  return {
    status: 'ok',
    embedding,
    provider: outcome.provider,
    model: outcome.model,
    fallbackOccurred: outcome.fallbackOccurred,
    correlationId: config.context.correlationId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The bounded retry loop for interactive callers.
 *
 * The durable worker deliberately does **not** use this: it retries through the
 * intent queue, where a delay costs nothing. An interactive request instead gets
 * a small, hard-capped number of attempts, and abandons a `Retry-After` hint
 * that would exceed the interactive wait budget rather than blocking on it.
 *
 * Only transient outcomes are retried; `denied`, `failed`, and `aborted` are
 * returned immediately, because repeating them cannot change the answer.
 */
export async function requestEmbeddingWithRetries(
  text: string,
  config: EmbeddingConfig,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
  } = {},
): Promise<EmbeddingRequestResult> {
  const maxRetries = Math.min(
    Math.max(Math.trunc(options.maxRetries ?? embeddingMaxRetries()), 0),
    5,
  );
  const baseDelayMs = embeddingRetryBaseMs();
  const maxDelayMs = embeddingRetryMaxDelayMs();

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
