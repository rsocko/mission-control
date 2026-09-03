import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createPostgresSemanticIndexRepository } from '@/db/postgres/semantic-index/repository';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-semantic-packaged-runtime-test',
        }),
      }
    : {}),
  vectorMode: 'disabled',
});

function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Packaged semantic worker did not stop')),
      timeoutMs,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFor(
  assertion: () => Promise<void>,
  timeoutMs = 45_000,
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
  throw new Error('Timed out waiting for packaged semantic worker', { cause: lastError });
}

describePostgres('packaged PostgreSQL semantic worker runtime', () => {
  const identityIds = new Set<string>();
  const connectorIds = new Set<string>();
  const taskIds = new Set<string>();

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    if (!existsSync('dist/semantic-worker-harness.cjs')) {
      const build = spawnSync(process.execPath, ['scripts/build-sync-worker.mjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      if (build.status !== 0) {
        throw new Error(build.stderr || build.stdout || 'Semantic worker harness build failed');
      }
    }
    const artifact = await readFile('dist/semantic-worker-harness.cjs', 'utf8');
    for (const marker of ['AIEmbeddingProvider', 'requestEmbeddingResult', 'AI embedding request completed']) {
      if (!artifact.includes(marker)) {
        throw new Error(`Semantic worker harness omitted production embedding marker: ${marker}`);
      }
    }
    await backend.initialize();
  }, 120_000);

  afterAll(async () => {
    for (const id of identityIds) {
      await backend.context.pool.query(
        'DELETE FROM semantic_index_identities WHERE id = $1',
        [id],
      );
    }
    for (const id of taskIds) {
      await backend.context.pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    }
    for (const id of connectorIds) {
      await backend.context.pool.query('DELETE FROM connector_configs WHERE id = $1', [id]);
    }
    await backend.shutdown();
  });

  it('recovers claimed intents and durable run checkpoints with SQLite poisoned', async () => {
    const suffix = randomUUID();
    const connectorId = `semantic-worker-${suffix}`;
    const taskId = `semantic-task-${suffix}`;
    const model = `synthetic-embedding-${suffix}`;
    connectorIds.add(connectorId);
    taskIds.add(taskId);
    const now = new Date().toISOString();
    await backend.context.pool.query(
      `INSERT INTO connector_configs (
         id, type, name, enabled, capabilities, credentials, settings,
         synced_lists, created_at, updated_at
       ) VALUES ($1, 'custom-rest', 'Synthetic semantic worker', true,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $2)`,
      [connectorId, now],
    );
    await backend.context.pool.query(
      `INSERT INTO tasks (
         id, source_id, connector_type, connector_instance_id, title, description,
         status, priority, created_at, updated_at, last_synced_at
       ) VALUES ($1, $1, 'custom-rest', $2, 'Packaged semantic task',
         'Recover this semantic projection after a worker crash', 'todo', 'normal',
         $3, $3, $3)`,
      [taskId, connectorId, now],
    );

    let holdTaskEmbedding = true;
    const embeddedInputs: string[] = [];
    const heldResponses = new Set<ServerResponse>();
    const embeddingServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { input?: string };
        const isProbe = body.input?.includes('dimension probe');
        if (!isProbe && holdTaskEmbedding) {
          heldResponses.add(response);
          response.on('close', () => heldResponses.delete(response));
          return;
        }
        if (!isProbe && body.input) embeddedInputs.push(body.input);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
      });
    });
    await new Promise<void>((resolve) => embeddingServer.listen(0, '127.0.0.1', resolve));
    const address = embeddingServer.address();
    if (!address || typeof address === 'string') throw new Error('Embedding test server did not bind');

    const runtimeRoot = await mkdtemp(join(tmpdir(), 'mc-semantic-worker-'));
    const readyFile = join(runtimeRoot, 'ready');
    const sqlitePath = join(runtimeRoot, 'poison.db');
    const poisonPath = join(runtimeRoot, 'poison-sqlite.cjs');
    await writeFile(poisonPath, `
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'better-sqlite3' || request.includes('sqlite-')) {
          throw new Error('Packaged PostgreSQL semantic worker evaluated SQLite: ' + request);
        }
        return load.call(this, request, parent, isMain);
      };
    `);

    const children = new Set<ChildProcess>();
    const startWorker = (options: { crashAfterRunCheckpoint?: boolean } = {}) => {
      const output: Buffer[] = [];
      const child = spawn(process.execPath, [
        '--require',
        poisonPath,
        'dist/semantic-worker-harness.cjs',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MC_DATABASE_BACKEND: 'postgres',
          MC_POSTGRES_URL: connectionString!,
          MC_TEST_POSTGRES_URL: connectionString!,
          MC_POSTGRES_VECTOR_MODE: 'disabled',
          MC_DB_PATH: sqlitePath,
          MC_SEMANTIC_PACKAGED_HARNESS: 'postgres-integration-test',
          MC_SEMANTIC_HARNESS_ENTITY_TYPES: 'task',
          MC_SEMANTIC_HARNESS_READY_FILE: readyFile,
          MC_SEMANTIC_WORKER_POLL_MS: '250',
          MC_SEMANTIC_WORKER_BUSY_POLL_MS: '50',
          MC_SEMANTIC_WORKER_BATCH_SIZE: '16',
          MC_SEMANTIC_WORKER_CONCURRENCY: '1',
          MC_SEMANTIC_INTENT_LEASE_MS: '5000',
          MC_SEMANTIC_RUN_LEASE_MS: '10000',
          MC_SEMANTIC_RUN_PAGE_SIZE: '1',
          MC_SEMANTIC_RUN_SLICE_BUDGET_MS: '600000',
          MC_SEMANTIC_MAINTENANCE_INTERVAL_MS: '86400000',
          ...(options.crashAfterRunCheckpoint
            ? { MC_SEMANTIC_HARNESS_CRASH_AFTER_RUN_CHECKPOINT: '1' }
            : {}),
          AI_EMBEDDING_PROVIDER: 'ollama',
          AI_EMBEDDING_MODEL: model,
          AI_EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));
      child.once('exit', () => children.delete(child));
      return { child, output };
    };

    try {
      const first = startWorker();
      await waitFor(async () => {
        if (first.child.exitCode !== null) {
          throw new Error(Buffer.concat(first.output).toString());
        }
        await stat(readyFile);
        const result = await backend.context.pool.query<{
          id: string;
          index_id: string;
          idempotency_key: string;
          idempotency_key_version: number;
          status: string;
          attempt: number;
        }>(
         `SELECT id, index_id, idempotency_key, idempotency_key_version, status, attempt
          FROM semantic_intents
          WHERE entity_id = $1 AND status = 'running'`,
          [taskId],
        );
        expect(result.rows).toHaveLength(1);
        identityIds.add(result.rows[0].index_id);
        expect(result.rows[0].attempt).toBe(1);
        expect(result.rows[0].idempotency_key).toMatch(/^mc-semantic-key:v1:/);
        expect(result.rows[0].idempotency_key_version).toBe(1);
        expect(result.rows[0].idempotency_key).not.toContain('\u0000');
      });

      first.child.kill('SIGKILL');
      await waitForExit(first.child);
      await new Promise((resolve) => setTimeout(resolve, 5_250));
      holdTaskEmbedding = false;

      const second = startWorker();
      await waitFor(async () => {
        if (second.child.exitCode !== null) {
          throw new Error(Buffer.concat(second.output).toString());
        }
        const result = await backend.context.pool.query<{
          status: string;
          attempt: number;
          outcome: string | null;
        }>(
          `SELECT status, attempt, outcome
           FROM semantic_intents
           WHERE entity_id = $1
           ORDER BY created_at ASC`,
          [taskId],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          status: 'succeeded',
          attempt: 2,
          outcome: 'embedded',
        });
        const vectors = await backend.context.pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM semantic_vectors WHERE entity_id = $1',
          [taskId],
        );
        expect(vectors.rows[0].count).toBe('1');
      }, 60_000);

      second.child.kill('SIGTERM');
      expect(await waitForExit(second.child)).toBe(0);
      await expect(stat(readyFile)).rejects.toMatchObject({ code: 'ENOENT' });

      const identityResult = await backend.context.pool.query<{ index_id: string }>(
        `SELECT index_id FROM semantic_intents WHERE entity_id = $1`,
        [taskId],
      );
      const identityId = identityResult.rows[0].index_id;
      const bulkPrefix = `0000-semantic-checkpoint-${suffix}-`;
      const bulkTaskIds = Array.from(
        { length: 256 },
        (_, index) => `${bulkPrefix}${String(index).padStart(4, '0')}`,
      );
      for (const id of bulkTaskIds) taskIds.add(id);
      await backend.context.pool.query(
        `INSERT INTO tasks (
           id, source_id, connector_type, connector_instance_id, title, description,
           status, priority, created_at, updated_at, last_synced_at
         )
         SELECT seeded.id, seeded.id, 'custom-rest', $2, seeded.id,
           'Packaged checkpoint resume task', 'todo', 'normal', $3, $3, $3
         FROM unnest($1::text[]) AS seeded(id)`,
        [bulkTaskIds, connectorId, new Date().toISOString()],
      );

      // The automatically scheduled reconcile/cleanup runs are unrelated to
      // this proof and could legitimately enqueue repairs while the backfill
      // backlog drains. Keep their existing idempotency keys terminal.
      await backend.context.pool.query(
        `UPDATE semantic_runs
         SET status = 'cancelled', completed_at = $2, updated_at = $2,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE index_id = $1 AND kind <> 'backfill'
           AND status IN ('queued', 'running')`,
        [identityId, new Date().toISOString()],
      );
      const repository = createPostgresSemanticIndexRepository(
        backend.context.pool,
        backend.context.vector,
      );
      const checkpointRunId = `checkpoint-run-${suffix}`;
      const createdRun = await repository.createRun({
        id: checkpointRunId,
        indexId: identityId,
        kind: 'backfill',
        idempotencyKey: `${identityId}\u0000backfill\u0000checkpoint-${suffix}`,
        now: new Date().toISOString(),
      });
      expect(createdRun.status).toBe('created');

      const checkpointWorker = startWorker({ crashAfterRunCheckpoint: true });
      let lockClient: PoolClient | null = null;
      try {
        await waitFor(async () => {
          if (checkpointWorker.child.exitCode !== null) {
            throw new Error(Buffer.concat(checkpointWorker.output).toString());
          }
          const state = await backend.context.pool.query<{ status: string; count: string }>(
            `SELECT r.status,
               (SELECT COUNT(*)::text FROM semantic_intents i
                WHERE i.index_id = r.index_id AND i.entity_id = ANY($2::text[])) AS count
             FROM semantic_runs r WHERE r.id = $1`,
            [checkpointRunId, bulkTaskIds],
          );
          expect(state.rows[0]?.status).toBe('running');
          expect(Number(state.rows[0]?.count ?? 0)).toBeGreaterThan(0);
        }, 60_000);

        // Queue behind one completed page, then hold the identity row. The
        // production repository takes this same lock on every publish, so the
        // worker cannot advance another page until shutdown has aborted it.
        lockClient = await backend.context.pool.connect();
        await lockClient.query('BEGIN');
        await lockClient.query(
          'SELECT id FROM semantic_index_identities WHERE id = $1 FOR UPDATE',
          [identityId],
        );
        checkpointWorker.child.kill('SIGTERM');
        await waitFor(async () => {
          await expect(stat(readyFile)).rejects.toMatchObject({ code: 'ENOENT' });
        });
        await lockClient.query('COMMIT');
        lockClient.release();
        lockClient = null;
        await waitForExit(checkpointWorker.child);
        expect(checkpointWorker.child.signalCode).toBe('SIGKILL');
      } finally {
        if (lockClient) {
          await lockClient.query('ROLLBACK').catch(() => undefined);
          lockClient.release();
        }
      }

      const checkpointed = await backend.context.pool.query<{
        status: string;
        checkpoint: string | null;
        processed_count: number;
        skipped_count: number;
        attempt: number;
        lease_expires_at: string;
      }>(
        `SELECT status, checkpoint, processed_count, skipped_count, attempt, lease_expires_at
         FROM semantic_runs WHERE id = $1`,
        [checkpointRunId],
      );
      expect(checkpointed.rows[0]).toMatchObject({
        status: 'running',
        skipped_count: 0,
        attempt: 0,
      });
      const durableCheckpoint = checkpointed.rows[0].checkpoint;
      expect(durableCheckpoint).not.toBeNull();
      if (durableCheckpoint === null) {
        throw new Error('Expected a durable checkpoint before packaged process termination');
      }
      expect(checkpointed.rows[0].processed_count).toBeGreaterThan(0);
      const checkpointCursor = JSON.parse(durableCheckpoint) as {
        kind?: unknown;
        after?: unknown;
      };
      expect(checkpointCursor).toMatchObject({ kind: 'task', after: expect.any(String) });
      if (typeof checkpointCursor.after !== 'string') {
        throw new Error('Expected a stable task cursor after the durable checkpoint');
      }
      const committedCursorIntent = await backend.context.pool.query<{
        id: string;
        requested_at: string;
      }>(
        `SELECT id, requested_at FROM semantic_intents
         WHERE index_id = $1 AND entity_id = $2
         ORDER BY requested_at DESC, created_at DESC, id DESC
         LIMIT 1`,
        [identityId, checkpointCursor.after],
      );
      expect(committedCursorIntent.rows).toHaveLength(1);
      const committedBeforeRestart = await backend.context.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM semantic_intents
         WHERE index_id = $1 AND entity_id = ANY($2::text[])`,
        [identityId, bulkTaskIds],
      );
      expect(Number(committedBeforeRestart.rows[0].count)).toBeGreaterThan(0);
      expect(Number(committedBeforeRestart.rows[0].count)).toBeLessThan(bulkTaskIds.length);

      const leaseDelay = Math.max(
        0,
        Date.parse(checkpointed.rows[0].lease_expires_at) - Date.now() + 250,
      );
      await new Promise((resolve) => setTimeout(resolve, leaseDelay));
      const embeddingOffset = embeddedInputs.length;
      const resumedWorker = startWorker();
      await waitFor(async () => {
        if (resumedWorker.child.exitCode !== null) {
          throw new Error(Buffer.concat(resumedWorker.output).toString());
        }
        const run = await backend.context.pool.query<{
          status: string;
          attempt: number;
          skipped_count: number;
        }>(
          `SELECT status, attempt, skipped_count FROM semantic_runs WHERE id = $1`,
          [checkpointRunId],
        );
        expect(run.rows[0]).toMatchObject({ status: 'succeeded', attempt: 1, skipped_count: 0 });
        const intents = await backend.context.pool.query<{
          total: string;
          succeeded: string;
          distinct_entities: string;
        }>(
          `SELECT COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE status = 'succeeded' AND outcome = 'embedded')::text AS succeeded,
             COUNT(DISTINCT entity_id)::text AS distinct_entities
           FROM semantic_intents
           WHERE index_id = $1 AND entity_id = ANY($2::text[])`,
          [identityId, bulkTaskIds],
        );
        expect(intents.rows[0]).toEqual({
          total: String(bulkTaskIds.length),
          succeeded: String(bulkTaskIds.length),
          distinct_entities: String(bulkTaskIds.length),
        });
      }, 120_000);

      const projections = await backend.context.pool.query<{
        documents: string;
        vectors: string;
        document_entities: string;
        vector_entities: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM semantic_documents
            WHERE index_id = $1 AND entity_id = ANY($2::text[])) AS documents,
           (SELECT COUNT(*)::text FROM semantic_vectors
            WHERE index_id = $1 AND entity_id = ANY($2::text[])) AS vectors,
           (SELECT COUNT(DISTINCT entity_id)::text FROM semantic_documents
            WHERE index_id = $1 AND entity_id = ANY($2::text[])) AS document_entities,
           (SELECT COUNT(DISTINCT entity_id)::text FROM semantic_vectors
            WHERE index_id = $1 AND entity_id = ANY($2::text[])) AS vector_entities`,
        [identityId, bulkTaskIds],
      );
      expect(projections.rows[0]).toEqual({
        documents: String(bulkTaskIds.length),
        vectors: String(bulkTaskIds.length),
        document_entities: String(bulkTaskIds.length),
        vector_entities: String(bulkTaskIds.length),
      });

      const expectedFifo = await backend.context.pool.query<{ entity_id: string }>(
        `SELECT entity_id FROM semantic_intents
         WHERE index_id = $1 AND entity_id = ANY($2::text[])
         ORDER BY requested_at, created_at, id`,
        [identityId, bulkTaskIds],
      );
      const actualFifo = embeddedInputs.slice(embeddingOffset)
        .map((input) => bulkTaskIds.find((id) => input.includes(id)))
        .filter((id): id is string => id !== undefined);
      expect(actualFifo).toEqual(expectedFifo.rows.map((row) => row.entity_id));
      const resumedCursorIntent = await backend.context.pool.query<{
        requested_at: string;
      }>(
        'SELECT requested_at FROM semantic_intents WHERE id = $1',
        [committedCursorIntent.rows[0].id],
      );
      expect(resumedCursorIntent.rows[0]?.requested_at)
        .toBe(committedCursorIntent.rows[0].requested_at);

      resumedWorker.child.kill('SIGTERM');
      expect(await waitForExit(resumedWorker.child)).toBe(0);
      await expect(stat(readyFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(sqlitePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(poisonPath, 'utf8')).toContain('evaluated SQLite');
    } finally {
      for (const child of children) {
        child.kill('SIGKILL');
        await waitForExit(child).catch(() => undefined);
      }
      for (const response of heldResponses) response.destroy();
      await new Promise<void>((resolve, reject) => embeddingServer.close((error) =>
        error ? reject(error) : resolve()
      ));
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
