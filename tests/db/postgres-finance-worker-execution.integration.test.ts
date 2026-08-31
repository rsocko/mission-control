import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const { sqliteEvaluation, sqliteTouch } = vi.hoisted(() => ({
  sqliteEvaluation: vi.fn(),
  sqliteTouch: vi.fn(),
}));

vi.mock('@/db', () => {
  sqliteEvaluation();
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

async function waitFor(
  assertion: () => Promise<void>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Timed out waiting for packaged PostgreSQL worker', { cause: lastError });
}

function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Packaged PostgreSQL worker did not stop')),
      timeoutMs,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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
  const recoverySourcePattern = `finance-connection:${connectorId}:%`;
  await pool.query(
    `DELETE FROM my_day_items WHERE task_id IN (
       SELECT id FROM tasks WHERE source_id LIKE $1
     )`,
    [recoverySourcePattern],
  );
  await pool.query('DELETE FROM tasks WHERE source_id LIKE $1', [recoverySourcePattern]);
  await pool.query('DELETE FROM notifications WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM finance_connection_outages WHERE connector_id = $1', [connectorId]);
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
      projectionStatus: string | null;
      projectionError: string | null;
      publicationOutcome: string | null;
      publicationError: string | null;
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
         (SELECT status FROM finance_insight_transaction_projection_state
          WHERE connector_id = $1) AS "projectionStatus",
         (SELECT last_error_code FROM finance_insight_transaction_projection_state
          WHERE connector_id = $1) AS "projectionError",
         (SELECT last_capture_outcome FROM finance_insight_publication_state
          WHERE connector_id = $1) AS "publicationOutcome",
         (SELECT last_error_code FROM finance_insight_publication_state
          WHERE connector_id = $1) AS "publicationError",
         (SELECT count(*) FROM sync_log
          WHERE connector_id = $1 AND success = true) AS "successfulRuns"`,
      [connectorId],
    );
    expect(state.rows[0]).toMatchObject({
      transactionCount: '1',
      publicationCount: '1',
      notificationCount: '1',
      insightDeliveryCount: '1',
      projectionStatus: 'succeeded',
      projectionError: null,
      publicationOutcome: 'idempotent',
      publicationError: null,
      successfulRuns: '2',
    });
    expect(Number(state.rows[0].deliveryCount)).toBeGreaterThan(0);
    expect(sqliteTouch).not.toHaveBeenCalled();
  }, 180_000);

  it('starts every registered scheduler family with the complete PostgreSQL composition', async () => {
    const { getWorkerPersistenceRepositories } = await import('@/lib/persistence/worker-runtime');
    const { taskReminderScheduler } = await import('@/lib/push/task-reminder-scheduler');
    const { financeConnectionRecoveryScheduler } = await import(
      '@/lib/connectors/monarch-money/recovery-scheduler'
    );
    const { triageSyncScheduler } = await import('@/lib/triage/scheduler');
    const { houstonMemoryRetentionScheduler } = await import('@/lib/houston-memory/retention');
    const { generateWorkerHealthSnapshot } = await import('@/lib/telemetry/health-snapshot');
    const repositories = await getWorkerPersistenceRepositories();

    expect(repositories).toMatchObject({
      connectors: expect.anything(),
      syncRuns: expect.anything(),
      execution: expect.anything(),
      github: expect.anything(),
      connectorState: expect.anything(),
      notificationDelivery: expect.anything(),
      reminders: expect.anything(),
      triage: expect.anything(),
      finance: expect.objectContaining({ recovery: expect.anything() }),
    });

    await taskReminderScheduler.start();
    await triageSyncScheduler.initialize();
    await financeConnectionRecoveryScheduler.start();
    houstonMemoryRetentionScheduler.start();
    await generateWorkerHealthSnapshot(`postgres-final-worker-${randomUUID()}`);

    taskReminderScheduler.stop();
    financeConnectionRecoveryScheduler.stop();
    triageSyncScheduler.stopAll();
    houstonMemoryRetentionScheduler.stop();
    expect(sqliteEvaluation).not.toHaveBeenCalled();
    expect(sqliteTouch).not.toHaveBeenCalled();
  }, 120_000);

  it('starts, restarts, and gracefully stops the packaged worker without loading SQLite', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'mc-postgres-worker-'));
    const instancePath = join(runtimeRoot, 'worker-instance');
    const sqlitePath = join(runtimeRoot, 'poison.db');
    const poisonPath = join(runtimeRoot, 'poison-sqlite.cjs');
    await writeFile(poisonPath, `
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'better-sqlite3' || request.includes('sqlite-')) {
          throw new Error('Packaged PostgreSQL worker evaluated SQLite: ' + request);
        }
        return load.call(this, request, parent, isMain);
      };
    `);

    const runWorker = async () => {
      const output: Buffer[] = [];
      const child = spawn(process.execPath, [
        '--require',
        poisonPath,
        'dist/sync-worker.cjs',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MC_DATABASE_BACKEND: 'postgres',
          MC_POSTGRES_URL: connectionString!,
          MC_POSTGRES_SSL_MODE: process.env.MC_POSTGRES_SSL_MODE,
          MC_DB_PATH: sqlitePath,
          MC_WORKER_INSTANCE_FILE: instancePath,
          MC_TELEMETRY_INTERVAL_MS: '100',
          MC_DEPLOYMENT_REVISION: 'postgres-final-worker-smoke',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));
      try {
        await waitFor(async () => {
          const logs = Buffer.concat(output).toString();
          if (child.exitCode !== null) {
            throw new Error(logs || `Worker exited with code ${child.exitCode}`);
          }
          const instanceId = (await readFile(instancePath, 'utf8')).trim();
          if (!instanceId || !logs.includes('triage auto-sync scheduler initialized')) {
            throw new Error(logs || 'Worker startup is incomplete');
          }
        }, 60_000);
        child.kill('SIGTERM');
        const exitCode = await waitForExit(child);
        if (exitCode !== 0) {
          throw new Error(Buffer.concat(output).toString());
        }
        await expect(stat(instancePath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await waitForExit(child).catch(() => undefined);
        }
      }
    };

    try {
      await runWorker();
      await runWorker();
      await expect(stat(sqlitePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it('recovers and fences a durable finance outage episode idempotently', async () => {
    const connectorId = `finance-recovery-${randomUUID()}`;
    await seedConnector(connectorId);
    const { finance } = await (
      await import('@/lib/persistence/worker-runtime')
    ).getWorkerPersistenceRepositories();
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const unavailable = { kind: 'unavailable' as const, errorCode: 'synthetic_unavailable' };

    await finance.recovery.reconcileObservation({
      connectorId,
      observation: unavailable,
      now: startedAt,
    });
    const escalated = await finance.recovery.reconcileObservation({
      connectorId,
      observation: unavailable,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000),
    });
    const episode = await finance.recovery.getActiveEpisode(connectorId);

    expect(escalated).toMatchObject({
      status: 'degraded',
      notificationCreated: true,
      taskCreated: true,
    });
    expect(episode).not.toBeNull();
    await expect(finance.recovery.recordBoundedSyncSuccess({
      connectorId,
      episodeId: 'stale-episode',
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000 + 1),
    })).resolves.toBe(false);
    await expect(finance.recovery.recordBoundedSyncSuccess({
      connectorId,
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000 + 2),
    })).resolves.toBe(true);
    await expect(finance.recovery.settleEpisode({
      connectorId,
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000 + 3),
    })).resolves.toBe(true);
    await expect(finance.recovery.settleEpisode({
      connectorId,
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000 + 4),
    })).resolves.toBe(false);

    const state = await pool.query<{
      outageStatus: string;
      notificationState: string;
      taskStatus: string;
      myDayCount: string;
    }>(`
      SELECT
        (SELECT status FROM finance_connection_outages WHERE connector_id = $1)
          AS "outageStatus",
        (SELECT state FROM notifications WHERE connector_instance_id = $1 LIMIT 1)
          AS "notificationState",
        (SELECT status FROM tasks WHERE source_id LIKE $2 LIMIT 1)
          AS "taskStatus",
        (SELECT count(*) FROM my_day_items WHERE task_id IN (
          SELECT id FROM tasks WHERE source_id LIKE $2
        )) AS "myDayCount"
    `, [connectorId, `finance-connection:${connectorId}:%`]);
    expect(state.rows[0]).toEqual({
      outageStatus: 'recovered',
      notificationState: 'resolved',
      taskStatus: 'done',
      myDayCount: '0',
    });
    expect(sqliteEvaluation).not.toHaveBeenCalled();
    expect(sqliteTouch).not.toHaveBeenCalled();
  }, 120_000);

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
