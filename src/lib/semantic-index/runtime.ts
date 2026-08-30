/**
 * Process-level wiring for the durable semantic index.
 *
 * This is the seam the rest of Mission Control talks to. It resolves the
 * backend-appropriate repository and source port, builds the service and the
 * worker, and exposes:
 *
 * - `startSemanticIndexWorker` / `stopSemanticIndexWorker` for the sync worker
 *   process; and
 * - `getSemanticIndexService`, `publishSemanticUpsert`, `publishSemanticDelete`,
 *   and `getSemanticIndexReadiness` for the retrieval/integration phase that
 *   follows. Those publish helpers never throw: an authoritative domain write
 *   must never fail because the index is unavailable.
 *
 * Nothing here performs I/O at import time.
 */

import { randomUUID } from 'node:crypto';
import { semanticIndexLogger } from '@/lib/logger';
import {
  getSemanticWorkerConfig,
  isSemanticIndexEnabled,
  type SemanticWorkerConfig,
} from './config';
import type {
  SemanticActivationGate,
  SemanticActivationResult,
  SemanticIndexMetrics,
  SemanticIndexReadiness,
  SemanticIndexRepository,
  SemanticRollbackResult,
  SemanticRunStatus,
} from './contracts';
import { getSemanticEmbeddingProvider, type SemanticEmbeddingProvider } from './embedding-provider';
import { getSemanticIndexRepository } from './repository-facade';
import { runIdempotencyKey } from './runs';
import { createPolicySensitivityResolver } from './sensitivity';
import { SemanticIndexService, type SemanticPublishResult } from './service';
import { getSemanticSourcePort } from './source/facade';
import type { SemanticSourceEntityType, SemanticSourcePort } from './source/contracts';
import { SemanticIndexWorker } from './worker';

export interface SemanticIndexRuntime {
  repository: SemanticIndexRepository;
  source: SemanticSourcePort;
  embeddings: SemanticEmbeddingProvider;
  service: SemanticIndexService;
  config: SemanticWorkerConfig;
}

export interface SemanticIndexRuntimeOverrides {
  repository?: SemanticIndexRepository;
  source?: SemanticSourcePort;
  embeddings?: SemanticEmbeddingProvider;
  config?: SemanticWorkerConfig;
}

let runtime: SemanticIndexRuntime | null = null;
let runtimePromise: Promise<SemanticIndexRuntime> | null = null;
let worker: SemanticIndexWorker | null = null;

export async function createSemanticIndexRuntime(
  overrides: SemanticIndexRuntimeOverrides = {},
): Promise<SemanticIndexRuntime> {
  const [repository, source] = await Promise.all([
    overrides.repository ? Promise.resolve(overrides.repository) : getSemanticIndexRepository(),
    overrides.source ? Promise.resolve(overrides.source) : getSemanticSourcePort(),
  ]);
  const embeddings = overrides.embeddings ?? getSemanticEmbeddingProvider();
  const config = overrides.config ?? getSemanticWorkerConfig();
  const service = new SemanticIndexService({
    repository,
    source,
    embeddings,
    resolveSensitivity: createPolicySensitivityResolver(),
    embeddingTimeoutMs: config.embeddingTimeoutMs,
  });
  return { repository, source, embeddings, service, config };
}

async function ensureRuntime(): Promise<SemanticIndexRuntime> {
  if (runtime) return runtime;
  if (!runtimePromise) {
    runtimePromise = createSemanticIndexRuntime()
      .then((created) => {
        runtime = created;
        return created;
      })
      .catch((error) => {
        runtimePromise = null;
        throw error;
      });
  }
  return runtimePromise;
}

/**
 * The lifecycle service for the current backend. Callers that only publish
 * intents should prefer the `publishSemantic*` helpers, which swallow failures.
 */
export async function getSemanticIndexService(): Promise<SemanticIndexService> {
  return (await ensureRuntime()).service;
}

/**
 * The resolved runtime (repository + embedding seam + config) for read paths
 * such as retrieval and status. Performs no provider I/O by itself.
 */
export async function getSemanticIndexRuntime(): Promise<SemanticIndexRuntime> {
  return ensureRuntime();
}

export async function getSemanticIndexReadiness(): Promise<SemanticIndexReadiness | null> {
  if (!isSemanticIndexEnabled()) return null;
  const { repository } = await ensureRuntime();
  return repository.getReadiness();
}

/** Aggregate queue/run/document counters for one index identity. */
export async function getSemanticIndexMetrics(
  indexId: string,
): Promise<SemanticIndexMetrics | null> {
  if (!isSemanticIndexEnabled()) return null;
  const { repository } = await ensureRuntime();
  return repository.getMetrics(indexId);
}

export type SemanticBackfillScheduleStatus = 'scheduled' | 'existing' | 'skipped';

export interface SemanticBackfillSchedule {
  status: SemanticBackfillScheduleStatus;
  /** Short, non-sensitive code explaining a `skipped` outcome. */
  reason?: string;
  indexId?: string;
  runId?: string;
  runStatus?: SemanticRunStatus;
}

/**
 * Durably schedules a backfill run for the active/writable identity and returns
 * immediately.
 *
 * The corpus is **never** rebuilt in the calling process: this only records a
 * queued `SemanticRun`, which the index worker claims, executes in bounded
 * slices, and checkpoints. It is idempotent within a maintenance window, so an
 * impatient operator (or a retried request) cannot queue a pile of duplicate
 * runs.
 *
 * No identity is created here, because creating one requires a provider probe;
 * when none exists yet the worker provisions it and schedules its own initial
 * backfill on the next maintenance tick.
 */
export async function scheduleSemanticBackfill(): Promise<SemanticBackfillSchedule> {
  if (!isSemanticIndexEnabled()) {
    return { status: 'skipped', reason: 'semantic-search-disabled' };
  }
  try {
    const { repository, service, config } = await ensureRuntime();
    const resolved = await service.ensureIdentity();
    if (resolved.status !== 'ready') {
      return { status: 'skipped', reason: resolved.reason };
    }
    const window = `manual:${Math.floor(Date.now() / config.maintenanceIntervalMs)}`;
    const created = await repository.createRun({
      id: randomUUID(),
      indexId: resolved.identity.id,
      kind: 'backfill',
      idempotencyKey: runIdempotencyKey(resolved.identity.id, 'backfill', window),
      now: new Date().toISOString(),
    });
    semanticIndexLogger.info({
      event: 'semantic_backfill_scheduled',
      indexId: resolved.identity.id,
      runId: created.run.id,
      status: created.status,
    }, 'Semantic index backfill scheduled');
    return {
      status: created.status === 'created' ? 'scheduled' : 'existing',
      indexId: resolved.identity.id,
      runId: created.run.id,
      runStatus: created.run.status,
    };
  } catch (error) {
    semanticIndexLogger.warn({
      event: 'semantic_backfill_schedule_failed',
      err: error,
    }, 'Failed to schedule semantic index backfill');
    return { status: 'skipped', reason: 'schedule-failed' };
  }
}

// ─── Identity lifecycle ─────────────────────────────────────────────────────

/**
 * Explicit lifecycle operations for the index identities.
 *
 * The worker performs the *routine* cutover on its own — a newly built identity
 * for the configured route replaces the serving one as soon as it passes the
 * readiness gate. These exist for the operator-driven half of the contract:
 * cutting over a staged identity early, rolling back to the previous one, and
 * retiring an identity that will never be served.
 *
 * They are deliberately not exposed as HTTP mutations: each one changes which
 * vector space answers every search, so a caller must be authenticated by the
 * surface that invokes them.
 */
export interface SemanticIdentityLifecycleOutcome {
  status: 'ok' | 'skipped';
  reason?: string;
}

async function withRepository<T>(
  operation: string,
  work: (repository: SemanticIndexRepository) => Promise<T>,
): Promise<T | { status: 'skipped'; reason: string }> {
  if (!isSemanticIndexEnabled()) {
    return { status: 'skipped', reason: 'semantic-search-disabled' };
  }
  try {
    const { repository } = await ensureRuntime();
    return await work(repository);
  } catch (error) {
    semanticIndexLogger.warn({
      event: 'semantic_identity_lifecycle_failed',
      operation,
      err: error,
    }, 'Semantic index identity lifecycle operation failed');
    return { status: 'skipped', reason: `${operation}-failed` };
  }
}

/**
 * Cuts over to `indexId` when it passes the repository's readiness gate. The
 * identity it displaces is demoted to `ready`, not retired, so it remains a
 * rollback target.
 */
export async function activateSemanticIdentity(
  indexId: string,
  gate: SemanticActivationGate = { minVectorCount: 1 },
): Promise<SemanticActivationResult | { status: 'skipped'; reason: string }> {
  return withRepository('activate', async (repository) => {
    const result = await repository.activateIdentity(indexId, new Date().toISOString(), gate);
    semanticIndexLogger.info({
      event: 'semantic_identity_activation_requested',
      indexId,
      status: result.status,
      reason: result.reason,
      previousIndexId: result.previousActiveId ?? undefined,
    }, 'Semantic index cutover requested');
    return result;
  });
}

/** Returns service to a previously active identity that is still compatible. */
export async function rollbackSemanticIdentity(
  indexId: string,
): Promise<SemanticRollbackResult | { status: 'skipped'; reason: string }> {
  return withRepository('rollback', async (repository) => {
    const result = await repository.rollbackToIdentity(indexId, new Date().toISOString());
    semanticIndexLogger.info({
      event: 'semantic_identity_rollback_requested',
      indexId,
      status: result.status,
      reason: result.reason,
      previousIndexId: result.previousActiveId ?? undefined,
    }, 'Semantic index rollback requested');
    return result;
  });
}

/**
 * Withdraws an identity that will never be served. The repository refuses to
 * retire the active one, so retrieval can never be left without a readable
 * identity.
 */
export async function retireSemanticIdentity(
  indexId: string,
): Promise<SemanticIdentityLifecycleOutcome> {
  const result = await withRepository('retire', async (repository) => {
    const retired = await repository.retireIdentity(indexId, new Date().toISOString());
    semanticIndexLogger.info({
      event: 'semantic_identity_retire_requested',
      indexId,
      retired,
    }, 'Semantic index retirement requested');
    return retired
      ? { status: 'ok' as const }
      : { status: 'skipped' as const, reason: 'identity-not-retirable' };
  });
  return result;
}

async function publishSafely(
  kind: 'upsert' | 'delete',
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult> {
  if (!isSemanticIndexEnabled()) {
    return { status: 'skipped', reason: 'semantic-search-disabled' };
  }
  try {
    const { service } = await ensureRuntime();
    const result = await service.publish({ kind, entityType, entityId });
    if (result.status === 'skipped') {
      // Not an error — usually "no identity provisioned yet" — but it means the
      // entity is now behind until reconciliation catches it, so it is recorded.
      semanticIndexLogger.debug({
        event: 'semantic_publish_skipped',
        kind,
        entityType,
        entityId,
        reason: result.reason,
      }, 'Semantic index intent was not published');
    }
    return result;
  } catch (error) {
    // A domain write has already committed by the time this runs. Failing here
    // would corrupt the caller's outcome for no benefit: reconciliation repairs
    // whatever this drop missed.
    semanticIndexLogger.warn({
      event: 'semantic_publish_failed',
      kind,
      entityType,
      entityId,
      err: error,
    }, 'Failed to publish semantic index intent');
    return { status: 'skipped', reason: 'publish-failed' };
  }
}

export function publishSemanticUpsert(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult> {
  return publishSafely('upsert', entityType, entityId);
}

export function publishSemanticDelete(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult> {
  return publishSafely('delete', entityType, entityId);
}

/**
 * Starts the index worker in the current process.
 *
 * Safe to call unconditionally: when semantic search is disabled or no
 * embedding provider is configured, the worker parks and performs no work, and
 * a failure to construct the runtime is logged rather than thrown so it can
 * never prevent its host from starting.
 */
export async function startSemanticIndexWorker(
  overrides: SemanticIndexRuntimeOverrides = {},
): Promise<SemanticIndexWorker | null> {
  if (worker) return worker;
  try {
    const resolved = Object.keys(overrides).length > 0
      ? await createSemanticIndexRuntime(overrides)
      : await ensureRuntime();
    worker = new SemanticIndexWorker({
      repository: resolved.repository,
      source: resolved.source,
      embeddings: resolved.embeddings,
      service: resolved.service,
      config: resolved.config,
    });
    worker.start();
    return worker;
  } catch (error) {
    semanticIndexLogger.error({
      event: 'semantic_worker_start_failed',
      err: error,
    }, 'Semantic index worker failed to start');
    worker = null;
    return null;
  }
}

export async function stopSemanticIndexWorker(): Promise<void> {
  const current = worker;
  worker = null;
  if (!current) return;
  try {
    await current.stop();
  } catch (error) {
    semanticIndexLogger.warn({
      event: 'semantic_worker_stop_failed',
      err: error,
    }, 'Semantic index worker failed to stop cleanly');
  }
}

export function getSemanticIndexWorker(): SemanticIndexWorker | null {
  return worker;
}

/** Test hook: drops the memoized runtime and worker handle. */
export function resetSemanticIndexRuntimeForTests(): void {
  runtime = null;
  runtimePromise = null;
  worker = null;
}

/**
 * Test hook: installs a pre-built runtime so composition-root behaviour
 * (publishing, backfill scheduling, readiness) can be exercised against an
 * in-memory backend without touching the process database.
 */
export function setSemanticIndexRuntimeForTests(next: SemanticIndexRuntime | null): void {
  runtime = next;
  runtimePromise = next ? Promise.resolve(next) : null;
}
