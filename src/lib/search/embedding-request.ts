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

import { loadAIProviderConfiguration } from '@/lib/ai/provider-configuration-service';
import type { SensitivityClass } from '@/lib/ai/types';
import {
  requestEmbeddingResult,
  type EmbeddingConfig,
  type EmbeddingRequestResult,
} from './embedding-transport';
import { getEmbeddingConfigForResolvedAI } from './embedding-config-core';
export {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  getConfiguredEmbeddingRoute,
  parseRetryAfter,
  requestEmbeddingResult,
  type EmbeddingConfig,
  type EmbeddingRequestFailure,
  type EmbeddingRequestFailureStatus,
  type EmbeddingRequestResult,
  type EmbeddingRequestSuccess,
  type EmbeddingRoute,
} from './embedding-transport';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
  const { resolved, routingPolicy } = await loadAIProviderConfiguration();
  return getEmbeddingConfigForResolvedAI(resolved, routingPolicy, sources, options);
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
