import type { Pool, PoolClient, QueryResult } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { PostgresDurableAiRunRepository, durableAiRequestFingerprint } from '@/lib/ai/durable-runs/postgres-adapter';

process.env.MC_AI_PROVIDER_SESSION_KEY ??= Buffer.alloc(32, 7).toString('base64');

interface RecordedStatement {
  text: string;
  params: unknown[];
}

type FakeRow = Record<string, unknown>;

function runRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 'run-1',
    idempotencyKey: 'feature:run-1',
    requestFingerprint: 'fingerprint',
    featureId: 'durable-test',
    sensitivity: 'standard',
    status: 'running',
    executionRoute: 'test-route',
    requestedProvider: null,
    requestedModel: null,
    provider: null,
    model: null,
    fallbackState: 'not_requested',
    correlationId: 'correlation-1',
    traceparent: null,
    tracestate: null,
    attempt: 1,
    maxAttempts: 3,
    availableAt: '2026-01-01T00:00:00.000Z',
    timeoutAt: '2026-01-01T00:15:00.000Z',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-01-01T00:02:00.000Z',
    cancelRequestedAt: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    notifyOnCompletion: true,
    cleanupStatus: 'none',
    executionState: null,
    revision: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Minimal `pg` stand-in that records every statement, asserts that each one
 * binds exactly the placeholders it references, and answers reads from
 * test-controlled rows. It verifies statement shape and fencing, not
 * PostgreSQL execution semantics — those belong to the live integration suite.
 */
class FakePostgres {
  readonly statements: RecordedStatement[] = [];

  run: FakeRow | null = runRow();

  runByIdempotencyKey: FakeRow | null = null;

  claimCandidate: FakeRow | null = null;

  cleanupCandidate: FakeRow | null = null;

  expiredLeaseScan: FakeRow[] = [];

  expiredQueuedScan: { id: string }[] = [];

  providerSession: FakeRow | null = null;

  existingEventKeys = new Set<string>();

  activeProviderSession = false;

  private sequence = 0;

  private cursor = 0;

  get pool(): Pool {
    const client: PoolClient = {
      query: (text: string, params?: unknown[]) => this.dispatch(text, params ?? []),
      release: () => undefined,
    } as unknown as PoolClient;
    return {
      query: (text: string, params?: unknown[]) => this.dispatch(text, params ?? []),
      connect: async () => client,
    } as unknown as Pool;
  }

  texts(): string[] {
    return this.statements.map((statement) => statement.text);
  }

  find(fragment: string): RecordedStatement {
    const match = this.statements.find((statement) => statement.text.includes(fragment));
    if (!match) {
      throw new Error(
        `No statement matched "${fragment}". Recorded:\n${this.texts().join('\n')}`,
      );
    }
    return match;
  }

  private async dispatch(
    rawText: string,
    params: unknown[],
  ): Promise<QueryResult<FakeRow>> {
    const text = rawText.replace(/\s+/g, ' ').trim();
    this.statements.push({ text, params });
    assertPlaceholderBinding(text, params);
    return this.resolve(text) as QueryResult<FakeRow>;
  }

  private resolve(text: string): { rows: FakeRow[]; rowCount: number } {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return rows([]);
    if (text.includes('pg_advisory_xact_lock')) return rows([{}]);

    if (text.startsWith('SELECT COALESCE(MAX(sequence)')) {
      this.sequence += 1;
      return rows([{ sequence: this.sequence }]);
    }
    if (text.startsWith('INSERT INTO ai_run_events')) {
      this.cursor += 1;
      return rows([{ cursor: this.cursor }], 1);
    }
    if (text.includes('FROM ai_run_events')) {
      if (text.includes('idempotency_key AS')) {
        return rows([...this.existingEventKeys].map((key) => ({ idempotencyKey: key })));
      }
      const key = text.includes('idempotency_key = $2')
        ? this.statements.at(-1)?.params[1]
        : undefined;
      if (typeof key === 'string' && this.existingEventKeys.has(key)) {
        return rows([eventRow(key)]);
      }
      if (text.includes('id > $2')) return rows([eventRow('run:queued')]);
      return rows([]);
    }

    if (text.startsWith('INSERT INTO ai_runs')) {
      this.run = runRow({ status: 'queued', attempt: 0, revision: 0, leaseOwner: null });
      return rows([], 1);
    }
    if (text.startsWith('UPDATE ai_runs')) return rows([], 1);
    if (text.startsWith('DELETE FROM ai_runs')) return rows([], 2);

    if (text.startsWith('INSERT INTO ai_provider_sessions')) return rows([], 1);
    if (text.startsWith('UPDATE ai_provider_sessions')) return rows([], 1);
    if (text.startsWith('SELECT 1 FROM ai_provider_sessions')) {
      return rows(this.activeProviderSession ? [{ '?column?': 1 }] : []);
    }
    if (text.includes('FROM ai_provider_sessions')) {
      return rows(this.providerSession ? [this.providerSession] : []);
    }

    if (text.includes('FROM ai_runs')) {
      if (text.includes('WHERE idempotency_key = $1')) {
        return rows(this.runByIdempotencyKey ? [this.runByIdempotencyKey] : []);
      }
      if (text.includes("WHERE status = 'queued' AND timeout_at <= $1")) {
        return rows(this.expiredQueuedScan);
      }
      if (text.includes('WHERE status = ANY($1') && text.includes('lease_expires_at <=')) {
        return rows(this.expiredLeaseScan);
      }
      if (text.includes('cleanup_status = ANY($1')) {
        return rows(this.cleanupCandidate ? [this.cleanupCandidate] : []);
      }
      if (text.includes('execution_route = ANY($2')) {
        return rows(this.claimCandidate ? [this.claimCandidate] : []);
      }
      if (text.includes('WHERE id IN (')) return rows([]);
      if (text.includes('WHERE id = $1')) return rows(this.run ? [this.run] : []);
      return rows(this.run ? [this.run] : []);
    }

    throw new Error(`Unexpected statement: ${text}`);
  }
}

function rows(list: FakeRow[], rowCount = list.length) {
  return { rows: list, rowCount };
}

function eventRow(idempotencyKey: string): FakeRow {
  return {
    cursor: 1,
    eventId: `event-${idempotencyKey}`,
    runId: 'run-1',
    sequence: 1,
    kind: 'run.queued',
    payload: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function assertPlaceholderBinding(text: string, params: unknown[]): void {
  const referenced = new Set(
    [...text.matchAll(/\$(\d+)/g)].map(([, index]) => Number(index)),
  );
  const highest = referenced.size === 0 ? 0 : Math.max(...referenced);
  expect(
    { statement: text, highest, bound: params.length },
    'every bound parameter must be referenced exactly once by number',
  ).toEqual({ statement: text, highest: params.length, bound: params.length });
  for (let index = 1; index <= highest; index += 1) {
    expect(referenced.has(index), `${text} is missing $${index}`).toBe(true);
  }
}

function repositoryFor(fake: FakePostgres) {
  return new PostgresDurableAiRunRepository(fake.pool);
}

const NOW = new Date('2026-01-01T00:01:00.000Z');

describe('PostgreSQL durable AI run repository — statement shape', () => {
  let fake: FakePostgres;

  beforeEach(() => {
    fake = new FakePostgres();
  });

  it('creates runs inside one transaction fenced by the idempotency key', async () => {
    fake.run = null;
    const { created } = await repositoryFor(fake).createRun({
      idempotencyKey: 'feature:run-1',
      featureId: 'durable-test',
      sensitivity: 'standard',
      executionRoute: 'test-route',
      now: NOW,
    });

    expect(created).toBe(true);
    expect(fake.texts()[0]).toBe('BEGIN');
    expect(fake.texts().at(-1)).toBe('COMMIT');
    expect(fake.texts()[1]).toContain('pg_advisory_xact_lock');
    expect(fake.find('INSERT INTO ai_runs').text).toContain("'queued'");
    expect(fake.find('INSERT INTO ai_run_events').params).toContain('run:queued');
  });

  it('returns the existing run when the idempotent request repeats', async () => {
    const input = {
      idempotencyKey: 'feature:run-1',
      featureId: 'durable-test',
      sensitivity: 'standard',
      executionRoute: 'test-route',
      now: NOW,
    } as const;
    fake.runByIdempotencyKey = runRow({
      requestFingerprint: durableAiRequestFingerprint(input),
    });
    const { created } = await repositoryFor(fake).createRun(input);

    expect(created).toBe(false);
    expect(fake.texts().some((text) => text.startsWith('INSERT INTO ai_runs'))).toBe(false);
  });

  it('rejects an idempotency key bound to a different request', async () => {
    fake.runByIdempotencyKey = runRow({ requestFingerprint: 'other-fingerprint' });
    await expect(repositoryFor(fake).createRun({
      idempotencyKey: 'feature:run-1',
      featureId: 'durable-test',
      sensitivity: 'standard',
      executionRoute: 'test-route',
      now: NOW,
    })).rejects.toThrow(
      'The durable AI run idempotency key is already bound to a different request.',
    );
    expect(fake.texts()).toContain('ROLLBACK');
    expect(fake.texts()).not.toContain('COMMIT');
  });

  it('claims queued work with SKIP LOCKED and a revision fence', async () => {
    fake.claimCandidate = runRow({ status: 'queued', attempt: 0, leaseOwner: null });
    const claimed = await repositoryFor(fake).claimNextRun(
      'worker-a',
      ['test-route'],
      120_000,
      NOW,
    );

    expect(claimed?.id).toBe('run-1');
    const candidate = fake.find("WHERE status = 'queued' AND cancel_requested_at IS NULL");
    expect(candidate.text).toContain('execution_route = ANY($2::text[])');
    expect(candidate.text).toContain('FOR UPDATE SKIP LOCKED');
    const claim = fake.find("UPDATE ai_runs SET status = 'running'");
    expect(claim.text).toContain("WHERE id = $4 AND status = 'queued' AND revision = $5");
    expect(claim.params).toEqual([
      'worker-a',
      '2026-01-01T00:03:00.000Z',
      NOW.toISOString(),
      'run-1',
      4,
    ]);
    expect(fake.find('INSERT INTO ai_run_events').params).toContain(
      'run:attempt:1:started',
    );
  });

  it('renews an execution lease only for the live owning lease', async () => {
    const renewed = await repositoryFor(fake).renewLease('run-1', 'worker-a', 60_000, NOW);

    expect(renewed).toBe(true);
    const statement = fake.find('UPDATE ai_runs SET lease_expires_at = $1');
    expect(statement.text).toContain('AND lease_owner = $5');
    expect(statement.text).toContain('AND lease_expires_at > $2');
    expect(statement.params).toEqual([
      '2026-01-01T00:02:00.000Z',
      NOW.toISOString(),
      'run-1',
      ['running', 'cancelling'],
      'worker-a',
    ]);
  });

  it('finishes an owned run fenced by owner, revision, and lease liveness', async () => {
    const run = await repositoryFor(fake).completeRun(
      'run-1',
      'worker-a',
      { provider: 'bifrost', model: 'azure/gpt-4o-mini' },
      NOW,
    );

    expect(run.id).toBe('run-1');
    const statement = fake.find('UPDATE ai_runs SET status = $1');
    expect(statement.text).toContain('WHERE id = $9 AND revision = $10 AND lease_owner = $11');
    expect(statement.text).toContain('AND lease_expires_at > $5');
    expect(statement.params[0]).toBe('succeeded');
    expect(fake.find('INSERT INTO ai_run_events').params).toContain(
      'run:terminal:succeeded:attempt:1',
    );
  });

  it('refuses to finish a run whose lease moved to another owner', async () => {
    fake.run = runRow({ leaseOwner: 'worker-b' });
    await expect(
      repositoryFor(fake).completeRun('run-1', 'worker-a', {}, NOW),
    ).rejects.toThrow('Durable AI run run-1 ownership was lost.');
    expect(fake.texts()).toContain('ROLLBACK');
  });

  it('requeues a retryable failure without releasing the fence', async () => {
    const run = await repositoryFor(fake).failRun(
      'run-1',
      'worker-a',
      new Error('provider exploded'),
      { now: NOW },
    );

    expect(run.id).toBe('run-1');
    const statement = fake.find("UPDATE ai_runs SET status = 'queued', available_at = $1");
    expect(statement.text).toContain('WHERE id = $8 AND revision = $9 AND lease_owner = $10');
    expect(statement.text).toContain('AND lease_expires_at > $7');
    expect(fake.find('INSERT INTO ai_run_events').params).toContain(
      'run:attempt:1:retry',
    );
  });

  it('drives an exhausted failure to a terminal state', async () => {
    fake.run = runRow({ attempt: 3, maxAttempts: 3 });
    const run = await repositoryFor(fake).failRun('run-1', 'worker-a', 'boom', {
      now: NOW,
    });

    expect(run.id).toBe('run-1');
    expect(fake.find('UPDATE ai_runs SET status = $1').params[0]).toBe('failed');
  });

  it('recovers expired leases and expires stale queued runs under SKIP LOCKED', async () => {
    fake.expiredLeaseScan = [runRow({ attempt: 1, leaseExpiresAt: '2026-01-01T00:00:30.000Z' })];
    fake.expiredQueuedScan = [{ id: 'run-2' }];

    const recovered = await repositoryFor(fake).recoverExpiredRuns(NOW, ['test-route']);
    expect(recovered).toBe(1);
    expect(fake.find('lease_expires_at <=').text).toContain('FOR UPDATE SKIP LOCKED');

    fake = new FakePostgres();
    fake.expiredQueuedScan = [{ id: 'run-2' }];
    const expired = await repositoryFor(fake).expireTimedOutQueuedRuns(NOW);
    expect(expired).toBe(1);
    const scan = fake.find("WHERE status = 'queued' AND timeout_at <= $1");
    expect(scan.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(fake.find('INSERT INTO ai_run_events').params).toContain(
      'run:terminal:timed_out:attempt:1:revision:4',
    );
  });

  it('claims cleanup work from the persisted lease alone', async () => {
    fake.cleanupCandidate = runRow({
      status: 'failed',
      cleanupStatus: 'pending',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const claimed = await repositoryFor(fake).claimCleanup(
      'cleaner-a',
      ['test-route'],
      120_000,
      NOW,
    );

    expect(claimed?.id).toBe('run-1');
    const scan = fake.find('cleanup_status = ANY($1::text[])');
    expect(scan.text).toContain('AND (lease_expires_at IS NULL OR lease_expires_at <= $3)');
    expect(scan.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(fake.find("SET cleanup_status = 'running'").text).toContain(
      'WHERE id = $4 AND revision = $5',
    );
  });

  it('finishes cleanup fenced by the cleanup lease and revokes the session', async () => {
    fake.run = runRow({ status: 'failed', cleanupStatus: 'running', leaseOwner: 'cleaner-a' });
    const run = await repositoryFor(fake).finishCleanup('run-1', 'cleaner-a', undefined, NOW);

    expect(run.id).toBe('run-1');
    const statement = fake.find('UPDATE ai_runs SET cleanup_status = $1');
    expect(statement.text).toContain('WHERE id = $6 AND revision = $7 AND lease_owner = $8');
    expect(fake.find('UPDATE ai_provider_sessions').text).toContain(
      "WHERE run_id = $2 AND state = 'active'",
    );
  });

  it('writes provider sessions encrypted and only for an unheld session row', async () => {
    const session = await repositoryFor(fake).setProviderSessionForClaim(
      'run-1',
      'worker-a',
      1,
      'bifrost',
      'session-reference',
      { now: NOW },
    );

    expect(session.reference).toBe('session-reference');
    const insert = fake.find('INSERT INTO ai_provider_sessions');
    expect(insert.text).toContain('ON CONFLICT (run_id) DO UPDATE SET');
    expect(insert.text).toContain(
      "WHERE ai_provider_sessions.state = 'revoked' OR ai_provider_sessions.expires_at <= $8",
    );
    expect(insert.params[2]).not.toBe('session-reference');
  });

  it('rejects provider session writes from a stale claim', async () => {
    await expect(repositoryFor(fake).setProviderSessionForClaim(
      'run-1',
      'worker-a',
      2,
      'bifrost',
      'session-reference',
      { now: NOW },
    )).rejects.toThrow('Durable AI run run-1 ownership was lost.');
    expect(fake.texts().some((text) => text.startsWith('INSERT INTO ai_provider_sessions')))
      .toBe(false);
  });

  it('compare-and-sets execution state with a full fence', async () => {
    const updated = await repositoryFor(fake).compareAndSetExecutionState(
      'run-1',
      4,
      { state: 'active', ownerId: 'worker-a' },
      {
        owner: 'worker-a',
        allowedCurrentStatuses: ['running'],
        cancellation: 'absent',
        requiredLeaseOwner: 'worker-a',
        requiredAttempt: 1,
        leaseState: 'active',
        now: NOW,
      },
    );

    expect(updated).toBe(true);
    const statement = fake.find('UPDATE ai_runs SET execution_state = $1::jsonb');
    expect(statement.text).toContain(
      'WHERE id = $13 AND revision = $14 AND status = ANY($15::text[])'
      + ' AND cancel_requested_at IS NULL AND lease_owner = $16'
      + ' AND attempt = $17 AND lease_expires_at > $18',
    );
    expect(statement.params.slice(12)).toEqual([
      'run-1',
      4,
      ['running'],
      'worker-a',
      1,
      NOW.toISOString(),
    ]);
  });

  it('initializes execution state only once per revision', async () => {
    const initialized = await repositoryFor(fake).initializeExecutionState(
      'run-1',
      { state: 'pending' },
      {
        expectedRevision: 4,
        owner: 'worker-a',
        requiredLeaseOwner: 'worker-a',
        requiredAttempt: 1,
        leaseState: 'active',
        now: NOW,
      },
    );

    expect(initialized).toBe(true);
    const statement = fake.find('UPDATE ai_runs SET execution_state = $1::jsonb');
    expect(statement.text).toContain(
      'WHERE id = $8 AND revision = $9 AND execution_state IS NULL',
    );
    expect(statement.text).toContain(
      'AND lease_owner = $10 AND attempt = $11 AND lease_expires_at > $12',
    );
  });

  it('takes the run lock before provider sessions when pruning retention', async () => {
    const result = await repositoryFor(fake).pruneExpired(NOW);

    expect(result).toEqual({ deletedRuns: 2, revokedProviderSessions: 1 });
    const order = fake.texts();
    const runLock = order.findIndex((text) => text.includes('WHERE id IN ('));
    const sessionRevoke = order.findIndex((text) =>
      text.startsWith('UPDATE ai_provider_sessions'));
    expect(runLock).toBeGreaterThan(-1);
    expect(runLock).toBeLessThan(sessionRevoke);
    expect(fake.find('DELETE FROM ai_runs').text).toContain('status = ANY($1::text[])');
  });

  it('fences executor-authored events by execution state ownership', async () => {
    fake.run = runRow({ executionState: { state: 'active', ownerId: 'worker-a' } });
    const event = await repositoryFor(fake).appendEventForExecutionOwner(
      'run-1',
      'worker-a',
      { idempotencyKey: 'stream:1', kind: 'run.progress', now: NOW },
      NOW,
      1,
    );

    expect(event.kind).toBe('run.progress');
    fake = new FakePostgres();
    fake.run = runRow({ executionState: { state: 'active', ownerId: 'worker-b' } });
    await expect(repositoryFor(fake).appendEventForExecutionOwner(
      'run-1',
      'worker-a',
      { idempotencyKey: 'stream:1', kind: 'run.progress', now: NOW },
      NOW,
    )).rejects.toThrow('Durable AI run run-1 execution ownership was lost.');
  });

  it('reads history and events with bounded, ordered queries', async () => {
    const repository = repositoryFor(fake);
    await repository.listRuns({ featureId: 'durable-test', limit: 5_000 });
    const history = fake.find('FROM ai_runs WHERE feature_id = $1');
    expect(history.text).toContain('ORDER BY created_at DESC, id DESC');
    expect(history.params).toEqual(['durable-test', 100]);

    await repository.getEventsAfter('run-1', 3, 10_000);
    const events = fake.find('FROM ai_run_events WHERE run_id = $1 AND id > $2');
    expect(events.text).toContain('ORDER BY id ASC');
    expect(events.params).toEqual(['run-1', 3, 1_000]);
  });

  it('binds every parameter it references on the remaining statements', async () => {
    const repository = repositoryFor(fake);

    await repository.getRun('run-1');
    await repository.getInternalRun('run-1');
    await repository.listInternalRunsByRoute('test-route');
    await repository.getEventIdempotencyKeys('run-1');
    await repository.isCancellationRequested('run-1');
    await repository.isCancellationRequested('run-1', 'worker-a');
    await repository.getProviderSession('run-1', NOW);
    await repository.getProviderSessionForClaim('run-1', 'worker-a', 1, NOW);
    await repository.setProviderSession('run-1', 'bifrost', 'reference', { now: NOW });
    await repository.revokeProviderSession('run-1', NOW);
    await repository.revokeProviderSessionForClaim('run-1', 'worker-a', 1, NOW);
    await repository.renewCleanupLease('run-1', 'worker-a', 60_000, NOW);
    await repository.appendEvent('run-1', {
      idempotencyKey: 'stream:2',
      kind: 'run.progress',
      provider: 'bifrost',
      model: 'azure/gpt-4o-mini',
      now: NOW,
    });
    await repository.appendEventForClaim('run-1', 'worker-a', 1, {
      idempotencyKey: 'stream:3',
      kind: 'run.progress',
      now: NOW,
    });
    await repository.requestCancellation('run-1', NOW);
    await repository.cancelRun('run-1', 'worker-a', NOW);
    await repository.timeOutRun('run-1', 'worker-a', NOW);

    fake.run = runRow({ status: 'failed', leaseOwner: null, leaseExpiresAt: null });
    await repository.retryRun('run-1', 'operator-request', NOW);

    fake.run = runRow({ status: 'queued', leaseOwner: null, leaseExpiresAt: null });
    await repository.requestCancellation('run-1', NOW);

    // Every recorded statement was checked by assertPlaceholderBinding; this
    // guards against a silently unexercised statement.
    expect(fake.statements.length).toBeGreaterThan(30);
    expect(fake.texts().filter((text) => text === 'ROLLBACK')).toEqual([]);
  });
});
