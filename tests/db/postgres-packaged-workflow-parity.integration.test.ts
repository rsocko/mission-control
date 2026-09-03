import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('drizzle-orm');
import type {
  CopilotLifecycleClient,
  CopilotLifecycleSession,
} from '@/lib/ai/copilot-lifecycle-contracts';
import type { ConnectorNotificationCommand } from '@/db/persistence/connector-execution';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.mock('@/db', () => {
  throw new Error('Packaged PostgreSQL workflow parity evaluated SQLite');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const integration = describe.skipIf(!connectionString);
const suffix = randomUUID();
const prefix = `whole-worker-${suffix}`;
const originalEnvironment = { ...process.env };
let runtime: typeof import('@/db/runtime');
let workerPersistence: Awaited<ReturnType<
  typeof import('@/lib/persistence/worker-runtime').getWorkerPersistenceRepositories
>>;
let planningMarkerStartedAt: string | null = null;

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      cause = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Timed out waiting for packaged workflow parity', { cause });
}

function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Packaged workflow worker did not exit')),
      timeoutMs,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function enrichmentCommand(id: string): ConnectorNotificationCommand {
  return {
    input: {
      id,
      sourceId: `${prefix}:enrichment`,
      connectorType: 'custom-rest',
      connectorInstanceId: `${prefix}:connector`,
      title: 'Review requested',
      body: `Review ${prefix}`,
      level: 'fyi',
      category: 'development',
      templateKey: null,
      readState: 'unread',
      sourceState: 'active',
      sourceActivityAt: null,
      sourceActivityKey: `${prefix}:activity`,
      reopenPolicy: 'handled',
      occurrenceKey: `${prefix}:occurrence`,
      isActionable: true,
      primaryActionId: null,
      receivedAt: new Date().toISOString(),
      sortAt: new Date().toISOString(),
      relatedTaskId: null,
      relatedProjectId: null,
      relatedEntityType: null,
      relatedEntityId: null,
      navigationTarget: null,
      metadata: {},
      presentation: { reason: 'review_requested' },
    },
    actions: [],
    enrichment: {
      sourceRevision: `${prefix}:r1`,
      payload: {
        notificationId: id,
        title: 'Review requested',
        body: `Review ${prefix}`,
        connectorType: 'custom-rest',
        category: 'development',
        metadata: {},
        presentation: { reason: 'review_requested' },
      },
    },
  };
}

integration('packaged PostgreSQL all-six workflow parity', () => {
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_POSTGRES_URL = connectionString;
    process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString!).searchParams.get('sslmode')
      ?? 'disable';
    process.env.MC_POSTGRES_APPLICATION_NAME = `${prefix}-controller`;
    process.env.MC_AI_PROVIDER_SESSION_KEY = Buffer.alloc(32, 9).toString('base64');
    runtime = await import('@/db/runtime');
    await runtime.initializeRuntimeDatabase();
    workerPersistence = await (
      await import('@/lib/persistence/worker-runtime')
    ).getWorkerPersistenceRepositories();
    if (!existsSync('dist/sync-worker-integration.cjs')) {
      const build = spawnSync(process.execPath, ['scripts/build-sync-worker.mjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      if (build.status !== 0) {
        throw new Error(build.stderr || build.stdout || 'Packaged worker build failed');
      }
    }
    const [productionArtifact, integrationArtifact] = await Promise.all([
      readFile('dist/sync-worker.cjs', 'utf8'),
      readFile('dist/sync-worker-integration.cjs', 'utf8'),
    ]);
    for (const marker of [
      'runPackagedSyncWorker',
      'createPackagedDurableAiRuntime',
      'createPackagedPostgresSemanticRuntime',
      'PostgresWorkerProcessingLatch',
    ]) {
      expect(productionArtifact).toContain(marker);
      expect(integrationArtifact).toContain(marker);
    }
  }, 120_000);

  afterAll(async () => {
    const liveChildren = [...children].filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    for (const child of liveChildren) child.kill('SIGKILL');
    await Promise.allSettled(liveChildren.map((child) => waitForExit(child, 10_000)));
    try {
      if (runtime) {
        const pool = runtime.getPostgresPersistenceBackend().context.pool;
        try {
        await pool.query(
          `DELETE FROM notification_delivery_events
           WHERE notification_id IN (
             SELECT id FROM notifications WHERE source_id LIKE $1
           )`,
          [`${prefix}%`],
        );
        await pool.query(
          `DELETE FROM notification_actions
           WHERE notification_id IN (
             SELECT id FROM notifications WHERE source_id LIKE $1
           )`,
          [`${prefix}%`],
        );
        await pool.query('DELETE FROM notifications WHERE source_id LIKE $1', [`${prefix}%`]);
        await pool.query(
          `DELETE FROM event_outbox WHERE payload ->> 'connectorId' = $1 OR stable_key LIKE $2`,
          [`${prefix}:connector`, `${prefix}%`],
        );
        await pool.query('DELETE FROM outbound_webhooks WHERE id = $1', [`${prefix}:webhook`]);
        await pool.query(
          'DELETE FROM sync_job_events WHERE connector_id = $1',
          [`${prefix}:connector`],
        );
        await pool.query('DELETE FROM sync_log WHERE connector_id = $1', [`${prefix}:connector`]);
        await pool.query('DELETE FROM sync_jobs WHERE connector_id = $1', [`${prefix}:connector`]);
        await pool.query('DELETE FROM sync_schedules WHERE connector_id = $1', [`${prefix}:connector`]);
        await pool.query(
          'DELETE FROM connector_operation_leases WHERE connector_id = $1',
          [`${prefix}:connector`],
        );
        await pool.query(
          'DELETE FROM semantic_index_identities WHERE model = $1',
          [`${prefix}:embedding`],
        );
        await pool.query('DELETE FROM task_history_events WHERE task_id LIKE $1', [`${prefix}%`]);
        if (planningMarkerStartedAt) {
          await pool.query(
            `DELETE FROM task_history_events
             WHERE task_id = '__planning-signal-finalizer__'
               AND event_type = 'planning_signal_finalized'
               AND recorded_at >= $1`,
            [planningMarkerStartedAt],
          );
        }
        await pool.query('DELETE FROM my_day_items WHERE task_id LIKE $1', [`${prefix}%`]);
        await pool.query('DELETE FROM task_projects WHERE project_id = $1', [`${prefix}:project`]);
        await pool.query(
          'DELETE FROM project_auto_include_exclusions WHERE project_id = $1',
          [`${prefix}:project`],
        );
        await pool.query('DELETE FROM hub_projects WHERE id = $1', [`${prefix}:project`]);
        await pool.query(
          'DELETE FROM task_tags WHERE task_id IN (SELECT id FROM tasks WHERE id LIKE $1)',
          [`${prefix}%`],
        );
        await pool.query('DELETE FROM tasks WHERE id LIKE $1', [`${prefix}%`]);
        await pool.query(
          'DELETE FROM source_lists WHERE connector_instance_id = $1',
          [`${prefix}:connector`],
        );
        await pool.query('DELETE FROM connector_configs WHERE id = $1', [`${prefix}:connector`]);
        await pool.query('DELETE FROM ai_runs WHERE id LIKE $1', [`${prefix}%`]);
        } finally {
          await runtime.shutdownRuntimeDatabase();
        }
      }
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnvironment)) delete process.env[key];
      }
      Object.assign(process.env, originalEnvironment);
    }
  }, 120_000);

  it('recovers every in-flight family through the normal packaged composition', async () => {
    const pool = runtime.getPostgresPersistenceBackend().context.pool;
    const requests = {
      connectorTasks: 0,
      connectorAlerts: 0,
      outbox: 0,
      enrichment: 0,
      embedding: 0,
      copilotCreate: 0,
      copilotResume: 0,
      copilotSend: 0,
      copilotDelete: 0,
    };
    const unexpectedLoopbackPaths = new Set<string>();
    const outboxSignatures: string[] = [];
    let holdFirstAttempts = true;
    const held = new Set<ServerResponse>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString();
        const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
        const hold = () => {
          held.add(response);
          response.on('close', () => held.delete(response));
        };
        const json = (value: unknown, status = 200) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        if (request.url?.startsWith('/tasks')) {
          requests.connectorTasks += 1;
          return json([
            {
              id: `${prefix}:planning`,
              title: `${prefix} planning task`,
              status: 'todo',
              priority: 'normal',
              dueDate: '2035-01-01',
              createdAt: '2034-01-01T00:00:00.000Z',
              updatedAt: '2034-01-01T00:00:00.000Z',
            },
            {
              id: `${prefix}/repo:42`,
              title: `${prefix} semantic task`,
              status: 'todo',
              priority: 'normal',
              createdAt: '2034-01-01T00:00:00.000Z',
              updatedAt: '2034-01-01T00:00:00.000Z',
            },
          ]);
        }
        if (request.url?.startsWith('/alerts')) {
          requests.connectorAlerts += 1;
          return json([{
            id: `${prefix}:alert`,
            title: 'Review requested',
            body: `Review ${prefix}/repo#42`,
            severity: 'fyi',
            category: 'development',
            receivedAt: '2034-01-01T00:00:00.000Z',
          }]);
        }
        if (request.url === '/outbox') {
          requests.outbox += 1;
          outboxSignatures.push(String(request.headers['x-mc-signature'] ?? ''));
          if (holdFirstAttempts && requests.outbox === 1) return hold();
          return json({}, 204);
        }
        if (request.url === '/v1/responses') {
          if (
            request.method !== 'POST'
            || body.model !== 'loopback'
            || !Array.isArray(body.input)
          ) {
            unexpectedLoopbackPaths.add('/v1/responses:invalid-request');
            return json({}, 400);
          }
          requests.enrichment += 1;
          if (holdFirstAttempts && requests.enrichment === 1) return hold();
          const content = JSON.stringify({
            summary: 'Durably enriched',
            suggestedAction: 'open_url',
            contextTags: ['parity'],
            urgencyBoost: false,
          });
          return json({
            id: `${prefix}:response`,
            object: 'response',
            created_at: 1,
            status: 'completed',
            model: 'loopback',
            output: [{
              id: `${prefix}:message`,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{
                type: 'output_text',
                text: content,
                annotations: [],
              }],
            }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          });
        }
        if (request.url === '/v1/embeddings') {
          const input = String(body.input ?? '');
          if (input.includes(prefix)) {
            requests.embedding += 1;
            if (holdFirstAttempts && requests.embedding === 1) return hold();
          }
          return json({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
            model: `${prefix}:embedding`,
            usage: { prompt_tokens: 1, total_tokens: 1 },
          });
        }
        if (request.url === '/create') {
          requests.copilotCreate += 1;
          return json({ sessionId: `${prefix}:provider-session` });
        }
        if (request.url === '/resume') {
          requests.copilotResume += 1;
          if (holdFirstAttempts && requests.copilotResume === 1) return hold();
          return json({});
        }
        if (request.url === '/send') {
          requests.copilotSend += 1;
          return json({ content: 'loopback complete' });
        }
        if (request.url === '/delete') {
          requests.copilotDelete += 1;
          return json({});
        }
        if (request.url === '/abort' || request.url === '/disconnect') return json({});
        unexpectedLoopbackPaths.add(request.url?.split('?')[0] ?? '<missing>');
        return json({}, 404);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const controllerRequest = async <T>(
      operation: string,
      payload: Record<string, unknown>,
    ): Promise<T> => {
      const response = await fetch(`${baseUrl}/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`Copilot integration controller rejected ${operation}`);
      }
      return await response.json() as T;
    };
    const controllerSession = (sessionId: string): CopilotLifecycleSession => ({
      sessionId,
      async sendAndWait(prompt) {
        return {
          data: await controllerRequest<{ content: string }>('send', {
            sessionId,
            promptLength: prompt.length,
          }),
        };
      },
      async abort() {
        await controllerRequest('abort', { sessionId });
      },
      async disconnect() {
        await controllerRequest('disconnect', { sessionId });
      },
    });
    const controllerClient: CopilotLifecycleClient = {
      async createSession() {
        const created = await controllerRequest<{ sessionId: string }>('create', {});
        return controllerSession(created.sessionId);
      },
      async resumeSession(sessionId) {
        await controllerRequest('resume', { sessionId });
        return controllerSession(sessionId);
      },
      async deleteSession(sessionId) {
        await controllerRequest('delete', { sessionId });
      },
    };
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'mc-whole-worker-'));
    const readyFile = join(runtimeRoot, 'worker-instance');
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
    const output: Buffer[] = [];
    const settings = (
      await import('@/lib/persistence/runtime')
    ).getCorePersistenceRepositories().settings;
    const [savedAiConfig, savedRoutingPolicy] = await Promise.all([
      settings.get('ai_provider_config'),
      settings.get('ai_routing_policy'),
    ]);
    const startWorker = () => {
      const child = spawn(process.execPath, [
        '--require',
        poisonPath,
        'dist/sync-worker-integration.cjs',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MC_DATABASE_BACKEND: 'postgres',
          MC_POSTGRES_URL: connectionString!,
          MC_TEST_POSTGRES_URL: connectionString!,
          MC_POSTGRES_SSL_MODE: new URL(connectionString!).searchParams.get('sslmode')
            ?? 'disable',
          MC_POSTGRES_APPLICATION_NAME: `${prefix}-worker`,
          MC_DB_PATH: sqlitePath,
          MC_WORKER_INSTANCE_FILE: readyFile,
          MC_PACKAGED_WORKER_INTEGRATION: 'postgres-whole-worker',
          MC_COPILOT_TEST_CONTROLLER_URL: `${baseUrl}/`,
          MC_AI_PROVIDER_SESSION_KEY: Buffer.alloc(32, 9).toString('base64'),
          MC_AI_RUN_WORKER_POLL_MS: '100',
          MC_AI_RUN_LEASE_MS: '50000',
          MC_NOTIFICATION_ENRICHMENT_LEASE_MS: '4000',
          MC_NOTIFICATION_ENRICHMENT_TIMEOUT_MS: '60000',
          MC_SEMANTIC_EMBEDDING_TIMEOUT_MS: '60000',
          MC_SYNC_WORKER_POLL_MS: '100',
          MC_SEMANTIC_WORKER_POLL_MS: '100',
          MC_SEMANTIC_WORKER_BUSY_POLL_MS: '50',
          MC_SEMANTIC_WORKER_BATCH_SIZE: '1',
          MC_SEMANTIC_WORKER_CONCURRENCY: '1',
          MC_SEMANTIC_INTENT_LEASE_MS: '4000',
          MC_SEMANTIC_RUN_LEASE_MS: '4000',
          MC_COPILOT_REQUEST_TIMEOUT_MS: '50000',
          MC_COPILOT_IDLE_TIMEOUT_MS: '5000',
          MC_COPILOT_SESSION_OPERATION_TIMEOUT_MS: '50000',
          MC_COPILOT_CLEANUP_TIMEOUT_MS: '5000',
          MC_COPILOT_LEASE_MS: '55000',
          AI_PROVIDER: 'ollama',
          AI_MODEL: 'loopback',
          AI_BASE_URL: `${baseUrl}/v1`,
          AI_SEMANTIC_SEARCH_ENABLED: 'true',
          AI_EMBEDDING_PROVIDER: 'ollama',
          AI_EMBEDDING_MODEL: `${prefix}:embedding`,
          AI_EMBEDDING_BASE_URL: `${baseUrl}/v1`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));
      child.once('exit', () => children.delete(child));
      return child;
    };

    try {
      await settings.set('ai_provider_config', {
        provider: 'ollama',
        model: 'loopback',
        baseUrl: `${baseUrl}/v1`,
        semanticSearchEnabled: true,
        embeddingProvider: 'ollama',
        embeddingModel: `${prefix}:embedding`,
        embeddingBaseUrl: `${baseUrl}/v1`,
      });
      await settings.delete('ai_routing_policy');
      const now = new Date().toISOString();
      planningMarkerStartedAt = now;
      const localToday = (
        await import('@/lib/utils/date')
      ).getLocalToday();
      const previousDay = new Date(`${localToday}T12:00:00Z`);
      previousDay.setUTCDate(previousDay.getUTCDate() - 1);
      const planningDate = previousDay.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, capabilities, credentials, settings,
           synced_lists, created_at, updated_at
         ) VALUES ($1, 'custom-rest', $1, true, '{}'::jsonb, '{}'::jsonb,
           $2::jsonb, '[]'::jsonb, $3, $3)`,
        [
          `${prefix}:connector`,
          JSON.stringify({
            baseUrl,
            tasksEndpoint: '/tasks',
            alertsEndpoint: '/alerts',
            headers: {},
            taskMapping: {
              id: 'id',
              title: 'title',
              status: 'status',
              priority: 'priority',
              dueDate: 'dueDate',
              createdAt: 'createdAt',
              updatedAt: 'updatedAt',
            },
          }),
          now,
        ],
      );
      await pool.query(
        `INSERT INTO tasks (
           id, source_id, connector_type, connector_instance_id, title, status,
           priority, due_date, created_at, updated_at, last_synced_at
         ) VALUES
           ($1, $1, 'custom-rest', $3, $1, 'todo', 'normal', '2035-01-01', $5, $5, $5),
           ($2, $4, 'custom-rest', $3, $2, 'todo', 'normal', NULL, $5, $5, $5)`,
        [
          `${prefix}:planning`,
          `${prefix}:semantic`,
          `${prefix}:connector`,
          `${prefix}/repo:42`,
          now,
        ],
      );
      await pool.query(
        `INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
         VALUES ($1, $2, $3, $4, false, 1)`,
        [`${prefix}:my-day`, `${prefix}:planning`, planningDate, now],
      );
      await pool.query(
        `INSERT INTO hub_projects (
           id, name, color, source_bindings, auto_include_rules, kanban_columns,
           default_view, status, hidden, sort_order, hierarchy_revision, metadata,
           created_at, updated_at
         ) VALUES ($1, $1, '#3b82f6', '[]'::jsonb, $2::jsonb, '[]'::jsonb,
           'list', 'active', false, 0, 0, $3::jsonb, $4, $4)`,
        [
          `${prefix}:project`,
          JSON.stringify([{ type: 'connector', value: `${prefix}:connector` }]),
          JSON.stringify({ repository: `${prefix}/repo` }),
          now,
        ],
      );
      await pool.query(
        `INSERT INTO outbound_webhooks (id, name, url, secret, event_types, enabled, created_at)
         VALUES ($1, $1, $2, 'loopback-signing-key', '["sync.completed"]'::jsonb, true, $3)`,
        [`${prefix}:webhook`, `${baseUrl}/outbox`, now],
      );

      const planning = await workerPersistence.planningSignals.append({
        taskId: `${prefix}:planning`,
        eventType: 'my_day_committed',
        date: planningDate,
        occurredAt: now,
        provenance: 'whole-worker-test',
      });
      expect(planning).toBe(true);
      await pool.query(
        `DELETE FROM task_history_events
         WHERE task_id = '__planning-signal-finalizer__'
           AND event_type = 'planning_signal_finalized'
           AND recorded_at >= $1`,
        [new Date(Date.now() - 10 * 60_000).toISOString()],
      );

      const syncJobs = await (
        await import('@/lib/sync/job-runtime')
      ).getSyncJobRepository();
      const syncJob = await syncJobs.enqueue(`${prefix}:connector`, {
        full: true,
        source: 'api',
      });
      await expect(syncJobs.enqueue(`${prefix}:connector`, {
        full: true,
        source: 'api',
      })).resolves.toMatchObject({ id: syncJob.id, status: 'queued' });
      await workerPersistence.execution.notifications.ingest([
        enrichmentCommand(`${prefix}:enrichment`),
      ]);
      const durableRuns = await (
        await import('@/lib/ai/durable-runs/runtime')
      ).getDurableAiRunRepository();
      await durableRuns.createRun({
        id: `${prefix}:ai`,
        idempotencyKey: `${prefix}:ai`,
        featureId: 'whole-worker-parity',
        sensitivity: 'standard',
        executionRoute: 'direct-copilot-sdk',
        requestedProvider: 'github-copilot',
        requestedModel: 'loopback',
        correlationId: `${prefix}:correlation`,
        timeoutMs: 240_000,
        notifyOnCompletion: true,
      });
      const [
        { createDurableCopilotPersistence },
        { CopilotSessionLifecycleManager },
      ] = await Promise.all([
        import('@/lib/ai/durable-runs/copilot-adapter'),
        import('@/lib/ai/copilot-session-lifecycle'),
      ]);
      const setupOwner = `${prefix}:setup`;
      const setupPersistence = await createDurableCopilotPersistence(
        setupOwner,
        durableRuns,
      );
      const setupLifecycle = new CopilotSessionLifecycleManager(
        controllerClient,
        setupPersistence.store,
        {
          maxConcurrentSessions: Number.MAX_SAFE_INTEGER,
          requestTimeoutMs: 50_000,
          idleTimeoutMs: 5_000,
          cleanupTimeoutMs: 5_000,
          sessionOperationTimeoutMs: 50_000,
          leaseDurationMs: 55_000,
          workerId: setupOwner,
          reportError: () => undefined,
        },
      );
      await setupLifecycle.createRun({
        runId: `${prefix}:ai`,
        featureId: 'whole-worker-parity',
        sensitivity: 'standard',
        correlationId: `${prefix}:correlation`,
        model: 'loopback',
      });
      await setupLifecycle.shutdownForRestart();
      const preparedAi = await pool.query<{ id: string }>(
        `UPDATE ai_runs
         SET status = 'queued',
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE id = $1
           AND status = 'running'
           AND execution_state ->> 'state' = 'idle'
           AND execution_state ->> 'connection' = 'detached'
         RETURNING id`,
        [`${prefix}:ai`],
      );
      expect(preparedAi.rowCount).toBe(1);
      expect(preparedAi.rows[0].id).toBe(`${prefix}:ai`);
      const producerSemanticRuntime = await import(
        '@/lib/semantic-index/packaged-worker-runtime'
      );
      const producerSemantic = await (
        producerSemanticRuntime.createPackagedPostgresSemanticRuntime()
      );
      await expect(
        producerSemantic.service.ensureIdentity({ create: true }),
      ).resolves.toMatchObject({ status: 'ready' });
      const { publishSemanticEntityUpsert } = await import(
        '@/lib/semantic-index/publication'
      );
      await expect(
        publishSemanticEntityUpsert('task', `${prefix}:semantic`),
      ).resolves.toMatchObject({ status: 'published' });
      await producerSemanticRuntime.stopPackagedPostgresSemanticWorker();

      const claimPriorityAt = '1970-01-01T00:00:00.000Z';
      const [
        prioritizedEnrichment,
        prioritizedAi,
        prioritizedSemantic,
      ] = await Promise.all([
        pool.query<{ id: string }>(
          `UPDATE notification_enrichment_jobs
           SET created_at = $2, next_attempt_at = $2
           WHERE notification_id = $1
           RETURNING id`,
          [`${prefix}:enrichment`, claimPriorityAt],
        ),
        pool.query<{ id: string; timeout_at: string }>(
          `UPDATE ai_runs
           SET created_at = $2, available_at = $2
           WHERE id = $1
           RETURNING id, timeout_at`,
          [`${prefix}:ai`, claimPriorityAt],
        ),
        pool.query<{ id: string }>(
          `UPDATE semantic_intents
           SET requested_at = $2, created_at = $2, available_at = $2
           WHERE entity_id = $1
           RETURNING id`,
          [`${prefix}:semantic`, claimPriorityAt],
        ),
      ]);
      expect([
        prioritizedEnrichment.rowCount,
        prioritizedAi.rowCount,
        prioritizedSemantic.rowCount,
      ]).toEqual([1, 1, 1]);
      const prioritizedClaimIds = {
        enrichment: prioritizedEnrichment.rows[0].id,
        ai: prioritizedAi.rows[0].id,
        semantic: prioritizedSemantic.rows[0].id,
      };
      const originalAiTimeoutAt = Date.parse(prioritizedAi.rows[0].timeout_at);
      expect(originalAiTimeoutAt - Date.now()).toBeGreaterThan(180_000);

      await expect(stat(readyFile)).rejects.toMatchObject({ code: 'ENOENT' });
      const beforeActivation = await pool.query(
        `SELECT
           (SELECT status FROM sync_jobs WHERE id = $1) AS sync,
           (SELECT count(*)::int FROM event_outbox
             WHERE payload ->> 'connectorId' = $2) AS outbox,
           (SELECT status FROM notification_enrichment_jobs WHERE notification_id = $3)
             AS enrichment,
           (SELECT status FROM ai_runs WHERE id = $4) AS ai,
           (SELECT status FROM semantic_intents WHERE entity_id = $5 ORDER BY created_at DESC LIMIT 1)
             AS semantic,
           (SELECT count(*)::int FROM task_projects WHERE project_id = $6)
             AS project_memberships,
           (SELECT count(*)::int FROM task_history_events
             WHERE task_id = $7 AND event_type = 'my_day_missed') AS planning_outputs`,
        [
          syncJob.id,
          `${prefix}:connector`,
          `${prefix}:enrichment`,
          `${prefix}:ai`,
          `${prefix}:semantic`,
          `${prefix}:project`,
          `${prefix}:planning`,
        ],
      );
      expect(beforeActivation.rows[0]).toEqual({
        sync: 'queued',
        outbox: 0,
        enrichment: 'pending',
        ai: 'queued',
        semantic: 'queued',
        project_memberships: 0,
        planning_outputs: 0,
      });

      const first = startWorker();
      await waitFor(async () => {
        if (first.exitCode !== null) throw new Error(Buffer.concat(output).toString());
        await stat(readyFile);
        const states = await pool.query(
          `SELECT
            (SELECT status FROM sync_jobs WHERE id = $1) AS sync,
            (SELECT delivery.status
             FROM event_outbox event
             INNER JOIN event_outbox_deliveries delivery
                ON delivery.event_sequence = event.sequence
             WHERE event.payload ->> 'connectorId' = $2
             ORDER BY event.sequence
             LIMIT 1) AS outbox,
            (SELECT job.status
             FROM notifications notification
             INNER JOIN notification_enrichment_jobs job
                ON job.notification_id = notification.id
             WHERE notification.id = $3) AS enrichment,
            (SELECT job.id
             FROM notification_enrichment_jobs job
             WHERE job.notification_id = $3
              AND job.status = 'processing'
              AND job.lease_owner IS NOT NULL) AS enrichment_claim_id,
            (SELECT status FROM ai_runs WHERE id = $4) AS ai,
            (SELECT id FROM ai_runs
             WHERE id = $4 AND status = 'running' AND lease_owner IS NOT NULL)
              AS ai_claim_id,
            (SELECT execution_state ->> 'state' FROM ai_runs WHERE id = $4)
              AS ai_lifecycle,
            (SELECT status FROM semantic_intents WHERE id = $6) AS semantic,
            (SELECT id FROM semantic_intents
             WHERE entity_id = $5 AND status = 'running' AND lease_owner IS NOT NULL
             ORDER BY created_at DESC LIMIT 1) AS semantic_claim_id`,
          [
            syncJob.id,
            `${prefix}:connector`,
            `${prefix}:enrichment`,
            `${prefix}:ai`,
            `${prefix}:semantic`,
            prioritizedClaimIds.semantic,
          ],
        );
        expect(states.rows[0], JSON.stringify({
          requests,
          unexpectedLoopbackPaths: [...unexpectedLoopbackPaths],
        })).toEqual({
          sync: 'succeeded',
          outbox: 'delivering',
          enrichment: 'processing',
          enrichment_claim_id: prioritizedClaimIds.enrichment,
          ai: 'running',
          ai_claim_id: prioritizedClaimIds.ai,
          ai_lifecycle: 'resuming',
          semantic: 'running',
          semantic_claim_id: prioritizedClaimIds.semantic,
        });
        expect(requests).toMatchObject({
          connectorTasks: 1,
          connectorAlerts: 1,
          outbox: 1,
          enrichment: 1,
          embedding: 1,
          copilotCreate: 1,
          copilotResume: 1,
        });
      }, 45_000);
      const firstInstanceId = (await readFile(readyFile, 'utf8')).trim();

      first.kill('SIGKILL');
      await waitForExit(first);
      for (const response of held) response.destroy();
      held.clear();
      expect((await readFile(readyFile, 'utf8')).trim()).toBe(firstInstanceId);
      const crashedAi = await pool.query<{
        attempt: number;
        lease_expires_at: string | null;
        lifecycle_lease_expires_at: string | null;
        lifecycle_revision: string | null;
        timeout_at: string;
      }>(
        `SELECT
           attempt,
           lease_expires_at,
           execution_state ->> 'leaseExpiresAt' AS lifecycle_lease_expires_at,
           execution_state ->> 'revision' AS lifecycle_revision,
           timeout_at
         FROM ai_runs
         WHERE id = $1`,
        [`${prefix}:ai`],
      );
      const timing = crashedAi.rows[0];
      if (
        !timing?.lease_expires_at
        || !timing.lifecycle_lease_expires_at
        || !timing.lifecycle_revision
      ) {
        throw new Error(`Missing durable AI recovery expiry: ${JSON.stringify({
          hasQueueLease: Boolean(timing?.lease_expires_at),
          hasLifecycleLease: Boolean(timing?.lifecycle_lease_expires_at),
          hasLifecycleRevision: Boolean(timing?.lifecycle_revision),
          hasDeadline: Boolean(timing?.timeout_at),
        })}`);
      }
      expect(timing.attempt).toBe(1);
      const crashedLifecycleRevision = Number(timing.lifecycle_revision);
      const queueLeaseExpiresAt = Date.parse(timing.lease_expires_at);
      const lifecycleLeaseExpiresAt = Number(timing.lifecycle_lease_expires_at);
      const timeoutAt = Date.parse(timing.timeout_at);
      expect(timeoutAt).toBe(originalAiTimeoutAt);
      const killedAt = Date.now();
      if (
        !Number.isFinite(queueLeaseExpiresAt)
        || !Number.isFinite(lifecycleLeaseExpiresAt)
        || !Number.isFinite(crashedLifecycleRevision)
        || !Number.isFinite(timeoutAt)
        || queueLeaseExpiresAt <= killedAt
        || lifecycleLeaseExpiresAt <= killedAt
      ) {
        throw new Error(`Inconsistent durable AI recovery timing: ${JSON.stringify({
          queueLeaseDeltaMs: queueLeaseExpiresAt - killedAt,
          lifecycleLeaseDeltaMs: lifecycleLeaseExpiresAt - killedAt,
          deadlineDeltaMs: timeoutAt - killedAt,
        })}`);
      }
      const expiryWaitDeadline = Date.now() + 60_000;
      let persistedQueueExpiry = queueLeaseExpiresAt;
      let persistedLifecycleExpiry = lifecycleLeaseExpiresAt;
      for (;;) {
        const persisted = await pool.query<{
          lease_expires_at: string | null;
          lifecycle_lease_expires_at: string | null;
          timeout_at: string;
        }>(
          `SELECT
             lease_expires_at,
             execution_state ->> 'leaseExpiresAt' AS lifecycle_lease_expires_at,
             timeout_at
           FROM ai_runs
           WHERE id = $1`,
          [`${prefix}:ai`],
        );
        const row = persisted.rows[0];
        persistedQueueExpiry = Date.parse(row?.lease_expires_at ?? '');
        persistedLifecycleExpiry = Number(row?.lifecycle_lease_expires_at);
        const persistedTimeoutAt = Date.parse(row?.timeout_at ?? '');
        const observedAt = Date.now();
        if (
          !Number.isFinite(persistedQueueExpiry)
          || !Number.isFinite(persistedLifecycleExpiry)
          || persistedTimeoutAt !== timeoutAt
        ) {
          throw new Error(`Invalid persisted durable AI recovery timing: ${JSON.stringify({
            hasQueueLease: Boolean(row?.lease_expires_at),
            hasLifecycleLease: Boolean(row?.lifecycle_lease_expires_at),
            deadlineStable: persistedTimeoutAt === timeoutAt,
          })}`);
        }
        if (
          persistedQueueExpiry <= observedAt
          && persistedLifecycleExpiry <= observedAt
        ) {
          break;
        }
        const remainingMs = expiryWaitDeadline - observedAt;
        if (remainingMs <= 0) {
          throw new Error(`Timed out awaiting durable AI recovery expiry: ${JSON.stringify({
            queueLeaseDeltaMs: persistedQueueExpiry - observedAt,
            lifecycleLeaseDeltaMs: persistedLifecycleExpiry - observedAt,
            deadlineDeltaMs: timeoutAt - observedAt,
          })}`);
        }
        const latestExpiry = Math.max(
          persistedQueueExpiry,
          persistedLifecycleExpiry,
        );
        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(remainingMs, Math.max(25, latestExpiry - observedAt + 250)),
        ));
      }
      const restartAt = Date.now();
      expect(persistedQueueExpiry).toBeLessThanOrEqual(restartAt);
      expect(persistedLifecycleExpiry).toBeLessThanOrEqual(restartAt);
      expect(timeoutAt - restartAt).toBeGreaterThan(90_000);
      holdFirstAttempts = false;

      const second = startWorker();
      const terminalWaitMs = Math.min(
        90_000,
        timeoutAt - Date.now() - 5_000,
      );
      expect(terminalWaitMs).toBeGreaterThan(0);
      await waitFor(async () => {
        if (second.exitCode !== null) throw new Error(Buffer.concat(output).toString());
        await stat(readyFile);
        const states = await pool.query(
          `SELECT
             (SELECT status FROM sync_jobs WHERE id = $1) AS sync,
             (SELECT delivery.status
              FROM event_outbox event
              INNER JOIN event_outbox_deliveries delivery
                ON delivery.event_sequence = event.sequence
              WHERE event.payload ->> 'connectorId' = $2
              ORDER BY event.sequence
              LIMIT 1) AS outbox,
             (SELECT job.status
              FROM notifications notification
              INNER JOIN notification_enrichment_jobs job
                ON job.notification_id = notification.id
              WHERE notification.id = $3) AS enrichment,
             (SELECT status FROM ai_runs WHERE id = $4) AS ai,
             (SELECT cleanup_status FROM ai_runs WHERE id = $4) AS ai_cleanup,
             (SELECT count(*)::int
              FROM ai_provider_sessions
              WHERE run_id = $4
                AND state = 'revoked'
                AND encrypted_reference = '') AS revoked_provider_sessions,
             (SELECT count(*)::int
              FROM notifications
              WHERE source_id = 'ai-run:' || $4) AS terminal_notifications,
             (SELECT count(*)::int
              FROM ai_run_events
              WHERE run_id = $4
                AND kind = 'run.terminal') AS terminal_ai_events,
             (SELECT status FROM semantic_intents WHERE entity_id = $5 ORDER BY created_at DESC LIMIT 1)
               AS semantic`,
           [
             syncJob.id,
             `${prefix}:connector`,
             `${prefix}:enrichment`,
             `${prefix}:ai`,
             `${prefix}:semantic`,
          ],
        );
        expect(states.rows[0]).toEqual({
          sync: 'succeeded',
          outbox: 'delivered',
          enrichment: 'completed',
          ai: 'succeeded',
          ai_cleanup: 'completed',
          revoked_provider_sessions: 1,
          terminal_notifications: 1,
          terminal_ai_events: 1,
          semantic: 'succeeded',
        });
      }, terminalWaitMs);
      expect((await readFile(readyFile, 'utf8')).trim()).not.toBe(firstInstanceId);

      const evidence = await pool.query(
        `SELECT
           (SELECT delivery.attempt_count
            FROM event_outbox event
            INNER JOIN event_outbox_deliveries delivery
              ON delivery.event_sequence = event.sequence
            WHERE event.payload ->> 'connectorId' = $1
            ORDER BY event.sequence
            LIMIT 1) AS outbox_attempts,
           (SELECT job.attempt_count
            FROM notifications notification
            INNER JOIN notification_enrichment_jobs job
              ON job.notification_id = notification.id
            WHERE notification.id = $2) AS enrichment_attempts,
           (SELECT attempt FROM ai_runs WHERE id = $3) AS ai_attempts,
           (SELECT (execution_state ->> 'revision')::int
            FROM ai_runs WHERE id = $3) AS ai_lifecycle_revision,
           (SELECT attempt FROM semantic_intents WHERE entity_id = $4 ORDER BY created_at DESC LIMIT 1)
             AS semantic_attempts,
           (SELECT count(*)::int FROM semantic_documents WHERE entity_id = $4) AS documents,
           (SELECT count(*)::int FROM semantic_vectors WHERE entity_id = $4) AS vectors,
           (SELECT count(*)::int
            FROM ai_provider_sessions
            WHERE run_id = $3
              AND state = 'revoked'
              AND encrypted_reference = '') AS revoked_provider_sessions,
           (SELECT count(*)::int
            FROM ai_run_events
            WHERE run_id = $3
              AND kind = 'run.terminal') AS ai_terminal_events,
           (SELECT count(*)::int FROM notifications WHERE source_id = $5) AS terminal_notifications,
           (SELECT count(*)::int FROM task_projects WHERE project_id = $6) AS project_memberships,
           (SELECT count(*)::int FROM task_history_events
             WHERE task_id = $7 AND event_type = 'my_day_missed') AS planning_outputs,
           (SELECT count(*)::int
            FROM event_outbox
            WHERE payload ->> 'connectorId' = $1) AS terminal_events,
           (SELECT count(*)::int
            FROM sync_log
            WHERE job_id = $8 AND success = true) AS terminal_sync_logs,
           (SELECT id FROM sync_log WHERE job_id = $8 AND success = true) AS sync_run_id,
           (SELECT stable_key
            FROM event_outbox
            WHERE payload ->> 'connectorId' = $1) AS terminal_event_key,
           (SELECT count(*)::int
            FROM event_outbox event
            INNER JOIN event_outbox_deliveries delivery
              ON delivery.event_sequence = event.sequence
            WHERE event.payload ->> 'connectorId' = $1) AS terminal_deliveries,
           (SELECT metadata ->> 'aiSummary'
            FROM notifications
            WHERE id = $2) AS enrichment_summary,
           (SELECT count(*)::int
            FROM notifications
            WHERE source_id = $9) AS pipeline_notifications,
           (SELECT related_task_id
            FROM notifications
            WHERE source_id = $9) AS pipeline_related_task,
           (SELECT navigation_target
            FROM notifications
            WHERE source_id = $9) AS pipeline_navigation`,
        [
          `${prefix}:connector`,
          `${prefix}:enrichment`,
          `${prefix}:ai`,
          `${prefix}:semantic`,
          `ai-run:${prefix}:ai`,
          `${prefix}:project`,
          `${prefix}:planning`,
          syncJob.id,
          `${prefix}:connector:${prefix}:alert`,
        ],
      );
      expect(evidence.rows[0]).toMatchObject({
        outbox_attempts: 2,
        enrichment_attempts: 2,
        ai_attempts: 2,
        semantic_attempts: 2,
        documents: 1,
        vectors: 1,
        revoked_provider_sessions: 1,
        ai_terminal_events: 1,
        terminal_notifications: 1,
        project_memberships: 2,
        planning_outputs: 1,
        terminal_events: 1,
        terminal_sync_logs: 1,
        terminal_deliveries: 1,
        enrichment_summary: 'Durably enriched',
        pipeline_notifications: 1,
        pipeline_related_task: `${prefix}:semantic`,
        pipeline_navigation: `/tasks?selected=${prefix}:semantic`,
      });
      expect(evidence.rows[0].ai_lifecycle_revision).toBeGreaterThan(
        crashedLifecycleRevision,
      );
      expect(evidence.rows[0].terminal_event_key).toBe(
        `sync.completed:job:${syncJob.id}:run:${evidence.rows[0].sync_run_id}`,
      );
      await waitFor(async () => {
        expect(
          await runtime.getPostgresSemanticIndexRepository().getActiveIdentity(),
        ).not.toBeNull();
      });
      expect(requests.outbox).toBe(2);
      expect(requests.enrichment).toBe(2);
      expect(outboxSignatures.every((signature) =>
        /^sha256=[0-9a-f]{64}$/.test(signature)
      )).toBe(true);
      expect(requests.copilotCreate).toBe(1);
      expect(requests.copilotResume).toBe(2);
      expect(requests.copilotDelete).toBe(1);
      expect([...unexpectedLoopbackPaths]).toEqual([]);
      const semanticRepository = runtime.getPostgresSemanticIndexRepository();
      const activeIdentity = await semanticRepository.getActiveIdentity();
      expect(activeIdentity).not.toBeNull();
      const semanticResults = await semanticRepository.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 5,
        includeEntityIds: [`${prefix}:semantic`],
      });
      expect(semanticResults.results).toEqual([
        expect.objectContaining({
          entityType: 'task',
          entityId: `${prefix}:semantic`,
        }),
      ]);

      const { runWorkerHealthcheck } = await import('@/lib/runtime/worker-healthcheck');
      await expect(runWorkerHealthcheck({
        MC_DATABASE_BACKEND: 'postgres',
        MC_POSTGRES_URL: connectionString!,
        MC_WORKER_INSTANCE_FILE: readyFile,
      })).resolves.toBeUndefined();
      second.kill('SIGTERM');
      expect(await waitForExit(second)).toBe(0);
      await expect(stat(readyFile)).rejects.toMatchObject({ code: 'ENOENT' });

      const deadLetters = await pool.query(
        `SELECT
           (SELECT count(*)::int
            FROM event_outbox event
            INNER JOIN event_outbox_deliveries delivery
              ON delivery.event_sequence = event.sequence
            WHERE event.payload ->> 'connectorId' = $1
              AND delivery.status = 'dead_letter') AS outbox,
           (SELECT count(*)::int
            FROM notifications notification
            INNER JOIN notification_enrichment_jobs job
              ON job.notification_id = notification.id
            WHERE notification.id = $2
              AND job.status = 'dead_letter') AS enrichment`,
        [`${prefix}:connector`, `${prefix}:enrichment`],
      );
      expect(deadLetters.rows[0]).toEqual({ outbox: 0, enrichment: 0 });
    } finally {
      const liveChildren = [...children].filter(
        (child) => child.exitCode === null && child.signalCode === null,
      );
      for (const child of liveChildren) child.kill('SIGKILL');
      await Promise.allSettled(liveChildren.map((child) => waitForExit(child, 10_000)));
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(runtimeRoot, { recursive: true, force: true });
      if (savedAiConfig === null) await settings.delete('ai_provider_config');
      else await settings.set('ai_provider_config', savedAiConfig);
      if (savedRoutingPolicy === null) await settings.delete('ai_routing_policy');
      else await settings.set('ai_routing_policy', savedRoutingPolicy);
    }
  }, 300_000);
});
