import { describe, expect, it } from 'vitest';
import { resolveSemanticWorkerConfig } from '@/lib/semantic-index/worker-config';

describe('semantic worker configuration', () => {
  it('shares production defaults with backend-isolated compositions', () => {
    expect(resolveSemanticWorkerConfig(['task'], {} as NodeJS.ProcessEnv)).toMatchObject({
      entityTypes: ['task'],
      batchSize: 16,
      concurrency: 2,
      pollIntervalMs: 15_000,
      busyIntervalMs: 500,
      intentLeaseMs: 60_000,
      runLeaseMs: 300_000,
      heartbeatIntervalMs: 20_000,
      intentBudgetMs: 45_000,
      runSliceBudgetMs: 30_000,
      runPageSize: 200,
      shutdownGraceMs: 10_000,
      embeddingTimeoutMs: 20_000,
      maintenanceIntervalMs: 15 * 60_000,
      intentHistoryRetentionMs: 7 * 86_400_000,
      tombstoneRetentionMs: 7 * 86_400_000,
      identityRetentionMs: 14 * 86_400_000,
    });
  });

  it('enforces the same bounded batch, lease, heartbeat, and retention limits', () => {
    const config = resolveSemanticWorkerConfig(['task', 'project'], {
      MC_SEMANTIC_WORKER_BATCH_SIZE: '999',
      MC_SEMANTIC_WORKER_CONCURRENCY: '0',
      MC_SEMANTIC_INTENT_LEASE_MS: '1',
      MC_SEMANTIC_RUN_LEASE_MS: '99999999',
      MC_SEMANTIC_RUN_PAGE_SIZE: '9999',
      MC_SEMANTIC_WORKER_SHUTDOWN_GRACE_MS: '-1',
      MC_SEMANTIC_INTENT_HISTORY_RETENTION_MS: '1',
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      entityTypes: ['task', 'project'],
      batchSize: 200,
      concurrency: 2,
      intentLeaseMs: 5_000,
      runLeaseMs: 3_600_000,
      heartbeatIntervalMs: 1_666,
      runPageSize: 1_000,
      shutdownGraceMs: 10_000,
      intentHistoryRetentionMs: 3_600_000,
    });
  });
});
