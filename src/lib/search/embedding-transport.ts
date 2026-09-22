import { aiLogger } from '@/lib/logger';
import {
  AIRoutingDeniedError,
  extractBifrostRoutingMetadata,
  resolveAIRouteOutcome,
} from '@/lib/ai/sensitivity-policy';
import type { AIRequestContext } from '@/lib/ai/types';

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

export interface EmbeddingRequestSuccess {
  status: 'ok';
  embedding: number[];
  provider: string;
  model: string;
  fallbackOccurred: boolean;
  correlationId: string;
}

export type EmbeddingRequestFailureStatus =
  | 'denied'
  | 'retryable'
  | 'failed'
  | 'aborted';

export interface EmbeddingRequestFailure {
  status: EmbeddingRequestFailureStatus;
  reason: string;
  retryAfter: string | null;
  httpStatus: number | null;
  cause?: unknown;
}

export type EmbeddingRequestResult = EmbeddingRequestSuccess | EmbeddingRequestFailure;
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 20_000;

function embeddingTimeoutMs(): number {
  const parsed = Number(process.env.MC_EMBEDDING_REQUEST_TIMEOUT_MS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_EMBEDDING_TIMEOUT_MS;
}

export function getConfiguredEmbeddingRoute(config: EmbeddingConfig): EmbeddingRoute {
  const outcome = resolveAIRouteOutcome(
    config.context,
    config.provider,
    config.model,
  );
  return { provider: outcome.provider, model: outcome.model };
}

export function parseRetryAfter(header: string | null, now: number = Date.now()): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
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
 * Production single-attempt embedding transport shared by interactive search
 * and packaged semantic workers.
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
    return {
      status: response.status === 429 || response.status === 408 || response.status >= 500
        ? 'retryable'
        : 'failed',
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

  let outcome: { provider: string; model: string; fallbackOccurred: boolean };
  try {
    outcome = resolveAIRouteOutcome(
      config.context,
      config.provider,
      config.model,
      Object.fromEntries(response.headers.entries()),
      config.provider === 'bifrost' ? extractBifrostRoutingMetadata(payload) : undefined,
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
