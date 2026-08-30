/**
 * The embedding execution seam for the durable semantic index.
 *
 * This module owns exactly one responsibility: turn projected text into a
 * validated vector, or an honest, classified refusal. It performs **no**
 * routing or credential logic of its own — that lives in
 * `src/lib/search/embedding-request.ts`, which the keyword/semantic search path
 * uses too, so there is a single implementation of the security-relevant code.
 *
 * Two guarantees this seam adds on top of that shared path:
 *
 * 1. **Sensitivity is enforced before egress.** The request context is built at
 *    a tier at least as restrictive as the document's own tier, and a
 *    `local-only` document is refused unless the configured provider resolves
 *    to the local route — checked before the request is issued and again
 *    against the route the response actually came from.
 * 2. **Vector-space integrity.** The caller declares the identity's
 *    provider/model/dimensions; a response from a different route, or with the
 *    wrong dimension count, is a terminal failure rather than a retry, because
 *    retrying cannot make a foreign vector belong to this space.
 */

import { AIRoutingDeniedError } from '@/lib/ai/provider-factory';
import { routeIdForProvider } from '@/lib/ai/sensitivity-policy';
import {
  getConfiguredEmbeddingRoute,
  getEmbeddingConfig,
  requestEmbeddingResult,
  type EmbeddingConfig,
} from '@/lib/search/embedding-request';
import { semanticSensitivityRank, type SemanticSensitivity } from './contracts';

export interface SemanticEmbeddingRoute {
  provider: string;
  model: string;
}

export type SemanticEmbeddingFailureStatus =
  /** No embedding provider is configured; there is nothing to retry against. */
  | 'unconfigured'
  /** Policy refusal — terminal. */
  | 'denied'
  /** Transient; retry, honouring `retryAfter` when the provider supplied one. */
  | 'retryable'
  /** Deterministic refusal: malformed, wrong dimensions, or a foreign route. */
  | 'failed'
  /** The caller's abort signal fired; no attempt should be consumed. */
  | 'aborted';

export interface SemanticEmbeddingSuccess {
  status: 'ok';
  embedding: Float32Array;
  provider: string;
  model: string;
  dimensions: number;
}

export interface SemanticEmbeddingFailure {
  status: SemanticEmbeddingFailureStatus;
  /** Short, non-sensitive code. Safe to persist on an intent row. */
  reason: string;
  retryAfter: string | null;
}

export type SemanticEmbeddingOutcome = SemanticEmbeddingSuccess | SemanticEmbeddingFailure;

export interface SemanticEmbeddingRequest {
  text: string;
  /** The document's own tier. The request runs at least this restrictively. */
  sensitivity: SemanticSensitivity;
  /** Routing "sources" — connector kinds — used for policy resolution. */
  sources?: string[];
  /**
   * The identity's vector space. When supplied, a response resolved to a
   * different provider/model, or with a different dimension count, is a
   * terminal `failed` outcome.
   */
  expect?: SemanticEmbeddingRoute & { dimensions: number };
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type SemanticRouteResolution =
  | { status: 'ok'; route: SemanticEmbeddingRoute }
  | { status: 'unconfigured' | 'denied'; reason: string };

export interface SemanticEmbeddingProvider {
  /**
   * The provider/model the current configuration resolves to, without issuing
   * a request. Used to name a new index identity before any vector exists.
   */
  resolveRoute(
    sensitivity: SemanticSensitivity,
    sources?: string[],
  ): Promise<SemanticRouteResolution>;
  embed(request: SemanticEmbeddingRequest): Promise<SemanticEmbeddingOutcome>;
}

const LOCAL_ROUTE_ID = 'ollama';

function deniedOutcome(reason: string): SemanticEmbeddingFailure {
  return { status: 'denied', reason, retryAfter: null };
}

/**
 * Builds a config whose request context is at least as restrictive as
 * `sensitivity`.
 *
 * The policy-derived base tier already accounts for the connector sources; when
 * the stored document is *more* restrictive than the current policy would be
 * (an older document under a since-relaxed policy, for instance), the stricter
 * stored tier wins. `sensitivityOverride` refuses to relax, so this can only
 * ever tighten.
 */
async function resolveConfig(
  sensitivity: SemanticSensitivity,
  sources: string[],
): Promise<EmbeddingConfig | null> {
  const base = await getEmbeddingConfig(sources);
  if (!base) return null;
  if (semanticSensitivityRank(sensitivity) >= semanticSensitivityRank(base.context.sensitivity)) {
    return base;
  }
  return getEmbeddingConfig(sources, { sensitivityOverride: sensitivity });
}

/**
 * A `local-only` document must never leave the machine. The routing policy is
 * the primary gate; this is an independent second check so a mis-edited policy
 * cannot turn local-only content into egress.
 */
function violatesLocalOnly(sensitivity: SemanticSensitivity, provider: string): boolean {
  return sensitivity === 'local-only' && routeIdForProvider(provider) !== LOCAL_ROUTE_ID;
}

export class AIEmbeddingProvider implements SemanticEmbeddingProvider {
  async resolveRoute(
    sensitivity: SemanticSensitivity,
    sources: string[] = [],
  ): Promise<SemanticRouteResolution> {
    let config: EmbeddingConfig | null;
    try {
      config = await resolveConfig(sensitivity, sources);
    } catch (error) {
      if (error instanceof AIRoutingDeniedError) {
        return { status: 'denied', reason: 'routing-denied' };
      }
      throw error;
    }
    if (!config) return { status: 'unconfigured', reason: 'provider-unconfigured' };

    let route: SemanticEmbeddingRoute;
    try {
      route = getConfiguredEmbeddingRoute(config);
    } catch (error) {
      if (error instanceof AIRoutingDeniedError) {
        return { status: 'denied', reason: 'routing-denied' };
      }
      throw error;
    }
    if (violatesLocalOnly(sensitivity, route.provider)) {
      return { status: 'denied', reason: 'local-only-egress-blocked' };
    }
    return { status: 'ok', route };
  }

  async embed(request: SemanticEmbeddingRequest): Promise<SemanticEmbeddingOutcome> {
    const text = request.text.trim();
    if (!text) {
      return { status: 'failed', reason: 'empty-text', retryAfter: null };
    }
    if (request.signal?.aborted) {
      return { status: 'aborted', reason: 'aborted', retryAfter: null };
    }

    let config: EmbeddingConfig | null;
    try {
      config = await resolveConfig(request.sensitivity, request.sources ?? []);
    } catch (error) {
      if (error instanceof AIRoutingDeniedError) return deniedOutcome('routing-denied');
      throw error;
    }
    if (!config) {
      return { status: 'unconfigured', reason: 'provider-unconfigured', retryAfter: null };
    }

    // Pre-egress local-only gate: resolve the route the request *would* take
    // and refuse before a byte leaves the process.
    let configuredRoute: SemanticEmbeddingRoute;
    try {
      configuredRoute = getConfiguredEmbeddingRoute(config);
    } catch (error) {
      if (error instanceof AIRoutingDeniedError) return deniedOutcome('routing-denied');
      throw error;
    }
    if (violatesLocalOnly(request.sensitivity, configuredRoute.provider)) {
      return deniedOutcome('local-only-egress-blocked');
    }

    const result = await requestEmbeddingResult(text, config, {
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    });

    if (result.status !== 'ok') {
      return {
        status: result.status,
        reason: result.reason,
        retryAfter: result.retryAfter,
      };
    }

    // Post-response gate: the route that actually answered must still satisfy
    // the document's tier.
    if (violatesLocalOnly(request.sensitivity, result.provider)) {
      return deniedOutcome('local-only-egress-blocked');
    }

    const embedding = new Float32Array(result.embedding.length);
    for (let index = 0; index < result.embedding.length; index++) {
      const value = result.embedding[index];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { status: 'failed', reason: 'non-finite-embedding', retryAfter: null };
      }
      embedding[index] = value;
    }

    if (request.expect) {
      if (
        result.provider !== request.expect.provider
        || result.model !== request.expect.model
      ) {
        // Mixed routes in one vector space is a correctness bug, not a blip:
        // the fix is a new index identity, so retrying is pointless.
        return { status: 'failed', reason: 'route-mismatch', retryAfter: null };
      }
      if (embedding.length !== request.expect.dimensions) {
        return { status: 'failed', reason: 'dimension-mismatch', retryAfter: null };
      }
    }

    return {
      status: 'ok',
      embedding,
      provider: result.provider,
      model: result.model,
      dimensions: embedding.length,
    };
  }
}

let defaultProvider: SemanticEmbeddingProvider | null = null;

export function getSemanticEmbeddingProvider(): SemanticEmbeddingProvider {
  if (!defaultProvider) defaultProvider = new AIEmbeddingProvider();
  return defaultProvider;
}
