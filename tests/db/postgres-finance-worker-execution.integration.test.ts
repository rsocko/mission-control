import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Pool } from 'pg';
import type { SyncResult } from '@/types';
import type { SyncJob } from '@/lib/sync/job-repository';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const sqliteTouch = vi.hoisted(() => vi.fn());

vi.mock('@/db', () => {
  const rejectSqliteAccess = () => {
    sqliteTouch();
    throw new Error('SQLite must not be touched by PostgreSQL finance execution');
  };
  return {
    get default() {
      return rejectSqliteAccess();
    },
    get db() {
      return rejectSqliteAccess();
    },
    get sqlite() {
      return rejectSqliteAccess();
    },
    get runTransaction() {
      return rejectSqliteAccess();
    },
    get schema() {
      return rejectSqliteAccess();
    },
    get initializeDatabase() {
      return rejectSqliteAccess();
    },
    get withoutDatabaseObservation() {
      return rejectSqliteAccess();
    },
  };
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const ORIGINAL_BACKEND = process.env.MC_DATABASE_BACKEND;
const ORIGINAL_POSTGRES_URL = process.env.MC_POSTGRES_URL;
const ORIGINAL_SSL_MODE = process.env.MC_POSTGRES_SSL_MODE;
const ORIGINAL_MODE = process.env.MC_MODE;
const ORIGINAL_POLICY_VERSION = process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION;
const ORIGINAL_SHADOW_INGEST = process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED;
const IDENTITY_NAMESPACE = 'a'.repeat(64);

let pool: Pool;
let shutdownRuntimeDatabase: (() => Promise<void>) | undefined;
let SyncExecutionPipeline: typeof import('@/lib/sync')['SyncExecutionPipeline'];
let SyncWorker: typeof import('@/lib/sync/worker')['SyncWorker'];
let getSyncJobRepository: typeof import('@/lib/sync/job-queue')['getSyncJobRepository'];
let waitForSyncJob: typeof import('@/lib/sync/job-queue')['waitForSyncJob'];
const connectorIds = new Set<string>();

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function currentMonth(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-monarch-contract-version': '1.0',
    },
  });
}

function installSyntheticFinanceProvider(): void {
  const today = new Date().toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString();
  const budgetPeriod = currentMonth();
  let insightSource: {
    connectorRef: string;
    sourceGeneration: string;
    sourceSequence: number;
    sourceAsOf: string;
    coverageStart: string;
    coverageEnd: string;
    bridgeContractVersion: string;
  } | null = null;
  vi.stubGlobal('fetch', vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (url.origin === 'http://tyrion-operations-ui:3000') {
      if (url.pathname.startsWith('/api/internal/v1/finance/insights/')) {
        if (
          url.pathname === '/api/internal/v1/finance/insights/source-generations'
          && init?.method === 'POST'
        ) {
          insightSource = JSON.parse(String(init.body)) as typeof insightSource;
          return jsonResponse({
            contractVersion: '1.0',
            connectorRef: insightSource!.connectorRef,
            sourceGeneration: insightSource!.sourceGeneration,
            sourceSequence: insightSource!.sourceSequence,
            state: 'staging',
            detectorSetVersion: null,
            policyVersion: null,
          }, 202);
        }
        if (url.pathname.includes('/batches/') && init?.method === 'PUT') {
          const batch = JSON.parse(String(init.body)) as {
            sourceGeneration: string;
            kind: string;
            batchIndex: number;
            digest: string;
          };
          return jsonResponse({
            contractVersion: '1.0',
            sourceGeneration: batch.sourceGeneration,
            kind: batch.kind,
            batchIndex: batch.batchIndex,
            digest: batch.digest,
            state: 'accepted',
          });
        }
        if (url.pathname.endsWith('/commit') && init?.method === 'POST') {
          return jsonResponse({
            contractVersion: '1.0',
            connectorRef: insightSource!.connectorRef,
            sourceGeneration: insightSource!.sourceGeneration,
            sourceSequence: insightSource!.sourceSequence,
            state: 'promoted',
            detectorSetVersion: 'synthetic-detectors-v1',
            policyVersion: 1,
          });
        }
        if (
          url.pathname === '/api/internal/v1/finance/insights/evaluations'
          && init?.method === 'POST'
        ) {
          return jsonResponse({
            contractVersion: '1.0',
            identity: {
              householdScope: 'synthetic-household',
              connectorRef: insightSource!.connectorRef,
              sourceGeneration: insightSource!.sourceGeneration,
              detectorSetVersion: 'synthetic-detectors-v1',
              policyVersion: 1,
            },
            sourceSequence: insightSource!.sourceSequence,
            evaluationSequence: 1,
            acceptedAt: fetchedAt,
            state: 'completed',
            completedAt: fetchedAt,
          }, 202);
        }
        if (
          url.pathname === '/api/internal/v1/finance/insights/occurrences'
          && init?.method === 'GET'
        ) {
          return jsonResponse({
            contractVersion: '1.0',
            items: [],
            nextCursor: null,
          });
        }
        throw new Error(`Unexpected synthetic finance insight request: ${url.pathname}`);
      }
      const request = JSON.parse(String(init?.body)) as {
        expectedPolicyVersion: number;
        items: Array<{ sourceRef: string }>;
      };
      return new Response(JSON.stringify({
        contractVersion: '2.0',
        policyVersion: request.expectedPolicyVersion,
        engineVersion: '2.0.0',
        results: request.items.map((item) => ({
          contractVersion: '2.0',
          sourceRef: item.sourceRef,
          status: 'pending',
          kidId: null,
          confidence: 'none',
          method: 'unassigned',
          explanation: 'Synthetic transaction needs review',
          reviewStatus: 'pending',
          reasons: ['no-match'],
          decisionSource: 'automated',
          policyVersion: request.expectedPolicyVersion,
          engineVersion: '2.0.0',
          evaluatedAt: fetchedAt,
        })),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const base = {
      contractVersion: '1.0',
      provenance: { provider: 'demo', fetchedAt },
    };
    if (url.pathname === '/transactions') {
      const start = url.searchParams.get('start_date')!;
      const end = url.searchParams.get('end_date')!;
      const transactions = start <= today && today <= end
        ? [{
            id: 'synthetic-transaction',
            date: today,
            amount: -12.34,
            merchant: { name: 'Synthetic merchant', logoUrl: null },
            category: { id: 'synthetic-category', name: 'Synthetic category' },
            account: {
              id: 'synthetic-account',
              displayName: 'Synthetic account',
              mask: '0000',
            },
            isPending: false,
            isRecurring: false,
            notes: null,
            tags: ['synthetic'],
            tagReferences: [{ id: 'synthetic-tag', name: 'Synthetic' }],
          }]
        : [];
      return jsonResponse({
        ...base,
        transactions,
        total: transactions.length,
        page: { limit: 500, nextCursor: null },
      });
    }
    if (url.pathname === '/accounts') {
      return jsonResponse({
        ...base,
        accounts: [{
          id: 'synthetic-account',
          displayName: 'Synthetic account',
          type: 'checking',
          mask: '0000',
          institution: 'Synthetic institution',
          currentBalance: 100,
          isActive: true,
        }],
      });
    }
    if (url.pathname === '/category-groups') {
      return jsonResponse({
        ...base,
        categoryGroups: [{ id: 'synthetic-group', name: 'Synthetic group', isActive: true }],
      });
    }
    if (url.pathname === '/categories') {
      return jsonResponse({
        ...base,
        categories: [{
          id: 'synthetic-category',
          name: 'Synthetic category',
          groupId: 'synthetic-group',
          group: 'Synthetic group',
          icon: null,
          isActive: true,
        }],
      });
    }
    if (url.pathname === '/tags') {
      return jsonResponse({
        ...base,
        tags: [{ id: 'synthetic-tag', name: 'Synthetic', isActive: true }],
      });
    }
    if (url.pathname === '/recurring') {
      return jsonResponse({
        ...base,
        recurring: [{
          id: 'synthetic-recurring',
          merchant: 'Synthetic subscription',
          amount: -4.56,
          frequency: 'monthly',
          nextExpectedDate: today,
          account: {
            id: 'synthetic-account',
            displayName: 'Synthetic account',
            mask: '0000',
          },
          category: { id: 'synthetic-category', name: 'Synthetic category' },
        }],
      });
    }
    if (url.pathname === '/budgets') {
      return jsonResponse({
        ...base,
        periodStart: budgetPeriod.start,
        periodEnd: budgetPeriod.end,
        budgets: [{
          category: { id: 'synthetic-category', name: 'Synthetic category' },
          budgeted: 100,
          spent: 12.34,
          remaining: 87.66,
          percentUsed: 12.34,
        }],
      });
    }
    throw new Error(`Unexpected synthetic finance request: ${url.origin}${url.pathname}`);
  }));
}

async function seedConnector(connectorId: string): Promise<void> {
  connectorIds.add(connectorId);
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO connector_configs (
       id, type, name, enabled, sync_mode, capabilities, credentials,
       settings, synced_lists, created_at, updated_at
     ) VALUES (
       $1, 'finance-manager', 'Synthetic finance worker', true, 'poll',
       $2::jsonb, $3::jsonb, $4::jsonb, '[]'::jsonb, $5, $5
     )`,
    [
      connectorId,
      JSON.stringify({
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: false,
        lists: false,
        tags: true,
        tagWriteBack: false,
        listSelectionMode: 'not-applicable',
        notificationOnly: true,
      }),
      JSON.stringify({
        serviceToken: 'synthetic-service-token',
        identityNamespace: IDENTITY_NAMESPACE,
      }),
      JSON.stringify({
        bridgeUrl: 'https://synthetic-finance-provider.test',
        maxRetries: 0,
        householdCurrency: 'USD',
      }),
      now,
    ],
  );
}

async function cleanupConnector(connectorId: string): Promise<void> {
  for (const table of ['notification_delivery_events', 'notification_actions']) {
    await pool.query(
      `DELETE FROM ${table} WHERE notification_id IN (
         SELECT id FROM notifications WHERE connector_instance_id = $1
       )`,
      [connectorId],
    );
  }
  await pool.query('DELETE FROM my_day_items WHERE task_id IN (SELECT id FROM tasks WHERE connector_instance_id = $1)', [connectorId]);
  await pool.query('DELETE FROM my_day_exclusions WHERE task_id IN (SELECT id FROM tasks WHERE connector_instance_id = $1)', [connectorId]);
  await pool.query('DELETE FROM notifications WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM tasks WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM finance_attention_repair_audit WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM finance_mutation_audit WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM finance_attribution_exceptions WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM finance_attribution_subjects WHERE connector_id = $1', [connectorId]);
  for (const table of [
    'finance_insight_transaction_projection_facts',
    'finance_insight_transaction_projection_windows',
    'finance_insight_transaction_projection_state',
    'finance_insight_transaction_window_proofs',
    'finance_insight_transaction_backfill_plans',
    'finance_insight_cutovers',
    'finance_insight_publication_delivery',
    'finance_insight_publication_state',
    'finance_insight_publications',
    'finance_insight_occurrence_cache_state',
    'finance_insight_occurrences',
    'finance_accounts',
    'finance_category_groups',
    'finance_categories',
    'finance_tags',
    'finance_recurring_obligations',
    'finance_budget_snapshots',
    'finance_dataset_sync_state',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE connector_id = $1`, [connectorId]);
  }
  await pool.query('DELETE FROM finance_transactions WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM finance_sync_state WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM sync_log WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM sync_jobs WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM connector_operation_leases WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM connector_configs WHERE id = $1', [connectorId]);
}

async function executeWithWorker(connectorId: string): Promise<SyncResult> {
  const pipeline = new SyncExecutionPipeline();
  const worker = new SyncWorker(
    (id, options) => pipeline.runSyncLocally(id, options),
    { ownerId: `finance-worker-${randomUUID()}`, pollIntervalMs: 5 },
  );
  const repository = await getSyncJobRepository();
  const job = await repository.enqueue(connectorId, {
    full: true,
    source: 'api',
    maxAttempts: 1,
    durationBudgetMs: 120_000,
  });
  worker.start();
  try {
    return await waitForSyncJob(job, { timeoutMs: 120_000 });
  } finally {
    await worker.stop(10_000);
  }
}

describePostgres('PostgreSQL finance worker queue-execution smoke', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_POSTGRES_URL = connectionString;
    process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString!).searchParams.get('sslmode')
      ?? 'disable';
    process.env.MC_MODE = 'live';
    process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION = '7';
    process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED = 'true';
    const runtime = await import('@/db/runtime');
    await runtime.initializeRuntimeDatabase();
    pool = runtime.getPostgresPersistenceBackend().context.pool;
    shutdownRuntimeDatabase = runtime.shutdownRuntimeDatabase;
    ({ SyncExecutionPipeline } = await import('@/lib/sync'));
    ({ SyncWorker } = await import('@/lib/sync/worker'));
    ({ getSyncJobRepository, waitForSyncJob } = await import('@/lib/sync/job-queue'));
  }, 120_000);

  beforeEach(() => {
    sqliteTouch.mockClear();
    installSyntheticFinanceProvider();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const connectorId of connectorIds) {
      await cleanupConnector(connectorId);
    }
    connectorIds.clear();
  });

  it('runs the registered finance connector through restart-safe, idempotent worker execution', async () => {
    const connectorId = `finance-worker-${randomUUID()}`;
    await seedConnector(connectorId);

    const first = await executeWithWorker(connectorId);
    const second = await executeWithWorker(connectorId);

    expect(first).toMatchObject({ connectorId, success: true });
    expect(second).toMatchObject({ connectorId, success: true });
    const state = await pool.query<{
      transactionCount: string;
      publicationCount: string;
      notificationCount: string;
      deliveryCount: string;
      insightDeliveryCount: string;
      successfulRuns: string;
    }>(
      `SELECT
         (SELECT count(*) FROM finance_transactions
          WHERE connector_instance_id = $1) AS "transactionCount",
         (SELECT count(*) FROM finance_insight_publications
          WHERE connector_id = $1) AS "publicationCount",
         (SELECT count(*) FROM notifications
          WHERE connector_instance_id = $1) AS "notificationCount",
         (SELECT count(*) FROM notification_delivery_events
          WHERE notification_id IN (
            SELECT id FROM notifications WHERE connector_instance_id = $1
          )) AS "deliveryCount",
         (SELECT count(*) FROM finance_insight_publication_delivery
          WHERE connector_id = $1 AND stage = 'evaluation-requested') AS "insightDeliveryCount",
         (SELECT count(*) FROM sync_log
          WHERE connector_id = $1 AND success = true) AS "successfulRuns"`,
      [connectorId],
    );
    expect(state.rows[0]).toMatchObject({
      transactionCount: '1',
      publicationCount: '1',
      notificationCount: '1',
      insightDeliveryCount: '1',
      successfulRuns: '2',
    });
    expect(Number(state.rows[0].deliveryCount)).toBeGreaterThan(0);
    expect(sqliteTouch).not.toHaveBeenCalled();
  }, 180_000);

  it('fences a released finance attempt and completes its retry with a new worker', async () => {
    const connectorId = `finance-worker-${randomUUID()}`;
    await seedConnector(connectorId);
    const repository = await getSyncJobRepository();
    const queued = await repository.enqueue(connectorId, {
      full: true,
      source: 'api',
      maxAttempts: 2,
      durationBudgetMs: 120_000,
    });
    const firstOwner = `finance-worker-stale-${randomUUID()}`;
    const pipeline = new SyncExecutionPipeline();
    let releaseFirstAttempt!: (value: {
      job: SyncJob;
      result: SyncResult;
    }) => void;
    const firstAttemptReleased = new Promise<{
      job: SyncJob;
      result: SyncResult;
    }>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const firstWorker = new SyncWorker(
      async (id, options) => {
        const result = await pipeline.runSyncLocally(id, options);
        const job = await repository.get(options.jobId!);
        if (!job) throw new Error('Synthetic finance attempt disappeared before release');
        if (!await repository.release(job.id, firstOwner, 'synthetic worker restart')) {
          throw new Error('Synthetic finance attempt could not be released');
        }
        await pool.query(
          `UPDATE sync_jobs SET available_at = now() + interval '30 seconds' WHERE id = $1`,
          [job.id],
        );
        releaseFirstAttempt({ job, result });
        return result;
      },
      { ownerId: firstOwner, pollIntervalMs: 5 },
    );
    firstWorker.start();
    const staleAttempt = await firstAttemptReleased;
    await firstWorker.stop(10_000);

    expect(staleAttempt.job).toMatchObject({ id: queued.id, attempt: 1 });
    expect(staleAttempt.result).toMatchObject({ connectorId, success: true });
    await expect(repository.finalizeSuccess(
      staleAttempt.job,
      firstOwner,
      staleAttempt.result,
    )).rejects.toThrow(/ownership was lost/);

    await pool.query(
      `UPDATE sync_jobs SET available_at = now() - interval '1 second' WHERE id = $1`,
      [queued.id],
    );
    const retryWorker = new SyncWorker(
      (id, options) => pipeline.runSyncLocally(id, options),
      { ownerId: `finance-worker-retry-${randomUUID()}`, pollIntervalMs: 5 },
    );
    retryWorker.start();
    const retryResult = await waitForSyncJob(queued, { timeoutMs: 120_000 });
    await retryWorker.stop(10_000);

    expect(retryResult).toMatchObject({ connectorId, success: true });
    const completedJob = await repository.get(queued.id);
    expect(completedJob).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
    const state = await pool.query<{
      transactionCount: string;
      publicationCount: string;
      successfulRuns: string;
    }>(
      `SELECT
         (SELECT count(*) FROM finance_transactions
          WHERE connector_instance_id = $1) AS "transactionCount",
         (SELECT count(*) FROM finance_insight_publications
          WHERE connector_id = $1) AS "publicationCount",
         (SELECT count(*) FROM sync_log
          WHERE connector_id = $1 AND success = true) AS "successfulRuns"`,
      [connectorId],
    );
    expect(state.rows[0]).toMatchObject({
      transactionCount: '1',
      publicationCount: '1',
      successfulRuns: '1',
    });
    expect(sqliteTouch).not.toHaveBeenCalled();
  }, 180_000);
});

afterAll(async () => {
  if (pool) {
    for (const connectorId of connectorIds) {
      await cleanupConnector(connectorId);
    }
  }
  if (shutdownRuntimeDatabase) await shutdownRuntimeDatabase();
  restoreEnvironment('MC_DATABASE_BACKEND', ORIGINAL_BACKEND);
  restoreEnvironment('MC_POSTGRES_URL', ORIGINAL_POSTGRES_URL);
  restoreEnvironment('MC_POSTGRES_SSL_MODE', ORIGINAL_SSL_MODE);
  restoreEnvironment('MC_MODE', ORIGINAL_MODE);
  restoreEnvironment('TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION', ORIGINAL_POLICY_VERSION);
  restoreEnvironment(
    'TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED',
    ORIGINAL_SHADOW_INGEST,
  );
});
