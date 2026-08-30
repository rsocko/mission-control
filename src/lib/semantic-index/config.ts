/**
 * Worker/service tunables for the durable semantic index.
 *
 * Every bound is explicit and every default is conservative: the index worker
 * shares a process with the sync worker, so it must never be able to consume
 * the whole event loop, hold a lease past its heartbeat, or run forever.
 */

import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import {
  SEMANTIC_SOURCE_ENTITY_TYPES,
  type SemanticSourceEntityType,
} from './source/contracts';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.min(Math.max(positiveInteger(value, fallback), min), max);
}

export interface SemanticWorkerConfig {
  /** Entity kinds maintenance runs are allowed to scan for the active feature gates. */
  entityTypes: readonly SemanticSourceEntityType[];
  /** Intents claimed per poll. */
  batchSize: number;
  /** Intents processed simultaneously within a batch. */
  concurrency: number;
  /** Delay between polls when the queue was empty. */
  pollIntervalMs: number;
  /** Delay between polls when the previous batch was full (drain faster). */
  busyIntervalMs: number;
  /** Lease duration granted when claiming an intent. */
  intentLeaseMs: number;
  /** Lease duration granted when claiming a run. */
  runLeaseMs: number;
  /** Heartbeat cadence; must be well under the lease duration. */
  heartbeatIntervalMs: number;
  /** Hard ceiling on one intent, including the provider request. */
  intentBudgetMs: number;
  /** Hard ceiling on one run slice before the run yields its lease. */
  runSliceBudgetMs: number;
  /** Entities scanned per run page. */
  runPageSize: number;
  /** Grace period allowed for in-flight work during shutdown. */
  shutdownGraceMs: number;
  /** Embedding request timeout. */
  embeddingTimeoutMs: number;
  /** How often lease recovery + maintenance runs are scheduled. */
  maintenanceIntervalMs: number;
  /** Retention for terminal intent rows. */
  intentHistoryRetentionMs: number;
  /** Retention for tombstoned documents before they are hard-deleted. */
  tombstoneRetentionMs: number;
  /** Age after which a retired/failed identity may be removed. */
  identityRetentionMs: number;
}

export function getSemanticWorkerConfig(): SemanticWorkerConfig {
  const intentLeaseMs = boundedInteger(
    process.env.MC_SEMANTIC_INTENT_LEASE_MS, 60_000, 5_000, 900_000,
  );
  const runLeaseMs = boundedInteger(
    process.env.MC_SEMANTIC_RUN_LEASE_MS, 300_000, 10_000, 3_600_000,
  );
  const ai = getResolvedAIConfig();
  const entityTypes = SEMANTIC_SOURCE_ENTITY_TYPES.filter((entityType) =>
    entityType === 'houston-summary'
      ? ai.houstonMemoryEnabled
      : ai.semanticSearchEnabled
  );
  return {
    entityTypes,
    batchSize: boundedInteger(process.env.MC_SEMANTIC_WORKER_BATCH_SIZE, 16, 1, 200),
    concurrency: boundedInteger(process.env.MC_SEMANTIC_WORKER_CONCURRENCY, 2, 1, 16),
    pollIntervalMs: boundedInteger(
      process.env.MC_SEMANTIC_WORKER_POLL_MS, 15_000, 250, 600_000,
    ),
    busyIntervalMs: boundedInteger(
      process.env.MC_SEMANTIC_WORKER_BUSY_POLL_MS, 500, 50, 60_000,
    ),
    intentLeaseMs,
    runLeaseMs,
    // A third of the lease leaves room for two missed heartbeats before another
    // worker may legitimately steal the row.
    heartbeatIntervalMs: Math.max(1_000, Math.floor(intentLeaseMs / 3)),
    intentBudgetMs: boundedInteger(
      process.env.MC_SEMANTIC_INTENT_BUDGET_MS, 45_000, 1_000, 600_000,
    ),
    runSliceBudgetMs: boundedInteger(
      process.env.MC_SEMANTIC_RUN_SLICE_BUDGET_MS, 30_000, 1_000, 600_000,
    ),
    runPageSize: boundedInteger(process.env.MC_SEMANTIC_RUN_PAGE_SIZE, 200, 1, 1_000),
    shutdownGraceMs: boundedInteger(
      process.env.MC_SEMANTIC_WORKER_SHUTDOWN_GRACE_MS, 10_000, 0, 120_000,
    ),
    embeddingTimeoutMs: boundedInteger(
      process.env.MC_SEMANTIC_EMBEDDING_TIMEOUT_MS, 20_000, 1_000, 300_000,
    ),
    maintenanceIntervalMs: boundedInteger(
      process.env.MC_SEMANTIC_MAINTENANCE_INTERVAL_MS, 15 * 60_000, 30_000, 24 * 3_600_000,
    ),
    intentHistoryRetentionMs: boundedInteger(
      process.env.MC_SEMANTIC_INTENT_HISTORY_RETENTION_MS, 7 * 86_400_000, 3_600_000, 90 * 86_400_000,
    ),
    tombstoneRetentionMs: boundedInteger(
      process.env.MC_SEMANTIC_TOMBSTONE_RETENTION_MS, 7 * 86_400_000, 3_600_000, 365 * 86_400_000,
    ),
    identityRetentionMs: boundedInteger(
      process.env.MC_SEMANTIC_IDENTITY_RETENTION_MS, 14 * 86_400_000, 3_600_000, 365 * 86_400_000,
    ),
  };
}

/**
 * The index is only maintained when semantic search enrichment is switched on.
 * When it is off the worker still starts, but parks immediately and performs no
 * reads, writes, or provider calls.
 */
export function isSemanticIndexEnabled(): boolean {
  if (/^(1|true|yes|on)$/i.test(process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED?.trim() ?? '')) {
    return false;
  }
  try {
    const config = getResolvedAIConfig();
    return Boolean(config.semanticSearchEnabled || config.houstonMemoryEnabled);
  } catch {
    // A settings read can fail before the database exists; treat that as "not
    // enabled yet" rather than crashing the host worker process.
    return false;
  }
}

export function isSemanticEntityTypeEnabled(entityType: SemanticSourceEntityType): boolean {
  try {
    const config = getResolvedAIConfig();
    return entityType === 'houston-summary'
      ? config.houstonMemoryEnabled
      : config.semanticSearchEnabled;
  } catch {
    return false;
  }
}
