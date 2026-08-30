/**
 * Semantic retrieval over the durable, versioned semantic index (issue #1664),
 * plus the operational surface for the embedding route itself (issue #1661).
 *
 * The retrieval half of this module is a **reader**. It owns no storage, creates
 * no tables, runs no triggers, and never rebuilds a corpus: documents and
 * vectors are produced by the index worker from durable intents, and everything
 * goes through the `SemanticIndexRepository` seam so SQLite and PostgreSQL
 * behave identically.
 *
 * Three rules the retrieval path holds itself to:
 *
 * 1. **One vector space per query.** A query embedding is only ever compared
 *    against the repository's declared *active* identity, and only after the
 *    resolved route and dimension count match that identity exactly. When the
 *    configured embedding route has moved on, retrieval reports `incompatible`
 *    and returns nothing rather than scoring a new query vector against the old
 *    space; keyword search keeps serving in the meantime.
 * 2. **Filters run before scoring.** Source/status/done filters are pushed into
 *    the repository as portable metadata predicates, so an excluded row never
 *    consumes a candidate slot and never reaches the ranking stage.
 * 3. **Nothing interactive embeds a corpus.** Query and status paths issue at
 *    most one embedding request (for the query itself, cached per identity).
 *    Backfill is scheduled durably and executed by the worker.
 *
 * Status is deliberately **two** concepts, because they fail independently:
 *
 * - `getEmbeddingOperationalStatus` answers "can this deployment embed, and
 *   which route answers when it does?". It is independent of whether semantic
 *   search enrichment is switched on, because the AI settings screen and the
 *   connection test have to work before enrichment is enabled. The AI provider
 *   route consumes it, along with `testEmbeddingConnection`.
 * - `getSemanticSearchStatus` answers "is the durable semantic index ready to
 *   serve retrieval?". The search API consumes it.
 *
 * Every provider request — query, probe, connection test, and worker — goes
 * through the single client in `./embedding-request`, so routing headers,
 * sensitivity assertions, and response route verification have exactly one
 * implementation.
 */

import { AIRoutingDeniedError } from '@/lib/ai/provider-factory';
import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import { aiLogger, semanticIndexLogger } from '@/lib/logger';
import { isSemanticIndexEnabled } from '@/lib/semantic-index/config';
import type {
  SemanticDocumentMetadataValue,
  SemanticEntityKindReadiness,
  SemanticEntityType,
  SemanticIdentityDescriptor,
  SemanticIndexIdentity,
  SemanticIndexMetrics,
  SemanticIndexReadiness,
  SemanticIndexRepository,
  SemanticMetadataFilter,
  SemanticQueryResult,
  SemanticQueryScan,
  SemanticRunProgress,
  SemanticScanCapability,
  SemanticVectorRecord,
} from '@/lib/semantic-index/contracts';
import type {
  SemanticEmbeddingProvider,
  SemanticEmbeddingRoute,
} from '@/lib/semantic-index/embedding-provider';
import {
  getSemanticIndexRuntime,
  scheduleSemanticBackfill,
  type SemanticBackfillSchedule,
} from '@/lib/semantic-index/runtime';
import {
  getConfiguredEmbeddingRoute,
  getEmbeddingConfig,
  requestEmbeddingWithRetries,
  type EmbeddingConfig,
} from './embedding-request';
import type { SearchResult } from './fts';
import { QueryEmbeddingCache } from './query-embedding-cache';

type SearchScope = 'tasks' | 'notifications' | 'all';

interface SearchFilters {
  source?: string;
  status?: string;
  excludeDone?: boolean;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLimit(limit = 20) {
  return Math.max(1, Math.min(limit, 50));
}

function truncate(text: string | null | undefined, max = 160) {
  const value = (text ?? '').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function buildTaskHref(id: string) {
  return `/?taskId=${encodeURIComponent(id)}`;
}

function buildNotificationHref(id: string) {
  return `/notifications?id=${encodeURIComponent(id)}`;
}

const SIMILARITY_THRESHOLD = 0.25;

/**
 * A query vector, bound to the exact identity it may be compared against. The
 * binding is part of the cached value (not just the cache key) so a cache hit
 * can still be re-checked before it is used.
 */
interface QueryVector {
  embedding: Float32Array;
  provider: string;
  model: string;
  dimensions: number;
  identityId: string;
}

const queryEmbeddingCache = new QueryEmbeddingCache<QueryVector>(
  positiveInteger(process.env.MC_QUERY_EMBEDDING_CACHE_MAX_ENTRIES, 128),
  positiveInteger(process.env.MC_QUERY_EMBEDDING_CACHE_TTL_MS, 5 * 60_000),
);

const searchMetrics = {
  searches: 0,
  lastStrategy: 'bounded-in-process' as SemanticQueryScan['kind'],
  postgresVectorVersion: null as string | null,
  totalCandidates: 0,
  lastCandidates: 0,
  candidateLimit: 0,
  saturatedSearches: 0,
  truncatedScans: 0,
  retrievalErrors: 0,
  durationsMs: [] as number[],
};

/** The last index snapshot observed by a status read; never query content. */
let lastIndexSnapshot: SemanticIndexSnapshot | null = null;

/**
 * Records a retrieval failure and lets the caller degrade.
 *
 * Semantic enrichment is additive: a repository or policy error must never
 * remove the keyword results the user is already waiting on, so the failure is
 * counted and logged (ids and codes only) rather than propagated.
 */
function recordRetrievalFailure(scope: string, error: unknown): void {
  searchMetrics.retrievalErrors++;
  semanticIndexLogger.warn({
    event: 'semantic_retrieval_failed',
    scope,
    err: error,
  }, 'Semantic retrieval failed; falling back to keyword results');
}

// ─── Embedding route operations ─────────────────────────────────────────────

export interface EmbeddingRouteIdentity {
  provider: string;
  model: string;
}

export interface EmbeddingResolvedIdentity extends EmbeddingRouteIdentity {
  dimensions: number;
}

export type EmbeddingOperationalState =
  /** The routing policy refuses the configured embedding route. */
  | 'denied'
  /** No embedding endpoint or credential is configured. */
  | 'unconfigured'
  /** The route works, but no compatible vector space is active yet. */
  | 'not-ready'
  | 'ready';

export interface EmbeddingOperationalStatus {
  available: boolean;
  state: EmbeddingOperationalState;
  note?: string;
  /** Vectors in the active identity for this route. Never per-request. */
  indexedCount?: number;
  /** What the operator configured — the proxy route, for Bifrost. */
  configured: EmbeddingRouteIdentity;
  /** What actually answers, recorded from a real provider response. */
  resolved?: EmbeddingResolvedIdentity | null;
}

/**
 * Logs an embedding-route problem without disturbing retrieval metrics.
 *
 * The operational status is about the AI route, not about a search, so a
 * failure here must not be counted as a retrieval error.
 */
function recordEmbeddingStatusFailure(error: unknown): void {
  aiLogger.warn({
    featureId: 'semantic-embedding',
    err: error,
  }, 'Embedding operational status could not read the semantic index');
}

/**
 * The active durable identity for this embedding route, or `null`.
 *
 * The identity is only returned when the configured route still names its
 * vector space: an identity built by a route the deployment has since moved off
 * is *not* this route's index, and reporting it as `resolved` would tell an
 * operator their new model is live when it is not.
 */
async function readActiveEmbeddingIdentity(
  config: EmbeddingConfig,
): Promise<SemanticIndexIdentity | null> {
  try {
    const route = getConfiguredEmbeddingRoute(config);
    const { repository } = await getSemanticIndexRuntime();
    const identity = await repository.getActiveIdentity();
    if (!identity) return null;
    return routeMatchesIdentity(identity, route) ? identity : null;
  } catch (error) {
    recordEmbeddingStatusFailure(error);
    return null;
  }
}

/**
 * Reports whether the configured embedding route can be used, and which route
 * actually answers.
 *
 * Deliberately independent of `semanticSearchEnabled`: an operator has to be
 * able to configure and test the embedding route *before* turning search
 * enrichment on, and the AI settings screen shows this status either way.
 *
 * Never returns credentials, endpoints, or content.
 */
export async function getEmbeddingOperationalStatus(): Promise<EmbeddingOperationalStatus> {
  const resolved = getResolvedAIConfig();
  const configuredFallback: EmbeddingRouteIdentity = {
    provider: resolved.embeddingProvider ?? resolved.provider,
    model: resolved.embeddingModel,
  };

  let config: EmbeddingConfig | null;
  try {
    config = await getEmbeddingConfig();
  } catch (error) {
    if (error instanceof AIRoutingDeniedError) {
      return {
        available: false,
        state: 'denied',
        note: 'The routing policy does not permit this embedding route.',
        configured: configuredFallback,
      };
    }
    throw error;
  }
  if (!config) {
    return {
      available: false,
      state: 'unconfigured',
      note: 'An embedding route endpoint or credential is required.',
      configured: configuredFallback,
    };
  }

  const configured: EmbeddingRouteIdentity = {
    provider: config.provider,
    model: config.model,
  };
  const active = await readActiveEmbeddingIdentity(config);
  if (!active) {
    return {
      available: false,
      state: 'not-ready',
      note: 'A compatible embedding index is not active yet. '
        + 'Save the route and run a rebuild.',
      indexedCount: 0,
      configured,
      resolved: null,
    };
  }

  return {
    available: true,
    state: 'ready',
    indexedCount: active.vectorCount,
    configured,
    resolved: {
      provider: active.provider,
      model: active.model,
      dimensions: active.dimensions,
    },
  };
}

/**
 * Issues one throwaway embedding request so an operator can prove the route
 * works, and reports the route that actually answered.
 *
 * `AIRoutingDeniedError` is intentionally allowed to propagate: a policy
 * refusal is a configuration answer, not a connection failure, and the caller
 * renders it differently. Every other failure is reported without the endpoint,
 * credential, or provider message.
 */
export async function testEmbeddingConnection() {
  const config = await getEmbeddingConfig();
  if (!config) {
    return {
      success: false as const,
      error: 'Embedding route is not configured',
    };
  }
  const startedAt = Date.now();
  const result = await requestEmbeddingWithRetries(
    'Mission Control embedding connection test',
    config,
  );
  if (result.status !== 'ok') {
    return {
      success: false as const,
      error: 'Embedding provider did not return a valid vector',
      latencyMs: Date.now() - startedAt,
    };
  }
  return {
    success: true as const,
    latencyMs: Date.now() - startedAt,
    configured: { provider: config.provider, model: config.model },
    resolved: {
      provider: result.provider,
      model: result.model,
      dimensions: result.embedding.length,
      fallbackOccurred: result.fallbackOccurred,
    },
  };
}

/**
 * Embeds one piece of text through the shared embedding client.
 *
 * Retained for callers that need a vector without the index (the graph and
 * connection-test surfaces), and deliberately **not** gated on
 * `semanticSearchEnabled`: the embedding route is shared infrastructure, and
 * turning search enrichment off must not disable it.
 *
 * Returns `[]` rather than throwing, so a caller can degrade.
 */
export async function generateEmbedding(
  text: string,
  options: { sources?: string[] } = {},
): Promise<number[]> {
  const config = await getEmbeddingConfig(options.sources);
  if (!config) {
    return [];
  }
  const result = await requestEmbeddingWithRetries(text, config);
  return result.status === 'ok' ? result.embedding : [];
}

// ─── Index readiness ────────────────────────────────────────────────────────

export interface SemanticIndexSnapshot {
  active: SemanticIdentityDescriptor | null;
  /** Identities building or awaiting cutover — an in-flight route migration. */
  staging: SemanticIdentityDescriptor[];
  /** The route the current configuration resolves to, without issuing egress. */
  configuredRoute: SemanticEmbeddingRoute | null;
  /** False when the configured route no longer names the active vector space. */
  routeMatchesActiveIdentity: boolean;
  byEntityType: SemanticEntityKindReadiness[];
  totals: {
    documents: number;
    vectors: number;
    stale: number;
    incompatible: number;
    expired: number;
  };
  intents: {
    queued: number;
    running: number;
    retrying: number;
    totalRetries: number;
    permanentFailures: number;
    oldestQueuedAgeMs: number;
    oldestRunningAgeMs: number;
  };
  runs: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    expired: number;
  };
  latestRuns: SemanticRunProgress[];
  scan: SemanticScanCapability;
}

export type SemanticSearchState =
  /** Enrichment is switched off in AI settings. */
  | 'disabled'
  /** No embedding provider is configured, or policy denies the route. */
  | 'unconfigured'
  /** A vector space is staging but nothing has been cut over yet. */
  | 'building'
  /** An identity is active but has no usable vectors yet. */
  | 'not-ready'
  /** The configured route no longer matches the active vector space. */
  | 'incompatible'
  /** Serving, but part of the corpus is stale or in a foreign vector space. */
  | 'degraded'
  | 'ready';

export interface SemanticSearchStatus {
  available: boolean;
  state: SemanticSearchState;
  note: string | null;
  /** Vectors in the active identity. Global, never per-request or per-user. */
  indexedCount: number;
  index: SemanticIndexSnapshot | null;
}

function sumReadiness(byEntityType: SemanticEntityKindReadiness[]) {
  return byEntityType.reduce((totals, kind) => ({
    documents: totals.documents + kind.documents,
    vectors: totals.vectors + kind.vectors,
    stale: totals.stale + kind.stale,
    incompatible: totals.incompatible + kind.incompatible,
    expired: totals.expired + kind.expired,
  }), { documents: 0, vectors: 0, stale: 0, incompatible: 0, expired: 0 });
}

function buildSnapshot(input: {
  readiness: SemanticIndexReadiness;
  metrics: SemanticIndexMetrics | null;
  route: SemanticEmbeddingRoute | null;
  routeMatches: boolean;
}): SemanticIndexSnapshot {
  const { readiness, metrics, route, routeMatches } = input;
  return {
    active: readiness.activeIdentityId === null ? null : {
      id: readiness.activeIdentityId,
      provider: readiness.provider ?? '',
      model: readiness.model ?? '',
      dimensions: readiness.dimensions ?? 0,
      projectionVersion: readiness.projectionVersion ?? 0,
      status: 'active',
      documentCount: readiness.documentCount,
      vectorCount: readiness.vectorCount,
    },
    staging: readiness.stagingIdentities,
    configuredRoute: route,
    routeMatchesActiveIdentity: routeMatches,
    byEntityType: readiness.byEntityType,
    totals: sumReadiness(readiness.byEntityType),
    intents: {
      queued: metrics?.intents.queued ?? 0,
      running: metrics?.intents.running ?? 0,
      retrying: metrics?.intents.retrying ?? 0,
      totalRetries: metrics?.intents.totalRetries ?? 0,
      permanentFailures: metrics?.intents.permanentFailures ?? 0,
      oldestQueuedAgeMs: metrics?.intents.oldestQueuedAgeMs ?? 0,
      oldestRunningAgeMs: metrics?.intents.oldestRunningAgeMs ?? 0,
    },
    runs: metrics?.runs ?? {
      queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, expired: 0,
    },
    latestRuns: metrics?.latestRuns ?? [],
    scan: readiness.scan,
  };
}

function routeMatchesIdentity(
  identity: Pick<SemanticIndexIdentity, 'provider' | 'model'>,
  route: SemanticEmbeddingRoute,
): boolean {
  return identity.provider === route.provider && identity.model === route.model;
}

function statusResult(
  state: SemanticSearchState,
  note: string | null,
  snapshot: SemanticIndexSnapshot | null,
): SemanticSearchStatus {
  lastIndexSnapshot = snapshot;
  return {
    available: state === 'ready' || state === 'degraded',
    state,
    note,
    indexedCount: snapshot?.active?.vectorCount ?? 0,
    index: snapshot,
  };
}

/**
 * Reports whether semantic retrieval can serve, and why not when it cannot.
 *
 * Reads durable aggregates only: it never embeds a corpus, never backfills, and
 * never returns content, query text, vectors, or credentials.
 */
export async function getSemanticSearchStatus(): Promise<SemanticSearchStatus> {
  if (!getResolvedAIConfig().semanticSearchEnabled) {
    return statusResult(
      'disabled',
      'Semantic search enrichment is turned off in AI settings.',
      null,
    );
  }

  try {
    return await readSemanticSearchStatus();
  } catch (error) {
    recordRetrievalFailure('status', error);
    return statusResult(
      'unconfigured',
      'Semantic search is unavailable until the index storage is reachable.',
      null,
    );
  }
}

async function readSemanticSearchStatus(): Promise<SemanticSearchStatus> {
  const { repository, embeddings } = await getSemanticIndexRuntime();
  const resolution = await embeddings.resolveRoute('standard');
  const route = resolution.status === 'ok' ? resolution.route : null;

  const readiness = await repository.getReadiness();
  const activeId = readiness.activeIdentityId;
  const metrics = activeId ? await repository.getMetrics(activeId) : null;
  const routeMatches = route !== null
    && readiness.provider !== null
    && readiness.model !== null
    && routeMatchesIdentity(
      { provider: readiness.provider, model: readiness.model },
      route,
    );
  const snapshot = buildSnapshot({ readiness, metrics, route, routeMatches });

  if (!route) {
    return statusResult(
      'unconfigured',
      'Semantic search is unavailable until an AI embedding provider is configured.',
      snapshot,
    );
  }
  if (!activeId) {
    return snapshot.staging.length > 0
      ? statusResult(
          'building',
          'A semantic index is being built; semantic results appear once it is ready.',
          snapshot,
        )
      : statusResult(
          'not-ready',
          'Semantic search is enabled, but no semantic index has been built yet.',
          snapshot,
        );
  }
  if (!routeMatches) {
    return statusResult(
      'incompatible',
      'The configured embedding model differs from the active semantic index; '
      + 'a replacement index is required before semantic results resume.',
      snapshot,
    );
  }
  if (!readiness.available) {
    return statusResult(
      'not-ready',
      'Semantic search is unavailable because the configured retrieval index is not ready.',
      snapshot,
    );
  }
  if (snapshot.totals.vectors === 0) {
    return statusResult(
      'not-ready',
      'Semantic search is enabled, but compatible entity embeddings are not ready yet.',
      snapshot,
    );
  }
  if (snapshot.totals.stale > 0 || snapshot.totals.incompatible > 0) {
    return statusResult(
      'degraded',
      'Semantic search is serving, but part of the index is still catching up.',
      snapshot,
    );
  }
  return statusResult('ready', null, snapshot);
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export function getSemanticSearchMetrics() {
  const sortedDurations = [...searchMetrics.durationsMs].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
  return {
    queryCache: queryEmbeddingCache.getMetrics(),
    search: {
      searches: searchMetrics.searches,
      lastStrategy: searchMetrics.lastStrategy,
      postgresVectorVersion: searchMetrics.postgresVectorVersion,
      totalCandidates: searchMetrics.totalCandidates,
      lastCandidates: searchMetrics.lastCandidates,
      candidateLimit: searchMetrics.candidateLimit,
      saturatedSearches: searchMetrics.saturatedSearches,
      truncatedScans: searchMetrics.truncatedScans,
      retrievalErrors: searchMetrics.retrievalErrors,
      p95DurationMs: sortedDurations[p95Index] ?? 0,
    },
    /** The last durable snapshot observed by `getSemanticSearchStatus`. */
    index: lastIndexSnapshot,
  };
}

function recordSearchMetrics(scan: SemanticQueryScan, durationMs: number) {
  searchMetrics.searches++;
  searchMetrics.lastStrategy = scan.kind;
  searchMetrics.postgresVectorVersion =
    scan.kind === 'postgres-hnsw' ? scan.extensionVersion : null;
  searchMetrics.totalCandidates += scan.candidatesScanned;
  searchMetrics.lastCandidates = scan.candidatesScanned;
  searchMetrics.candidateLimit = scan.candidateCeiling;
  if (scan.truncated) {
    searchMetrics.saturatedSearches++;
    searchMetrics.truncatedScans++;
  }
  searchMetrics.durationsMs.push(durationMs);
  if (searchMetrics.durationsMs.length > 128) {
    searchMetrics.durationsMs.shift();
  }
}

/** Test hook: drops process-local retrieval state. */
export function resetSemanticSearchStateForTests(): void {
  queryEmbeddingCache.clear();
  lastIndexSnapshot = null;
  searchMetrics.searches = 0;
  searchMetrics.lastStrategy = 'bounded-in-process';
  searchMetrics.postgresVectorVersion = null;
  searchMetrics.totalCandidates = 0;
  searchMetrics.lastCandidates = 0;
  searchMetrics.candidateLimit = 0;
  searchMetrics.saturatedSearches = 0;
  searchMetrics.truncatedScans = 0;
  searchMetrics.retrievalErrors = 0;
  searchMetrics.durationsMs.length = 0;
}

// ─── Retrieval context ──────────────────────────────────────────────────────

type RetrievalContext =
  | {
      status: 'ready';
      repository: SemanticIndexRepository;
      embeddings: SemanticEmbeddingProvider;
      identity: SemanticIndexIdentity;
      route: SemanticEmbeddingRoute;
    }
  | { status: 'unavailable'; state: SemanticSearchState; note: string };

const UNAVAILABLE_NOTES: Record<Exclude<SemanticSearchState, 'ready' | 'degraded'>, string> = {
  disabled: 'Semantic search enrichment is turned off in AI settings.',
  unconfigured: 'Semantic search requires a configured embedding provider.',
  building: 'A semantic index is still being built.',
  'not-ready': 'The semantic index has no compatible embeddings yet.',
  incompatible: 'The configured embedding model differs from the active semantic index.',
};

function unavailable(state: Exclude<SemanticSearchState, 'ready' | 'degraded'>): RetrievalContext {
  return { status: 'unavailable', state, note: UNAVAILABLE_NOTES[state] };
}

/**
 * Resolves the single identity retrieval may read from.
 *
 * Only the repository's declared **active** identity is ever used; a staging
 * identity is deliberately not queried, because serving from a half-built space
 * would silently drop results. The configured route must still name that
 * identity's vector space, otherwise a fresh query vector would be compared
 * against a foreign one.
 */
async function resolveRetrievalContext(): Promise<RetrievalContext> {
  if (!isSemanticIndexEnabled()) return unavailable('disabled');

  let repository: SemanticIndexRepository;
  let embeddings: SemanticEmbeddingProvider;
  try {
    ({ repository, embeddings } = await getSemanticIndexRuntime());
  } catch (error) {
    recordRetrievalFailure('runtime', error);
    return unavailable('unconfigured');
  }

  try {
    const identity = await repository.getActiveIdentity();
    if (!identity) {
      const readiness = await repository.getReadiness();
      return unavailable(readiness.stagingIdentities.length > 0 ? 'building' : 'not-ready');
    }
    if (identity.vectorCount === 0) return unavailable('not-ready');

    const resolution = await embeddings.resolveRoute('standard');
    if (resolution.status !== 'ok') return unavailable('unconfigured');
    if (!routeMatchesIdentity(identity, resolution.route)) return unavailable('incompatible');

    return { status: 'ready', repository, embeddings, identity, route: resolution.route };
  } catch (error) {
    recordRetrievalFailure('identity', error);
    return unavailable('not-ready');
  }
}

// ─── Query embedding ────────────────────────────────────────────────────────

function normalizeQueryForCache(query: string) {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The cache key names the vector space, not just the text: a query embedded for
 * one identity must never be reused for another, and a route change must miss
 * rather than hit.
 */
function queryEmbeddingCacheKey(query: string, context: Extract<RetrievalContext, { status: 'ready' }>) {
  return JSON.stringify([
    normalizeQueryForCache(query),
    context.identity.id,
    context.identity.provider,
    context.identity.model,
    context.identity.dimensions,
    context.identity.projectionVersion,
    context.route.provider,
    context.route.model,
  ]);
}

/**
 * Embeds the query through the shared embedding seam, declaring the identity's
 * provider/model/dimensions as `expect` so a response from a different route,
 * or with a different dimension count, is refused instead of scored.
 */
async function getQueryEmbedding(
  query: string,
  context: Extract<RetrievalContext, { status: 'ready' }>,
): Promise<QueryVector | null> {
  const cached = await queryEmbeddingCache.getOrCreate(
    queryEmbeddingCacheKey(query, context),
    async () => {
      const result = await context.embeddings.embed({
        text: query,
        sensitivity: 'standard',
        expect: {
          provider: context.identity.provider,
          model: context.identity.model,
          dimensions: context.identity.dimensions,
        },
      });
      if (result.status !== 'ok') return null;
      return {
        embedding: result.embedding,
        provider: result.provider,
        model: result.model,
        dimensions: result.dimensions,
        identityId: context.identity.id,
      };
    },
  );

  // Re-verify on the way out: a cache hit is only usable if it still names this
  // identity's exact vector space.
  if (!cached) return null;
  if (
    cached.identityId !== context.identity.id
    || cached.provider !== context.identity.provider
    || cached.model !== context.identity.model
    || cached.dimensions !== context.identity.dimensions
    || cached.embedding.length !== context.identity.dimensions
  ) {
    return null;
  }
  return cached;
}

// ─── Portable domain filters ────────────────────────────────────────────────

function entityTypesForScope(scope: SearchScope): SemanticEntityType[] | undefined {
  if (scope === 'tasks') return ['task'];
  if (scope === 'notifications') return ['alert'];
  return ['task', 'alert'];
}

/**
 * Translates the existing search filters into portable metadata predicates.
 *
 * A task's `status` and an alert's `category` are the same logical field for
 * these filters (the keyword path coalesces them in SQL), so both keys are
 * tested as one group. The repository applies them before the candidate
 * ceiling, so excluded rows never displace allowed ones.
 */
function buildMetadataFilters(filters: SearchFilters): SemanticMetadataFilter[] {
  const metadataFilters: SemanticMetadataFilter[] = [];
  if (filters.source) {
    metadataFilters.push({
      keys: ['sourceListName', 'connectorType'],
      match: 'any',
      values: [filters.source],
    });
  }
  if (filters.status) {
    metadataFilters.push({
      keys: ['status', 'category'],
      match: 'any',
      values: [filters.status],
    });
  }
  if (filters.excludeDone) {
    metadataFilters.push({
      keys: ['status', 'category'],
      match: 'none',
      values: ['done'],
      caseInsensitive: true,
    });
  }
  return metadataFilters;
}

// ─── Result mapping ─────────────────────────────────────────────────────────

function metadataString(
  metadata: Record<string, SemanticDocumentMetadataValue>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

function metadataBoolean(
  metadata: Record<string, SemanticDocumentMetadataValue>,
  key: string,
): boolean {
  return metadata[key] === true;
}

function toSearchResult(result: SemanticQueryResult): SearchResult | null {
  if (result.entityType === 'task') {
    return {
      type: 'task',
      id: result.entityId,
      title: result.title,
      snippet: truncate(result.body),
      score: result.score,
      source: 'semantic',
      href: buildTaskHref(result.entityId),
      metadata: {
        status: metadataString(result.metadata, 'status'),
        priority: metadataString(result.metadata, 'priority'),
        sourceListName: metadataString(result.metadata, 'sourceListName'),
        connectorType: metadataString(result.metadata, 'connectorType'),
        updatedAt: result.sourceUpdatedAt,
      },
    };
  }
  if (result.entityType === 'alert') {
    const category = metadataString(result.metadata, 'category');
    return {
      type: 'notification',
      id: result.entityId,
      title: result.title,
      snippet: truncate(result.body) || truncate(category),
      score: result.score,
      source: 'semantic',
      href: buildNotificationHref(result.entityId),
      metadata: {
        severity: metadataString(result.metadata, 'level'),
        category,
        isRead: metadataString(result.metadata, 'readState') === 'read'
          || metadataString(result.metadata, 'state') === 'read',
        isActionable: metadataBoolean(result.metadata, 'isActionable'),
        connectorType: metadataString(result.metadata, 'connectorType'),
        receivedAt: metadataString(result.metadata, 'receivedAt') ?? result.sourceUpdatedAt,
      },
    };
  }
  // Kinds the search surface does not present are dropped rather than coerced.
  return null;
}

// ─── Search ─────────────────────────────────────────────────────────────────

export async function semanticSearch(
  query: string,
  options: { type?: SearchScope; limit?: number } & SearchFilters = {},
): Promise<SearchResult[]> {
  const startedAt = performance.now();
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const context = await resolveRetrievalContext();
  if (context.status !== 'ready') return [];

  try {
    const queryVector = await getQueryEmbedding(normalizedQuery, context);
    if (!queryVector) return [];

    const limit = normalizeLimit(options.limit);
    const response = await context.repository.queryVectors({
      indexId: context.identity.id,
      queryEmbedding: queryVector.embedding,
      limit,
      entityTypes: entityTypesForScope(options.type ?? 'all'),
      metadataFilters: buildMetadataFilters(options),
      minScore: SIMILARITY_THRESHOLD,
      now: new Date().toISOString(),
    });
    recordSearchMetrics(response.scan, performance.now() - startedAt);

    const results: SearchResult[] = [];
    for (const result of response.results) {
      const mapped = toSearchResult(result);
      if (mapped) results.push(mapped);
    }
    return results;
  } catch (error) {
    // Semantic enrichment is additive: never take the keyword branch down with
    // it (the identity may have been retired mid-query, for instance).
    recordRetrievalFailure('search', error);
    return [];
  }
}

// ─── Graph neighbours ───────────────────────────────────────────────────────

export interface TaskEmbeddingNeighbor {
  taskId: string;
  score: number;
  embeddingUpdatedAt: string;
}

export type TaskEmbeddingNeighborResult =
  | {
      status: 'available';
      provider: string;
      model: string;
      sourceUpdatedAt: string;
      neighbors: TaskEmbeddingNeighbor[];
    }
  | {
      status: 'unavailable' | 'missing' | 'stale' | 'incompatible';
      note: string;
      neighbors: [];
    };

function neighborFailure(
  status: 'unavailable' | 'missing' | 'stale' | 'incompatible',
  note: string,
): TaskEmbeddingNeighborResult {
  return { status, note, neighbors: [] };
}

/**
 * A stored vector belongs to the active vector space only when every component
 * of the identity agrees. A disagreement is not a race — it is a different
 * space, and comparing across it would fabricate similarity.
 */
function vectorMatchesIdentity(
  vector: SemanticVectorRecord,
  identity: SemanticIndexIdentity,
): boolean {
  return vector.provider === identity.provider
    && vector.model === identity.model
    && vector.dimensions === identity.dimensions
    && vector.projectionVersion === identity.projectionVersion
    && vector.embedding.length === identity.dimensions;
}

/**
 * Finds semantically similar tasks for one task, using **only** the vector the
 * index already holds for it.
 *
 * No embedding is generated from entity content here: if the source task has no
 * current, compatible vector, the honest answer is `missing`/`stale`/
 * `incompatible`, not a freshly embedded probe that would compare content
 * against a corpus embedded under different rules.
 */
export async function findSimilarTaskEmbeddings(
  taskId: string,
  options: { limit?: number; minScore?: number } = {},
): Promise<TaskEmbeddingNeighborResult> {
  const startedAt = performance.now();
  const context = await resolveRetrievalContext();
  if (context.status !== 'ready') {
    return neighborFailure('unavailable', context.note);
  }
  const { repository, identity } = context;

  try {
    const vector = await repository.getVector(identity.id, 'task', taskId);
    if (!vector) {
      return neighborFailure(
        'missing',
        'The selected task does not have an indexed embedding.',
      );
    }
    if (!vectorMatchesIdentity(vector, identity)) {
      return neighborFailure(
        'incompatible',
        'The selected task embedding was produced by a different embedding model.',
      );
    }

    const document = await repository.getDocument(identity.id, 'task', taskId);
    if (!document || document.deletedAt !== null) {
      return neighborFailure('missing', 'The selected task is no longer indexed.');
    }
    if (
      vector.documentVersion !== document.version
      || vector.sourceRevision !== document.sourceRevision
      || vector.contentFingerprint !== document.contentFingerprint
    ) {
      return neighborFailure('stale', 'The selected task embedding is older than the task.');
    }

    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 25);
    const minScore = Math.min(Math.max(options.minScore ?? SIMILARITY_THRESHOLD, 0), 1);
    const response = await repository.queryVectors({
      indexId: identity.id,
      queryEmbedding: vector.embedding,
      limit,
      entityTypes: ['task'],
      excludeEntityIds: [taskId],
      minScore,
      now: new Date().toISOString(),
    });
    recordSearchMetrics(response.scan, performance.now() - startedAt);

    return {
      status: 'available',
      provider: identity.provider,
      model: identity.model,
      sourceUpdatedAt: vector.embeddedAt,
      neighbors: response.results.map((result) => ({
        taskId: result.entityId,
        score: Math.min(result.score, 1),
        embeddingUpdatedAt: result.embeddedAt,
      })),
    };
  } catch (error) {
    recordRetrievalFailure('neighbors', error);
    return neighborFailure(
      'unavailable',
      'Semantic neighbours are temporarily unavailable.',
    );
  }
}

// ─── Backfill ───────────────────────────────────────────────────────────────

/**
 * Schedules a durable backfill run and returns as soon as it is recorded.
 *
 * Retained under its historical name because callers and operator tooling still
 * ask for a "rebuild", but the corpus is never rebuilt in the calling process:
 * this enqueues a `SemanticRun` that the index worker executes in bounded,
 * checkpointed slices.
 */
export async function rebuildEmbeddingIndex(): Promise<SemanticBackfillSchedule> {
  return scheduleSemanticBackfill();
}
