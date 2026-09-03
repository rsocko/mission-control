import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoustonRunEventMapper } from '@/lib/ai/copilot-run-events';
import type { CopilotRunRecord } from '@/lib/ai/copilot-session-lifecycle';
import type { DurableAiRunExecutor } from '@/lib/ai/durable-runs/worker';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-durable-ai-runs-'));
process.env.MC_DB_PATH = join(testDirectory, 'runs.db');
process.env.MC_AI_PROVIDER_SESSION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MC_AI_RUN_RETRY_BASE_MS = '1';

let database: typeof import('@/db');
let durable: typeof import('@/lib/ai/durable-runs') & {
  DurableAiRunStore:
    typeof import('@/lib/ai/durable-runs/sqlite-adapter').SqliteDurableAiRunStore;
};
let sqliteDurable: typeof import('@/lib/ai/durable-runs/sqlite-adapter');
let copilotPersistence: typeof import('@/lib/ai/durable-runs/copilot-adapter');

beforeAll(async () => {
  database = await import('@/db');
  const [durableModule, sqliteDurableModule] = await Promise.all([
    import('@/lib/ai/durable-runs'),
    import('@/lib/ai/durable-runs/sqlite-adapter'),
  ]);
  sqliteDurable = sqliteDurableModule;
  durable = {
    ...durableModule,
    DurableAiRunStore: sqliteDurableModule.SqliteDurableAiRunStore,
  };
  copilotPersistence = await import('@/lib/ai/durable-runs/copilot-adapter');
  database.sqlite.prepare('SELECT 1').get();
});

beforeEach(() => {
  database.sqlite.prepare('DELETE FROM ai_run_events').run();
  database.sqlite.prepare('DELETE FROM ai_provider_sessions').run();
  database.sqlite.prepare('DELETE FROM ai_runs').run();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  database.sqlite.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

function enqueue(
  store: InstanceType<typeof durable.DurableAiRunStore>,
  suffix: string,
  overrides: Partial<import('@/lib/ai/durable-runs').CreateDurableAiRunInput> = {},
) {
  return store.createRun({
    id: `run-${suffix}`,
    idempotencyKey: `feature:${suffix}`,
    featureId: 'durable-test',
    sensitivity: 'standard',
    executionRoute: 'test-route',
    requestedProvider: 'bifrost',
    requestedModel: 'azure/gpt-4o-mini',
    correlationId: `correlation-${suffix}`,
    timeoutMs: 60_000,
    ...overrides,
  });
}

function repository(
  store: InstanceType<typeof durable.DurableAiRunStore>,
) {
  return new sqliteDurable.SqliteDurableAiRunRepository(store);
}

describe('DurableAiRunStore', () => {
  it('deduplicates requests and isolates encrypted provider sessions', () => {
    const store = new durable.DurableAiRunStore();
    const first = enqueue(store, 'idempotent');
    const duplicate = enqueue(store, 'idempotent');

    expect(duplicate).toEqual({ run: first.run, created: false });
    expect(() => enqueue(store, 'idempotent', {
      requestedModel: 'different-model',
    })).toThrow(/different request/);

    store.setProviderSession(
      first.run.id,
      'github-copilot',
      'private-provider-session',
    );
    const stored = database.sqlite.prepare(`
      SELECT encrypted_reference AS encryptedReference
      FROM ai_provider_sessions WHERE run_id = ?
    `).get(first.run.id) as { encryptedReference: string };

    expect(stored.encryptedReference).not.toContain('private-provider-session');
    expect(store.getProviderSession(first.run.id)).toMatchObject({
      provider: 'github-copilot',
      reference: 'private-provider-session',
    });
    expect(JSON.stringify(store.getRun(first.run.id))).not.toContain(
      'private-provider-session',
    );
  });

  it('guards leases, retries idempotently, and reconnects by event cursor', () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'retry', { maxAttempts: 2 });
    const first = store.claimNextRun('worker-a', ['test-route'], 10_000)!;

    expect(first.id).toBe(run.id);
    expect(store.claimNextRun('worker-b', ['test-route'])).toBeNull();
    const retrying = store.failRun(
      run.id,
      'worker-a',
      new Error('Bearer private-token failed'),
      { code: 'temporary', retryable: true },
    );
    expect(retrying).toMatchObject({
      status: 'queued',
      lastErrorCode: 'temporary',
      lastErrorMessage: '[redacted] failed',
    });

    database.sqlite.prepare(`
      UPDATE ai_runs SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(run.id);
    const second = store.claimNextRun('worker-b', ['test-route'])!;
    const firstProgress = store.appendEvent(run.id, {
      idempotencyKey: 'provider:progress:1',
      kind: 'output.progress',
      payload: {
        bytes: 42,
        prompt: 'must not persist',
        accessToken: 'must not persist',
        input: 'must not persist',
        output: 'must not persist',
        delta: 'must not persist',
        text: 'must not persist',
        unknown: { nested: 'must not persist' },
      },
      provider: 'azure',
      model: 'gpt-4o-mini',
      fallbackState: 'used',
    });
    const revisionAfterProgress = store.getRun(run.id)!.revision;
    const duplicateProgress = store.appendEvent(run.id, {
      idempotencyKey: 'provider:progress:1',
      kind: 'output.progress',
      payload: { bytes: 99 },
    });
    expect(duplicateProgress.cursor).toBe(firstProgress.cursor);
    expect(store.getRun(run.id)!.revision).toBe(revisionAfterProgress);

    const completed = store.completeRun(run.id, 'worker-b', {
      provider: 'azure',
      model: 'gpt-4o-mini',
      fallbackState: 'used',
    });
    expect(completed).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      provider: 'azure',
      model: 'gpt-4o-mini',
      fallbackState: 'used',
    });
    const reconnect = store.getEventsAfter(run.id, firstProgress.cursor - 1);
    expect(reconnect[0]).toMatchObject({
      cursor: firstProgress.cursor,
      payload: { bytes: 42 },
    });
    expect(JSON.stringify(reconnect)).not.toContain('must not persist');
    const unknown = store.appendEvent(run.id, {
      idempotencyKey: 'provider:unknown:1',
      kind: 'provider.unregistered',
      payload: {
        bytes: 99,
        text: 'unknown payload must not persist',
      },
    });
    expect(unknown.payload).toEqual({});
    expect(JSON.stringify(store.getEventsAfter(run.id))).not.toContain(
      'unknown payload must not persist',
    );
    expect(second.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });

  it('makes cancellation and explicit retry transitions idempotent', () => {
    const store = new durable.DurableAiRunStore();
    const queued = enqueue(store, 'cancel').run;
    expect(store.requestCancellation(queued.id)?.status).toBe('cancelled');
    expect(store.requestCancellation(queued.id)?.status).toBe('cancelled');

    const racing = enqueue(store, 'cancel-race').run;
    store.claimNextRun('worker-race', ['test-route']);
    store.requestCancellation(racing.id);
    expect(() => store.completeRun(racing.id, 'worker-race')).toThrow(
      /cancellation took precedence/,
    );
    expect(store.failRun(racing.id, 'worker-race', 'cancelled')).toMatchObject({
      status: 'cancelled',
    });

    const failed = enqueue(store, 'manual-retry', { maxAttempts: 1 }).run;
    store.claimNextRun('worker-a', ['test-route']);
    store.failRun(failed.id, 'worker-a', 'failed', { retryable: false });
    const retried = store.retryRun(failed.id, 'retry-command-1')!;
    const duplicate = store.retryRun(failed.id, 'retry-command-1')!;
    expect(retried.status).toBe('queued');
    expect(duplicate.id).toBe(retried.id);
    expect(
      store.getEventsAfter(failed.id).filter(
        (event) => event.kind === 'run.retry_requested',
      ),
    ).toHaveLength(1);
  });

  it('uses stable compound history cursors when creation timestamps tie', () => {
    const store = new durable.DurableAiRunStore();
    const now = new Date('2026-08-06T17:00:00.000Z');
    enqueue(store, 'history-a', { id: 'history-a', now });
    enqueue(store, 'history-b', { id: 'history-b', now });
    enqueue(store, 'history-c', { id: 'history-c', now });

    const firstPage = store.listRuns({ limit: 2 });
    const last = firstPage.at(-1)!;
    const secondPage = store.listRuns({
      limit: 2,
      before: `${last.createdAt}|${last.id}`,
    });

    expect(firstPage.map((run) => run.id)).toEqual(['history-c', 'history-b']);
    expect(secondPage.map((run) => run.id)).toEqual(['history-a']);
  });

  it('caps, expires, and safely replaces protected provider sessions', () => {
    const store = new durable.DurableAiRunStore();
    const now = new Date();
    const { run } = enqueue(store, 'session-expiry');

    const first = store.setProviderSession(run.id, 'provider', 'first', {
      expiresAt: new Date(now.getTime() + 48 * 60 * 60_000),
      now,
    });
    expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(
      now.getTime() + 24 * 60 * 60_000,
    );
    expect(() => store.setProviderSession(run.id, 'provider', 'first', {
      expiresAt: new Date(now.getTime() - 1),
      now,
    })).toThrow(/future/);

    database.sqlite.prepare(`
      UPDATE ai_provider_sessions SET expires_at = ? WHERE run_id = ?
    `).run(new Date(now.getTime() + 1_000).toISOString(), run.id);
    const replacement = store.setProviderSession(run.id, 'provider', 'second', {
      now: new Date(now.getTime() + 2_000),
    });
    expect(replacement.reference).toBe('second');
    expect(
      store.getProviderSession(run.id, new Date(now.getTime() + 2_000)),
    ).toMatchObject({ reference: 'second' });
  });

  it('coordinates retries with cleanup and reclaims expired cleanup leases', () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'cleanup-recovery', { maxAttempts: 1 });
    const now = new Date();
    store.setProviderSession(run.id, 'provider', 'provider-session', { now });
    store.claimNextRun('worker-a', ['test-route'], 100, now);
    store.failRun(run.id, 'worker-a', 'failed', {
      retryable: false,
      now,
    });

    expect(store.claimCleanup('cleaner-a', ['test-route'], 100, now)?.id).toBe(
      run.id,
    );
    expect(() => store.retryRun(run.id, 'retry-during-cleanup', now)).toThrow(
      /cleanup is running/,
    );
    expect(
      store.renewCleanupLease(
        run.id,
        'cleaner-a',
        100,
        new Date(now.getTime() + 50),
      ),
    ).toBe(true);
    expect(
      store.claimCleanup(
        'cleaner-b',
        ['test-route'],
        100,
        new Date(now.getTime() + 125),
      ),
    ).toBeNull();
    expect(
      store.renewCleanupLease(
        run.id,
        'cleaner-a',
        100,
        new Date(now.getTime() + 151),
      ),
    ).toBe(false);
    expect(() => store.finishCleanup(
      run.id,
      'cleaner-a',
      undefined,
      new Date(now.getTime() + 151),
    )).toThrow(/ownership was lost/);
    expect(
      store.claimCleanup(
        'cleaner-b',
        ['test-route'],
        100,
        new Date(now.getTime() + 151),
      )?.id,
    ).toBe(run.id);
  });

  it('fences stale executors from events and provider session mutations', () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'stale-executor', { maxAttempts: 2 });
    const startedAt = new Date();
    const first = store.claimNextRun(
      'worker-a',
      ['test-route'],
      50,
      startedAt,
    )!;
    store.setProviderSessionForClaim(
      run.id,
      'worker-a',
      first.attempt,
      'provider',
      'first-session',
      { now: startedAt },
    );
    const recoveredAt = new Date(startedAt.getTime() + 51);
    expect(() => store.completeRun(
      run.id,
      'worker-a',
      {},
      recoveredAt,
    )).toThrow(/ownership was lost/);
    expect(() => store.failRun(
      run.id,
      'worker-a',
      'late failure',
      { now: recoveredAt },
    )).toThrow(/ownership was lost/);
    expect(store.recoverExpiredRuns(recoveredAt)).toBe(1);
    const second = store.claimNextRun(
      'worker-b',
      ['test-route'],
      100,
      recoveredAt,
    )!;

    expect(() => store.appendEventForClaim(
      run.id,
      'worker-a',
      first.attempt,
      {
        idempotencyKey: 'stale:event',
        kind: 'output.stale',
        now: recoveredAt,
      },
    )).toThrow(/ownership was lost/);
    expect(() => store.setProviderSessionForClaim(
      run.id,
      'worker-a',
      first.attempt,
      'provider',
      'stale-session',
      { now: recoveredAt },
    )).toThrow(/ownership was lost/);
    expect(() => store.revokeProviderSessionForClaim(
      run.id,
      'worker-a',
      first.attempt,
      recoveredAt,
    )).toThrow(/ownership was lost/);
    expect(() => store.getProviderSessionForClaim(
      run.id,
      'worker-a',
      first.attempt,
      recoveredAt,
    )).toThrow(/ownership was lost/);
    expect(second.attempt).toBe(2);
    expect(store.getProviderSession(run.id, recoveredAt)).toMatchObject({
      reference: 'first-session',
    });
  });

  it('redacts current provider key formats from durable text', () => {
    const redacted = durable.redactDurableAiText(
      'OpenAI sk-proj-abcdefghijklmnopqrstuvwxyz and '
      + 'Anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    );
    expect(redacted).not.toContain('sk-proj-');
    expect(redacted).not.toContain('sk-ant-');
    expect(redacted.match(/\[redacted\]/g)).toHaveLength(2);
    expect(durable.redactDurableAiText(
      String.raw`api_key="prefix-\"-private-remainder" safe=value`,
    )).toBe('api_key=[redacted] safe=value');
    expect(durable.sanitizeDurableAiEventPayload('run.active', {
      failure: { code: 'PRIVATE MODEL OUTPUT' },
      lifecycleState: 'active',
    })).toEqual({ lifecycleState: 'active' });
    expect(durable.sanitizeDurableAiEventPayload('model.usage', {
      usage: {
        endpoint: '/responses',
        inputTokens: 12,
      },
    })).toEqual({
      usage: {
        endpoint: '/responses',
        inputTokens: 12,
      },
    });
  });

  it('times out queued runs before retention without registered routes', () => {
    const store = new durable.DurableAiRunStore();
    const createdAt = new Date('2025-01-01T00:00:00.000Z');
    const { run } = enqueue(store, 'queued-timeout-retention', {
      timeoutMs: 1,
      now: createdAt,
    });

    expect(store.pruneExpired(new Date('2025-02-01T00:00:00.000Z'))).toMatchObject({
      deletedRuns: 1,
    });
    expect(store.getRun(run.id)).toBeNull();
  });

  it('records a distinct timeout event for an unclaimed explicit retry', () => {
    const store = new durable.DurableAiRunStore();
    const startedAt = new Date('2026-08-06T17:00:00.000Z');
    const { run } = enqueue(store, 'queued-retry-timeout', {
      timeoutMs: 1,
      now: startedAt,
    });
    store.expireTimedOutQueuedRuns(new Date(startedAt.getTime() + 2));
    store.retryRun(
      run.id,
      'queued-retry-timeout-command',
      new Date(startedAt.getTime() + 3),
    );
    database.sqlite.prepare(`
      UPDATE ai_runs SET timeout_at = ? WHERE id = ?
    `).run(new Date(startedAt.getTime() + 4).toISOString(), run.id);
    store.expireTimedOutQueuedRuns(new Date(startedAt.getTime() + 5));

    expect(
      store.getEventsAfter(run.id).filter((event) => event.kind === 'run.timed_out'),
    ).toHaveLength(2);
  });

  it('revokes expired sessions and prunes terminal metadata by policy', () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'retention');
    store.setProviderSession(run.id, 'provider', 'private-session');
    store.requestCancellation(run.id);
    database.sqlite.prepare(`
      UPDATE ai_provider_sessions SET expires_at = '2000-01-01T00:00:00.000Z'
    `).run();
    database.sqlite.prepare(`
      UPDATE ai_runs SET expires_at = '2000-01-01T00:00:00.000Z'
    `).run();

    expect(store.pruneExpired()).toEqual({
      deletedRuns: 1,
      revokedProviderSessions: 1,
    });
    expect(store.getRun(run.id)).toBeNull();
  });
});

describe('DurableAiRunRepository contract', () => {
  it('exposes every SQLite operation asynchronously without changing its result', async () => {
    const store = new durable.DurableAiRunStore();
    const durableRuns = repository(store);
    const now = new Date('2026-08-06T17:00:00.000Z');
    const created = await durableRuns.createRun({
      id: 'contract-run',
      idempotencyKey: 'contract:create',
      featureId: 'contract-test',
      sensitivity: 'standard',
      executionRoute: 'contract-route',
      maxAttempts: 1,
      timeoutMs: 60_000,
      now,
    });
    expect(created.created).toBe(true);
    await expect(durableRuns.createRun({
      id: 'contract-run-duplicate',
      idempotencyKey: 'contract:create',
      featureId: 'contract-test',
      sensitivity: 'standard',
      executionRoute: 'contract-route',
      maxAttempts: 1,
      timeoutMs: 60_000,
      now,
    })).resolves.toEqual({ run: created.run, created: false });
    await expect(durableRuns.getRun(created.run.id)).resolves.toEqual(created.run);
    await expect(durableRuns.getInternalRun(created.run.id)).resolves.toMatchObject({
      id: created.run.id,
      idempotencyKey: 'contract:create',
    });
    await expect(durableRuns.listRuns({ featureId: 'contract-test' })).resolves
      .toHaveLength(1);
    await expect(durableRuns.listInternalRunsByRoute('contract-route')).resolves
      .toHaveLength(1);

    const appended = await durableRuns.appendEvent(created.run.id, {
      idempotencyKey: 'contract:event',
      kind: 'contract.event',
      payload: { token: 'removed', progress: 1 },
      now,
    });
    await expect(durableRuns.appendEvent(created.run.id, {
      idempotencyKey: 'contract:event',
      kind: 'contract.event',
      payload: { progress: 2 },
      now,
    })).resolves.toEqual(appended);
    await expect(durableRuns.getEventsAfter(created.run.id)).resolves
      .toContainEqual(appended);
    await expect(durableRuns.getEventIdempotencyKeys(created.run.id)).resolves
      .toContain('contract:event');

    const claimed = await durableRuns.claimNextRun(
      'contract-owner',
      ['contract-route'],
      30_000,
      now,
    );
    expect(claimed).toMatchObject({ id: created.run.id, attempt: 1 });
    await expect(durableRuns.renewLease(
      created.run.id,
      'contract-owner',
      30_000,
      new Date(now.getTime() + 1),
    )).resolves.toBe(true);
    await expect(durableRuns.appendEventForClaim(
      created.run.id,
      'contract-owner',
      1,
      { idempotencyKey: 'contract:claimed', kind: 'contract.claimed', now },
    )).resolves.toMatchObject({ kind: 'contract.claimed' });
    await expect(durableRuns.setProviderSessionForClaim(
      created.run.id,
      'contract-owner',
      1,
      'provider',
      'private-session',
      { now },
    )).resolves.toMatchObject({ provider: 'provider', reference: 'private-session' });
    await expect(durableRuns.getProviderSessionForClaim(
      created.run.id,
      'contract-owner',
      1,
      now,
    )).resolves.toMatchObject({ reference: 'private-session' });
    await expect(durableRuns.revokeProviderSessionForClaim(
      created.run.id,
      'contract-owner',
      1,
      now,
    )).resolves.toBe(true);
    await expect(durableRuns.completeRun(
      created.run.id,
      'contract-owner',
      { provider: 'provider', model: 'model' },
      new Date(now.getTime() + 2),
    )).resolves.toMatchObject({ status: 'succeeded' });

    await expect(durableRuns.claimNextRun('nobody', [], 1, now)).resolves.toBeNull();
    await expect(durableRuns.claimCleanup('nobody', [], 1, now)).resolves.toBeNull();
    await expect(durableRuns.requestCancellation('missing', now)).resolves.toBeNull();
    await expect(durableRuns.retryRun('missing', 'contract:retry', now)).resolves
      .toBeNull();
    await expect(durableRuns.isCancellationRequested('missing')).resolves.toBe(false);
    await expect(durableRuns.renewLease('missing', 'nobody', 1, now)).resolves.toBe(false);
    await expect(durableRuns.renewCleanupLease('missing', 'nobody', 1, now)).resolves
      .toBe(false);
    await expect(durableRuns.getProviderSession('missing', now)).resolves.toBeNull();
    await expect(durableRuns.revokeProviderSession('missing', now)).resolves.toBe(false);
    await expect(durableRuns.expireTimedOutQueuedRuns(now)).resolves.toBe(0);
    await expect(durableRuns.recoverExpiredRuns(now, [])).resolves.toBe(0);
    await expect(durableRuns.pruneExpired(now)).resolves.toEqual({
      deletedRuns: 0,
      revokedProviderSessions: 0,
    });
  });

  it('propagates synchronous SQLite failures as rejected promises', async () => {
    const durableRuns = repository(new durable.DurableAiRunStore());

    await expect(durableRuns.appendEvent('missing', {
      idempotencyKey: 'contract:error',
      kind: 'contract.error',
    })).rejects.toThrow('was not found');
  });
});

describe('DurableAiRunWorker', () => {
  it('stays dormant until activation and wakes without waiting for the poll interval', async () => {
    const store = new durable.DurableAiRunStore();
    const durableRuns = repository(store);
    const { run } = enqueue(store, 'activation');
    const claimNext = vi.spyOn(durableRuns, 'claimNext');
    let enabled = false;
    const execute = vi.fn(async () => undefined);
    const worker = new durable.DurableAiRunWorker(
      durableRuns,
      new Map([['test-route', { execute } satisfies DurableAiRunExecutor]]),
      {
        ownerId: 'activation-worker',
        pollIntervalMs: 60_000,
        isEnabled: () => enabled,
      },
    );

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(claimNext).not.toHaveBeenCalled();
    expect(store.getRun(run.id)?.status).toBe('queued');

    enabled = true;
    worker.wake();
    worker.wake();
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('succeeded'));
    await worker.stop();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight asynchronous heartbeat before committing terminal state', async () => {
    const store = new durable.DurableAiRunStore();
    const durableRuns = repository(store);
    const { run } = enqueue(store, 'async-heartbeat');
    let finishExecution!: () => void;
    let finishHeartbeat!: (renewed: boolean) => void;
    const execution = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const heartbeat = new Promise<boolean>((resolve) => {
      finishHeartbeat = resolve;
    });
    vi.spyOn(durableRuns, 'renewLease').mockReturnValue(heartbeat);
    const worker = new durable.DurableAiRunWorker(
      durableRuns,
      new Map([[
        'test-route',
        { async execute() { await execution; } } satisfies DurableAiRunExecutor,
      ]]),
      { ownerId: 'async-heartbeat-worker', leaseMs: 300 },
    );

    const work = worker.runOnce();
    await vi.waitFor(() => {
      expect(durableRuns.renewLease).toHaveBeenCalledOnce();
    });
    finishExecution();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getRun(run.id)?.status).toBe('running');
    finishHeartbeat(true);
    await work;

    expect(store.getRun(run.id)?.status).toBe('succeeded');
  });

  it('does not recover leases for routes without a registered executor', async () => {
    const store = new durable.DurableAiRunStore();
    const startedAt = new Date(Date.now() - 1_000);
    const { run } = enqueue(store, 'unregistered-recovery', {
      executionRoute: 'external-route',
      now: startedAt,
    });
    store.claimNextRun('external-worker', ['external-route'], 50, startedAt);
    const worker = new durable.DurableAiRunWorker(
      repository(store),
      new Map([[
        'owned-route',
        { async execute() {} } satisfies DurableAiRunExecutor,
      ]]),
      { ownerId: 'maintenance-worker' },
    );
    const queued = enqueue(store, 'unregistered-queued-timeout', {
      executionRoute: 'another-external-route',
      timeoutMs: 1,
      now: startedAt,
    }).run;

    expect(await worker.runOnce()).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(store.getRun(queued.id)?.status).toBe('timed_out');
  });

  it('propagates cancellation and performs provider cleanup', async () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'worker-cancel');
    const cancel = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const executor: DurableAiRunExecutor = {
      async execute(context) {
        await context.setProviderSession('provider', 'provider-session');
        await new Promise<void>((resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
      cancel,
      cleanup,
    };
    const worker = new durable.DurableAiRunWorker(
      repository(store),
      new Map([['test-route', executor]]),
      { ownerId: 'worker-cancel', leaseMs: 1_000 },
    );

    const executing = worker.runOnce();
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('running'));
    store.requestCancellation(run.id);
    await executing;

    expect(cancel).toHaveBeenCalledOnce();
    expect(store.getRun(run.id)).toMatchObject({
      status: 'cancelled',
      cleanupStatus: 'pending',
    });
    await worker.runOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(store.getRun(run.id)?.cleanupStatus).toBe('completed');
    expect(store.getProviderSession(run.id)).toBeNull();
  });

  it('times out execution and invokes the provider cancellation seam', async () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'worker-timeout', { timeoutMs: 25 });
    const cancel = vi.fn(async () => undefined);
    const executor: DurableAiRunExecutor = {
      async execute(context) {
        await new Promise<void>((resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
      cancel,
    };
    const worker = new durable.DurableAiRunWorker(
      repository(store),
      new Map([['test-route', executor]]),
      { ownerId: 'worker-timeout', leaseMs: 100 },
    );

    await worker.runOnce();

    expect(cancel).toHaveBeenCalledOnce();
    expect(store.getRun(run.id)).toMatchObject({
      status: 'timed_out',
      lastErrorCode: 'run_timeout',
    });
  });

  it('closes a timed-out run even when its executor ignores aborts', async () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'worker-non-cooperative', { timeoutMs: 25 });
    let emitAfterTimeout: (() => Promise<void>) | undefined;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const executor: DurableAiRunExecutor = {
      async execute(context) {
        emitAfterTimeout = () => context.emit('output.too_late');
        await new Promise<void>(() => undefined);
      },
      cancel,
    };
    const worker = new durable.DurableAiRunWorker(
      repository(store),
      new Map([['test-route', executor]]),
      { ownerId: 'worker-non-cooperative', leaseMs: 100 },
    );

    await worker.runOnce();

    expect(cancel).toHaveBeenCalledOnce();
    expect(store.getRun(run.id)?.status).toBe('timed_out');
    expect(emitAfterTimeout).toBeDefined();
    await expect(emitAfterTimeout!()).rejects.toThrow(/execution is closed/);
  });

  it('bounds hung provider cleanup and leaves it retryable', async () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'worker-cleanup-timeout', { maxAttempts: 1 });
    store.setProviderSession(run.id, 'provider', 'provider-session');
    store.claimNextRun('setup-worker', ['test-route']);
    store.failRun(run.id, 'setup-worker', 'failed', { retryable: false });
    const cleanup = vi.fn(() => new Promise<void>(() => undefined));
    const executor: DurableAiRunExecutor = {
      async execute() {},
      cleanup,
    };
    const worker = new durable.DurableAiRunWorker(
      repository(store),
      new Map([['test-route', executor]]),
      {
        ownerId: 'cleanup-worker',
        leaseMs: 100,
        cleanupTimeoutMs: 25,
      },
    );

    await worker.runOnce();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(store.getRun(run.id)).toMatchObject({
      cleanupStatus: 'failed',
      lastErrorCode: 'provider_cleanup_failed',
    });
  });

  it('reports asynchronous retention failures and releases its timer on stop', async () => {
    const durableRuns = repository(new durable.DurableAiRunStore());
    const failure = new Error('retention unavailable');
    vi.spyOn(durableRuns, 'pruneExpired').mockRejectedValue(failure);
    const reportError = vi.fn();
    const worker = new durable.DurableAiRunWorker(durableRuns, new Map(), {
      pollIntervalMs: 5,
      pruneIntervalMs: 5,
      reportError,
    });

    worker.start();
    await vi.waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(failure, 'retention', undefined);
    });
    await worker.stop();
    const callCount = reportError.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(reportError).toHaveBeenCalledTimes(callCount);
  });
});

describe('Copilot durable persistence adapter', () => {
  it('persists lifecycle state and content-free events without exposing the SDK session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T17:00:00.000Z'));
    const store = new durable.DurableAiRunStore();
    const persistence = await copilotPersistence.createDurableCopilotPersistence(
      'copilot-worker',
      repository(store),
    );
    const record: CopilotRunRecord = {
      runId: 'copilot-run',
      featureId: 'houston-chat',
      sensitivity: 'standard',
      correlationId: 'copilot-correlation',
      model: 'gpt-5-mini',
      state: 'active',
      connection: 'attached',
      providerSessionId: 'private-copilot-session',
      traceContext: {
        traceparent:
          '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      },
      ownerId: 'copilot-worker',
      leaseExpiresAt: Date.parse('2026-08-06T18:00:00.000Z'),
      revision: 0,
      createdAt: Date.parse('2026-08-06T17:00:00.000Z'),
      updatedAt: Date.parse('2026-08-06T17:00:00.000Z'),
    };

    expect(await persistence.store.create(record)).toBe(true);
    expect(await persistence.store.create(record)).toBe(false);
    expect(await persistence.store.get(record.runId)).toMatchObject(record);
    expect(JSON.stringify(store.getRun(record.runId))).not.toContain(
      'private-copilot-session',
    );
    expect(await persistence.store.compareAndSet(0, {
      ...record,
      ownerId: 'premature-takeover-worker',
      revision: 1,
      updatedAt: record.updatedAt + 1,
    })).toBe(false);
    expect(await persistence.store.compareAndSet(0, {
      ...record,
      revision: 1,
      updatedAt: record.leaseExpiresAt + 1,
      leaseExpiresAt: record.leaseExpiresAt + 60_000,
    })).toBe(false);
    await expect(persistence.store.compareAndSet(0, {
      ...record,
      state: 'idle',
      providerSessionId: 'competing-copilot-session',
      revision: 1,
      updatedAt: record.updatedAt + 2,
    })).rejects.toThrow(/different provider session/);
    expect(await persistence.store.get(record.runId)).toMatchObject({
      state: 'active',
      providerSessionId: 'private-copilot-session',
      revision: 0,
    });
    store.requestCancellation(record.runId);
    expect(await persistence.store.compareAndSet(0, {
      ...record,
      state: 'idle',
      revision: 1,
      updatedAt: record.updatedAt + 2,
    })).toBe(false);
    expect(store.getRun(record.runId)?.status).toBe('cancelling');
    expect(await persistence.store.compareAndSet(0, {
      ...record,
      state: 'completed',
      terminalState: 'cancelled',
      cleanupPending: true,
      connection: 'detached',
      revision: 1,
      updatedAt: record.updatedAt + 3,
    })).toBe(true);
    expect(store.getRun(record.runId)?.status).toBe('cancelled');

    const mapper = new HoustonRunEventMapper({
      runId: record.runId,
      correlationId: record.correlationId,
      featureId: record.featureId,
      sensitivity: 'standard',
      model: record.model,
      traceContext: record.traceContext,
    });
    const disposition = mapper.mapLifecycle({
      ...record,
      state: 'active',
      connection: 'attached',
    });
    expect(disposition.accepted).toBe(true);
    if (!disposition.accepted) throw new Error('Expected a mapped lifecycle event.');
    await persistence.eventSink.emit(disposition.event);
    await expect(new copilotPersistence.DurableCopilotEventSink(
      repository(store),
      'stale-copilot-worker',
    ).emit(disposition.event)).rejects.toThrow(/ownership was lost/);

    expect(await copilotPersistence.getDurableCopilotEventCursor(
      repository(store),
      record.runId,
    )).toMatchObject({
      sequence: 1,
      parentEventId: disposition.event.eventId,
    });
    await persistence.primeEventCursor(record.runId);
    expect(persistence.eventCursor(record.runId)).toMatchObject({
      sequence: 1,
      parentEventId: disposition.event.eventId,
    });
    expect(persistence.eventCursor(record.runId)).toBeUndefined();
    expect(JSON.stringify(store.getEventsAfter(record.runId))).not.toContain(
      'private-copilot-session',
    );

    for (let index = 0; index < 101; index += 1) {
      enqueue(store, `newer-${index}`, {
        now: new Date(`2027-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`),
      });
    }
    expect((await persistence.store.list()).map((run) => run.runId)).toContain(
      record.runId,
    );
  });

  it('restores event cursors beyond a single event page', async () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'copilot-long-cursor');
    for (let sequence = 1; sequence <= 1_001; sequence += 1) {
      store.appendEvent(run.id, {
        idempotencyKey: `copilot:event:${sequence}`,
        kind: 'run.active',
        payload: {
          sequence,
          eventId: `copilot-event-${sequence}`,
        },
      });
    }

    expect(await copilotPersistence.getDurableCopilotEventCursor(repository(store), run.id))
      .toMatchObject({
        sequence: 1_001,
        parentEventId: 'copilot-event-1001',
      });
  });
});

describe('durable run API', () => {
  it('returns reconnectable status/events and protects mutations', async () => {
    const store = new durable.DurableAiRunStore();
    const { run } = enqueue(store, 'api');
    const { GET: getStatus } = await import('@/app/api/ai/runs/[runId]/route');
    const { GET: getEvents } = await import(
      '@/app/api/ai/runs/[runId]/events/route'
    );
    const { POST: cancel } = await import(
      '@/app/api/ai/runs/[runId]/cancel/route'
    );

    const statusResponse = await getStatus(
      new Request(`http://localhost/api/ai/runs/${run.id}`),
      { params: Promise.resolve({ runId: run.id }) },
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      run: { id: run.id, correlationId: run.correlationId },
    });
    store.appendEvent(run.id, {
      idempotencyKey: 'api:sensitive-progress',
      kind: 'output.progress',
      payload: {
        bytes: 7,
        input: 'api input must not reconnect',
        output: 'api output must not reconnect',
        delta: 'api delta must not reconnect',
        text: 'api text must not reconnect',
        unknown: 'api unknown must not reconnect',
      },
    });

    const eventResponse = await getEvents(
      new Request(`http://localhost/api/ai/runs/${run.id}/events?after=0`),
      { params: Promise.resolve({ runId: run.id }) },
    );
    const eventBody = await eventResponse.json();
    expect(eventBody).toMatchObject({
      events: [
        { kind: 'run.queued' },
        { kind: 'output.progress', payload: { bytes: 7 } },
      ],
      nextCursor: expect.any(Number),
    });
    expect(JSON.stringify(eventBody)).not.toContain('must not reconnect');

    const unauthorized = await cancel(
      new Request(`http://localhost/api/ai/runs/${run.id}/cancel`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ runId: run.id }) },
    );
    expect(unauthorized.status).toBe(401);
    vi.stubEnv('MC_API_KEY', 'durable-run-api-key');
    const authorized = await cancel(
      new Request(`http://localhost/api/ai/runs/${run.id}/cancel`, {
        method: 'POST',
        headers: {
          'x-mc-api-key': 'durable-run-api-key',
        },
      }),
      { params: Promise.resolve({ runId: run.id }) },
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      run: { status: 'cancelled' },
    });
  });
});
