import { randomUUID } from 'node:crypto';
import type { SessionConfig, SessionEvent } from '@github/copilot-sdk';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresDurableAiRunRepository } from '@/lib/ai/durable-runs/postgres-adapter';
import {
  createDurableAiExecutorRegistry,
  shutdownDurableAiExecutorRegistry,
} from '@/lib/ai/durable-runs/executor-registry';
import { DurableAiRunWorker } from '@/lib/ai/durable-runs/worker';
import {
  CopilotSessionLifecycleManager,
  type CopilotLifecycleClient,
} from '@/lib/ai/copilot-session-lifecycle';
import {
  COPILOT_EXECUTION_ROUTE,
  COPILOT_PROVIDER,
} from '@/lib/ai/copilot-run-events';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated by PostgreSQL durable AI');
});

const { Pool } = pg;
const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const testPrefix = `durable-ai-${randomUUID()}-`;
const originalProviderSessionKey = process.env.MC_AI_PROVIDER_SESSION_KEY;

describePostgres('PostgreSQL durable AI run repository integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-durable-ai-test',
          }),
        }
      : {}),
  });
  let secondPool: pg.Pool;
  let repository: PostgresDurableAiRunRepository;
  let secondRepository: PostgresDurableAiRunRepository;
  let ordinal = 0;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.MC_AI_PROVIDER_SESSION_KEY = Buffer.alloc(32, 7).toString('base64');
    await backend.initialize();
    secondPool = new Pool({
      connectionString,
      application_name: 'mission-control-durable-ai-test-second-pool',
    });
    await secondPool.query('SELECT 1');
    repository = new PostgresDurableAiRunRepository(backend.context.pool);
    secondRepository = new PostgresDurableAiRunRepository(secondPool);
  }, 120_000);

  afterEach(async () => {
    await backend.context.pool.query(
      'DELETE FROM ai_runs WHERE id LIKE $1',
      [`${testPrefix}%`],
    );
  });

  afterAll(async () => {
    await secondPool?.end();
    await backend.shutdown();
    if (originalProviderSessionKey === undefined) {
      delete process.env.MC_AI_PROVIDER_SESSION_KEY;
    } else {
      process.env.MC_AI_PROVIDER_SESSION_KEY = originalProviderSessionKey;
    }
  });

  function input(
    suffix: string,
    overrides: Partial<Parameters<PostgresDurableAiRunRepository['createRun']>[0]> = {},
  ) {
    ordinal += 1;
    const now = new Date(`2026-09-02T12:00:${String(ordinal).padStart(2, '0')}.000Z`);
    return {
      id: `${testPrefix}${suffix}`,
      idempotencyKey: `${testPrefix}idempotency-${suffix}`,
      featureId: 'durable-postgres-integration',
      sensitivity: 'standard' as const,
      executionRoute: 'integration-route',
      requestedProvider: 'integration-provider',
      requestedModel: 'integration-model',
      correlationId: `${testPrefix}correlation-${suffix}`,
      timeoutMs: 60_000,
      now,
      ...overrides,
    };
  }

  function lifecycleClient() {
    let sessionCount = 0;
    const client: CopilotLifecycleClient & {
      createSession: ReturnType<typeof vi.fn>;
      deleteSession: ReturnType<typeof vi.fn>;
    } = {
      createSession: vi.fn(async (config: SessionConfig) => {
        const sessionId = `${testPrefix}sdk-${++sessionCount}`;
        const handlers = new Set<(event: SessionEvent) => void>();
        const session = {
          sessionId,
          sendAndWait: vi.fn(),
          on: vi.fn((handler: (event: SessionEvent) => void) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
          }),
          abort: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        };
        if (config.onEvent) session.on(config.onEvent);
        return session;
      }),
      resumeSession: vi.fn(),
      deleteSession: vi.fn(async () => undefined),
    };
    return client;
  }

  it('deduplicates creation and allocates ordered idempotent events transactionally', async () => {
    const createInput = input('events');
    const [first, duplicate] = await Promise.all([
      repository.createRun(createInput),
      secondRepository.createRun(createInput),
    ]);
    expect([first.created, duplicate.created].sort()).toEqual([false, true]);

    const runId = first.run.id;
    const sameEvent = await Promise.all(Array.from({ length: 12 }, () =>
      repository.appendEvent(runId, {
        idempotencyKey: `${testPrefix}same-event`,
        kind: 'output.progress',
        payload: { bytes: 1 },
      })));
    expect(new Set(sameEvent.map((event) => event.cursor)).size).toBe(1);

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? repository : secondRepository).appendEvent(runId, {
        idempotencyKey: `${testPrefix}event-${index}`,
        kind: 'output.progress',
        payload: { bytes: index },
      })));
    const events = await repository.getEventsAfter(runId);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
    expect(await repository.getEventIdempotencyKeys(runId)).toHaveLength(events.length);
  });

  it('uses SKIP LOCKED so a second pool claims another eligible run', async () => {
    const first = await repository.createRun(input('claim-a'));
    const second = await repository.createRun(input('claim-b'));
    const lock = await backend.context.pool.connect();
    await lock.query('BEGIN');
    try {
      await lock.query('SELECT id FROM ai_runs WHERE id = $1 FOR UPDATE', [first.run.id]);
      const claimed = await secondRepository.claimNextRun(
        'worker-b',
        ['integration-route'],
        60_000,
        new Date('2026-09-02T12:01:00.000Z'),
      );
      expect(claimed?.id).toBe(second.run.id);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('recovers expired claims and fences every stale attempt mutation', async () => {
    const now = new Date('2026-09-02T13:00:00.000Z');
    const { run } = await repository.createRun(input('fence', {
      maxAttempts: 2,
      now,
    }));
    const first = await repository.claimNextRun(
      'worker-a',
      ['integration-route'],
      10,
      now,
    );
    await repository.setProviderSessionForClaim(
      run.id,
      'worker-a',
      first!.attempt,
      'integration-provider',
      'private-session',
      { now },
    );
    const recoveredAt = new Date(now.getTime() + 11);
    expect(await secondRepository.recoverExpiredRuns(
      recoveredAt,
      ['integration-route'],
    )).toBe(1);
    const second = await secondRepository.claimNextRun(
      'worker-b',
      ['integration-route'],
      60_000,
      recoveredAt,
    );
    expect(second?.attempt).toBe(2);

    await expect(repository.appendEventForClaim(
      run.id,
      'worker-a',
      first!.attempt,
      {
        idempotencyKey: `${testPrefix}stale-event`,
        kind: 'output.progress',
        now: recoveredAt,
      },
    )).rejects.toThrow(/ownership was lost/);
    await expect(repository.completeRun(
      run.id,
      'worker-a',
      {},
      recoveredAt,
    )).rejects.toThrow(/ownership was lost/);
    await expect(repository.revokeProviderSessionForClaim(
      run.id,
      'worker-a',
      first!.attempt,
      recoveredAt,
    )).rejects.toThrow(/ownership was lost/);
    await expect(repository.setProviderSessionForClaim(
      run.id,
      'worker-a',
      first!.attempt,
      'integration-provider',
      'replacement-session',
      { now: recoveredAt },
    )).rejects.toThrow(/ownership was lost/);
    await expect(repository.getProviderSessionForClaim(
      run.id,
      'worker-a',
      first!.attempt,
      recoveredAt,
    )).rejects.toThrow(/ownership was lost/);
    expect(await secondRepository.getProviderSession(run.id, recoveredAt)).toMatchObject({
      reference: 'private-session',
    });
  });

  it('persists cancellation, retry, cleanup recovery, and session revocation across repositories', async () => {
    const now = new Date('2026-09-02T14:00:00.000Z');
    const queued = await repository.createRun(input('cancel', { now }));
    expect((await secondRepository.requestCancellation(queued.run.id, now))?.status)
      .toBe('cancelled');
    expect((await repository.requestCancellation(queued.run.id, now))?.status)
      .toBe('cancelled');

    const { run } = await repository.createRun(input('cleanup', {
      maxAttempts: 1,
      now,
    }));
    const claim = await repository.claimNextRun(
      'worker-a',
      ['integration-route'],
      100,
      now,
    );
    await repository.setProviderSessionForClaim(
      run.id,
      'worker-a',
      claim!.attempt,
      'integration-provider',
      'cleanup-session',
      { now },
    );
    await repository.failRun(run.id, 'worker-a', 'failed', {
      retryable: false,
      now,
    });
    const cleanup = await secondRepository.claimCleanup(
      'cleaner-a',
      ['integration-route'],
      100,
      now,
    );
    expect(cleanup?.id).toBe(run.id);
    await repository.finishCleanup(
      run.id,
      'cleaner-a',
      new Error('temporary cleanup failure'),
      now,
    );
    const retryAt = new Date(now.getTime() + 5 * 60_000 + 1);
    const retriedCleanup = await secondRepository.claimCleanup(
      'cleaner-b',
      ['integration-route'],
      100,
      retryAt,
    );
    expect(retriedCleanup?.id).toBe(run.id);
    await secondRepository.finishCleanup(run.id, 'cleaner-b', undefined, retryAt);
    expect(await repository.getProviderSession(run.id, retryAt)).toBeNull();
    expect(await repository.getRun(run.id)).toMatchObject({
      cleanupStatus: 'completed',
      lastErrorCode: 'provider_cleanup_failed',
    });

    const retried = await repository.retryRun(
      run.id,
      `${testPrefix}retry-command`,
      new Date(retryAt.getTime() + 1),
    );
    const duplicate = await secondRepository.retryRun(
      run.id,
      `${testPrefix}retry-command`,
      new Date(retryAt.getTime() + 2),
    );
    expect(retried?.status).toBe('queued');
    expect(duplicate?.revision).toBe(retried?.revision);
  });

  it('compare-and-sets execution state and prunes only expired terminal test rows', async () => {
    const now = new Date('2026-09-02T15:00:00.000Z');
    const { run } = await repository.createRun(input('cas-retention', { now }));
    expect(await repository.initializeExecutionState(
      run.id,
      { state: 'idle', ownerId: 'worker-a', prompt: 'must not persist' },
      {
        expectedRevision: run.revision,
        status: 'running',
        owner: 'worker-a',
        leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        now,
      },
    )).toBe(true);
    const initialized = await secondRepository.getInternalRun(run.id);
    expect(initialized?.executionState).toEqual({
      state: 'idle',
      ownerId: 'worker-a',
    });
    expect(await Promise.all([
      repository.compareAndSetExecutionState(
        run.id,
        initialized!.revision,
        { state: 'active', ownerId: 'worker-a' },
        {
          allowedCurrentStatuses: ['running'],
          requiredLeaseOwner: 'worker-a',
          leaseState: 'active',
          owner: 'worker-a',
          leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
          now,
        },
      ),
      secondRepository.compareAndSetExecutionState(
        run.id,
        initialized!.revision,
        { state: 'active', ownerId: 'worker-b' },
        {
          allowedCurrentStatuses: ['running'],
          requiredLeaseOwner: 'worker-a',
          leaseState: 'active',
          owner: 'worker-b',
          leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
          now,
        },
      ),
    ])).toEqual(expect.arrayContaining([true, false]));

    await backend.context.pool.query(
      `
        UPDATE ai_runs
        SET status = 'failed', expires_at = $1, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $2
      `,
      [new Date(now.getTime() - 1).toISOString(), run.id],
    );
    expect(await repository.pruneExpired(now)).toMatchObject({ deletedRuns: 1 });
    expect(await repository.getRun(run.id)).toBeNull();
  });

  it('runs the real registry with worker-owned terminal and cleanup state', async () => {
    const client = lifecycleClient();
    const onTerminal = vi.fn();
    const { run } = await repository.createRun(input('real-registry', {
      executionRoute: COPILOT_EXECUTION_ROUTE,
      requestedProvider: COPILOT_PROVIDER,
      notifyOnCompletion: true,
      now: new Date(),
    }));
    const registry = createDurableAiExecutorRegistry({
      ownerId: `${testPrefix}worker`,
      durableRuns: repository,
      createCopilotLifecycle: (persistence) =>
        new CopilotSessionLifecycleManager(client, persistence.store, {
          maxConcurrentSessions: 1,
          requestTimeoutMs: 1_000,
          idleTimeoutMs: 10_000,
          cleanupTimeoutMs: 1_000,
          sessionOperationTimeoutMs: 1_000,
          leaseDurationMs: 60_000,
          workerId: `${testPrefix}worker`,
          reportError: vi.fn(),
          eventSink: persistence.eventSink,
          eventCursor: persistence.eventCursor,
        }),
    });
    const worker = new DurableAiRunWorker(repository, registry, {
      ownerId: `${testPrefix}worker`,
      leaseMs: 60_000,
      onTerminal,
    });
    try {
      expect(await worker.runOnce()).toBe(true);
      expect(await repository.getRun(run.id)).toMatchObject({
        status: 'succeeded',
        cleanupStatus: 'pending',
      });
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(client.createSession).toHaveBeenCalledOnce();
      expect(client.deleteSession).toHaveBeenCalledOnce();
      expect(
        (await repository.getEventsAfter(run.id))
          .filter((event) => event.kind === 'run.succeeded'),
      ).toHaveLength(1);

      expect(await worker.runOnce()).toBe(true);
      expect(await repository.getRun(run.id)).toMatchObject({
        status: 'succeeded',
        cleanupStatus: 'completed',
      });
      expect(await repository.getProviderSession(run.id)).toBeNull();
      expect(await worker.runOnce()).toBe(false);
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(client.createSession).toHaveBeenCalledOnce();
      expect(client.deleteSession).toHaveBeenCalledOnce();
    } finally {
      await shutdownDurableAiExecutorRegistry(registry);
    }
  });
});
