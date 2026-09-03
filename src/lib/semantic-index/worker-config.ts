import type { SemanticSourceEntityType } from './source/contracts';

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
  /** How often lease recovery and maintenance runs are scheduled. */
  maintenanceIntervalMs: number;
  /** Retention for terminal intent rows. */
  intentHistoryRetentionMs: number;
  /** Retention for tombstoned documents before they are hard-deleted. */
  tombstoneRetentionMs: number;
  /** Age after which a retired or failed identity may be removed. */
  identityRetentionMs: number;
}

export function resolveSemanticWorkerConfig(
  entityTypes: readonly SemanticSourceEntityType[],
  env: NodeJS.ProcessEnv = process.env,
): SemanticWorkerConfig {
  const intentLeaseMs = boundedInteger(
    env.MC_SEMANTIC_INTENT_LEASE_MS, 60_000, 5_000, 900_000,
  );
  const runLeaseMs = boundedInteger(
    env.MC_SEMANTIC_RUN_LEASE_MS, 300_000, 10_000, 3_600_000,
  );
  return {
    entityTypes,
    batchSize: boundedInteger(env.MC_SEMANTIC_WORKER_BATCH_SIZE, 16, 1, 200),
    concurrency: boundedInteger(env.MC_SEMANTIC_WORKER_CONCURRENCY, 2, 1, 16),
    pollIntervalMs: boundedInteger(env.MC_SEMANTIC_WORKER_POLL_MS, 15_000, 250, 600_000),
    busyIntervalMs: boundedInteger(env.MC_SEMANTIC_WORKER_BUSY_POLL_MS, 500, 50, 60_000),
    intentLeaseMs,
    runLeaseMs,
    // A third of the lease leaves room for two missed heartbeats before another
    // worker may legitimately steal the row.
    heartbeatIntervalMs: Math.max(1_000, Math.floor(intentLeaseMs / 3)),
    intentBudgetMs: boundedInteger(
      env.MC_SEMANTIC_INTENT_BUDGET_MS, 45_000, 1_000, 600_000,
    ),
    runSliceBudgetMs: boundedInteger(
      env.MC_SEMANTIC_RUN_SLICE_BUDGET_MS, 30_000, 1_000, 600_000,
    ),
    runPageSize: boundedInteger(env.MC_SEMANTIC_RUN_PAGE_SIZE, 200, 1, 1_000),
    shutdownGraceMs: boundedInteger(
      env.MC_SEMANTIC_WORKER_SHUTDOWN_GRACE_MS, 10_000, 0, 120_000,
    ),
    embeddingTimeoutMs: boundedInteger(
      env.MC_SEMANTIC_EMBEDDING_TIMEOUT_MS, 20_000, 1_000, 300_000,
    ),
    maintenanceIntervalMs: boundedInteger(
      env.MC_SEMANTIC_MAINTENANCE_INTERVAL_MS,
      15 * 60_000,
      30_000,
      24 * 3_600_000,
    ),
    intentHistoryRetentionMs: boundedInteger(
      env.MC_SEMANTIC_INTENT_HISTORY_RETENTION_MS,
      7 * 86_400_000,
      3_600_000,
      90 * 86_400_000,
    ),
    tombstoneRetentionMs: boundedInteger(
      env.MC_SEMANTIC_TOMBSTONE_RETENTION_MS,
      7 * 86_400_000,
      3_600_000,
      365 * 86_400_000,
    ),
    identityRetentionMs: boundedInteger(
      env.MC_SEMANTIC_IDENTITY_RETENTION_MS,
      14 * 86_400_000,
      3_600_000,
      365 * 86_400_000,
    ),
  };
}
