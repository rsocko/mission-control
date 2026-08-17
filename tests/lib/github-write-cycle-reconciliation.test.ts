import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

type DbModule = typeof import('@/db');
type SchemaModule = typeof import('@/db/schema');
type IdentityModule = typeof import('@/lib/external-identities');

const databasePath = join(tmpdir(), `mc-github-write-cycle-reconcile-${process.pid}.db`);
const now = '2026-08-10T15:00:00.000Z';
let database: DbModule;
let schema: SchemaModule;
let identity: IdentityModule;

beforeAll(async () => {
  if (existsSync(databasePath)) rmSync(databasePath);
  process.env.MC_DB_PATH = databasePath;
  process.env.LOG_LEVEL = 'silent';
  vi.resetModules();
  [database, schema, identity] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/external-identities'),
  ]);
}, 30_000);

afterAll(() => {
  database?.sqlite.close();
  delete process.env.MC_DB_PATH;
  if (existsSync(databasePath)) rmSync(databasePath);
});

describe('interrupted GitHub write-cycle reconciliation', () => {
  it('finalizes route evidence persisted before counters as pre-dispatch retryable', () => {
    const fixture = seedInterruptedCycle('route-before-counter', {
      observedRouteCount: 0,
    });
    const reason = 'Verified deployment restart before dispatch secret-token-123';
    const idempotencyKey = 'reconcile-route-before-counter';

    const result = reconcile(fixture, { reason, idempotencyKey });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      reconciliationState: 'pre_dispatch_retryable',
      reasonCode: 'pre_dispatch_retryable',
      observedRouteCount: 1,
    });
    expect(database.default.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, fixture.leaseId)).get())
      .toMatchObject({
        state: 'expired',
        cycleObservedAt: '2026-08-10T14:00:00.000Z',
      });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, fixture.taskId)).get())
      .toMatchObject({
        id: fixture.taskId,
        sourceId: `local:${fixture.taskId}`,
        syncStatus: 'pending_push',
      });

    const status = identity.getGitHubIdentityStatus(fixture.connectorId, {
      includeEvidence: true,
      limit: 3,
      now,
    }) as {
      operationalState: {
        incompleteWriteCycles: number;
        activeWriteLeases: number;
        writeCycleReconciliation: {
          unresolvedCount: number;
          preDispatchRetryableCount: number;
          cycles: Array<Record<string, unknown>>;
        };
      };
    };
    expect(status.operationalState).toMatchObject({
      incompleteWriteCycles: 0,
      activeWriteLeases: 0,
      writeCycleReconciliation: {
        unresolvedCount: 0,
        preDispatchRetryableCount: 1,
      },
    });
    expect(status.operationalState.writeCycleReconciliation.cycles).toHaveLength(1);
    const serialized = JSON.stringify(
      status.operationalState.writeCycleReconciliation,
    );
    expect(serialized).not.toContain(reason);
    expect(serialized).not.toContain(idempotencyKey);
    expect(serialized).not.toContain(fixture.token);
    expect(serialized).not.toContain(fixture.taskId);

    expect(reconcile(fixture, { reason, idempotencyKey })).toMatchObject({
      ok: true,
      changed: false,
      reconciliationState: 'pre_dispatch_retryable',
    });
    expect(reconcile(fixture, {
      reason,
      idempotencyKey: 'different-reconciliation-key',
    })).toMatchObject({
      ok: false,
      changed: false,
      code: 'idempotency_conflict',
    });
  });

  it('accepts durable observation counters only after the undispatched lease expires', () => {
    const fixture = seedInterruptedCycle('counter-before-dispatch', {
      observedRouteCount: 1,
      cycleObservedAt: '2026-08-10T14:00:00.000Z',
      leaseState: 'authorized',
      expiresAt: '2026-08-10T16:00:00.000Z',
    });

    expect(reconcile(fixture)).toMatchObject({
      ok: false,
      changed: false,
      code: 'active_write_lease',
    });
    database.sqlite.prepare(`
      UPDATE task_source_write_leases
      SET expires_at = '2026-08-10T14:59:59.000Z'
      WHERE id = ?
    `).run(fixture.leaseId);
    expect(reconcile(fixture)).toMatchObject({
      ok: true,
      changed: true,
      reconciliationState: 'pre_dispatch_retryable',
      observedRouteCount: 1,
    });
  });

  it('quarantines every possible post-dispatch outcome and never makes it retryable', () => {
    const fixture = seedInterruptedCycle('post-dispatch-timeout', {
      observedRouteCount: 1,
      cycleObservedAt: '2026-08-10T14:00:00.000Z',
      leaseState: 'dispatched',
      dispatchedAt: '2026-08-10T14:00:01.000Z',
    });

    expect(reconcile(fixture)).toMatchObject({
      ok: false,
      changed: true,
      code: 'possible_post_dispatch_outcome',
    });
    expect(database.default.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, fixture.leaseId)).get())
      .toMatchObject({
        state: 'unknown',
        unknownReason: 'interrupted_after_dispatch',
      });
    const cycle = database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).get();
    expect(cycle).toMatchObject({
      reconciliationState: 'quarantined',
      reconciliationCode: 'possible_post_dispatch_outcome',
      unknownCount: 1,
    });
    expect(identity.finishGitHubWriteCycle(fixture.cycleId, {
      observed: 1,
      applied: 1,
      blocked: 0,
      failed: 0,
      unknown: 0,
    })).toBe(false);
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).get())
      .toMatchObject({
        state: 'interrupted',
        reconciliationState: 'quarantined',
        unknownCount: 1,
      });
    const status = identity.getGitHubIdentityStatus(fixture.connectorId, {
      limit: 3,
      now,
    }) as {
      operationalState: {
        incompleteWriteCycles: number;
        writeLeasesByState: Record<string, number>;
        writeCycleReconciliation: {
          quarantinedCount: number;
          cycles: Array<Record<string, unknown>>;
        };
      };
    };
    expect(status.operationalState).toMatchObject({
      incompleteWriteCycles: 1,
      writeLeasesByState: { unknown: 1 },
      writeCycleReconciliation: { quarantinedCount: 1 },
    });
    expect(status.operationalState.writeCycleReconciliation.cycles[0]).toMatchObject({
      reconciliationState: 'quarantined',
      reconciliationReasonCode: 'possible_post_dispatch_outcome',
      dispatchEvidenceCount: 1,
    });
  });

  it('returns completed zero-dispatch incomplete cycles in unresolved status details', () => {
    const fixture = seedInterruptedCycle('completed-zero-dispatch-status', {
      observedRouteCount: 0,
      leaseState: 'expired',
    });
    database.default.update(schema.githubIdentityWriteCycles).set({
      state: 'completed',
      completedAt: now,
    }).where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).run();

    const status = identity.getGitHubIdentityStatus(fixture.connectorId, {
      limit: 100,
      now,
    }) as {
      operationalState: {
        writeCycleReconciliation: {
          unresolvedCount: number;
          cycles: Array<Record<string, unknown>>;
        };
      };
    };
    expect(status.operationalState.writeCycleReconciliation).toMatchObject({
      unresolvedCount: 1,
      cycles: [{
        id: fixture.cycleId,
        state: 'completed',
        pendingCandidateCount: 1,
        observedRouteCount: 0,
        dispatchEvidenceCount: 0,
        reconciliationState: 'unresolved',
      }],
    });
  });

  it.each([
    ['blocked outcome', {
      observedRouteCount: 1,
      blockedCount: 1,
      failedCount: 0,
      leaseState: 'blocked',
    }],
    ['failed outcome', {
      observedRouteCount: 1,
      blockedCount: 0,
      failedCount: 1,
      leaseState: 'failed',
    }],
    ['unobserved candidate', {
      observedRouteCount: 0,
      blockedCount: 0,
      failedCount: 0,
      leaseState: 'expired',
    }],
  ])('audits completed pre-dispatch cycles with %s as retryable', (suffix, cycleCounts) => {
    const fixture = seedInterruptedCycle(`completed-${suffix.replaceAll(' ', '-')}`, {
      observedRouteCount: cycleCounts.observedRouteCount,
      leaseState: cycleCounts.leaseState,
    });
    database.default.update(schema.githubIdentityWriteCycles).set({
      state: 'completed',
      completedAt: now,
      blockedCount: cycleCounts.blockedCount,
      failedCount: cycleCounts.failedCount,
    }).where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).run();
    database.default.update(schema.taskSourceWriteLeases).set({
      state: cycleCounts.leaseState,
      finalizedAt: now,
      updatedAt: now,
    }).where(eq(schema.taskSourceWriteLeases.id, fixture.leaseId)).run();

    const status = identity.getGitHubIdentityStatus(fixture.connectorId, {
      now,
    }) as {
      operationalState: { incompleteWriteCycles: number };
    };
    expect(status.operationalState.incompleteWriteCycles).toBe(1);

    expect(reconcile(fixture, {
      reason: `Verified completed ${suffix} had zero dispatch evidence`,
      idempotencyKey: `reconcile-completed-${suffix.replaceAll(' ', '-')}`,
    })).toMatchObject({
      ok: true,
      changed: true,
      reconciliationState: 'pre_dispatch_retryable',
    });
    const reconciledStatus = identity.getGitHubIdentityStatus(fixture.connectorId, {
      now,
    }) as {
      operationalState: { incompleteWriteCycles: number };
    };
    expect(reconciledStatus.operationalState.incompleteWriteCycles).toBe(0);
  });

  it('quarantines a completed cycle when any lease has dispatch evidence', () => {
    const fixture = seedInterruptedCycle('completed-dispatched', {
      observedRouteCount: 1,
      cycleObservedAt: '2026-08-10T14:00:00.000Z',
      leaseState: 'dispatched',
      dispatchedAt: '2026-08-10T14:00:01.000Z',
    });
    database.default.update(schema.githubIdentityWriteCycles).set({
      state: 'completed',
      completedAt: now,
    }).where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).run();

    expect(reconcile(fixture, {
      reason: 'Completed cycle retained exact post-dispatch quarantine evidence',
      idempotencyKey: 'reconcile-completed-dispatched',
    })).toMatchObject({
      ok: false,
      changed: true,
      code: 'possible_post_dispatch_outcome',
    });
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).get())
      .toMatchObject({
        state: 'completed',
        reconciliationState: 'quarantined',
      });
  });

  it('recognizes a later durable successful retry without rewriting the original work', () => {
    const fixture = seedInterruptedCycle('later-success', {
      observedRouteCount: 1,
      cycleObservedAt: '2026-08-10T14:00:00.000Z',
    });
    database.sqlite.prepare(`
      UPDATE tasks
      SET source_id = 'acme/app:55', sync_status = 'synced'
      WHERE id = ?
    `).run(fixture.taskId);
    database.default.insert(schema.taskSourceWriteLeases).values({
      id: `${fixture.leaseId}-retry`,
      token: `${fixture.token}-retry`,
      connectorInstanceId: fixture.connectorId,
      taskId: fixture.taskId,
      operation: 'update',
      taskVersion: now,
      idempotencyKey: `${fixture.taskId}:update:${now}`,
      modeRevision: 1,
      state: 'succeeded',
      finalizedAt: '2026-08-10T14:30:00.000Z',
      expiresAt: '2026-08-10T14:20:00.000Z',
      createdAt: '2026-08-10T14:10:00.000Z',
      updatedAt: '2026-08-10T14:30:00.000Z',
    }).run();

    expect(reconcile(fixture)).toMatchObject({
      ok: true,
      changed: true,
      reconciliationState: 'superseded',
      reasonCode: 'superseded_by_succeeded_retry',
    });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, fixture.taskId)).get())
      .toMatchObject({
        id: fixture.taskId,
        sourceId: 'acme/app:55',
        syncStatus: 'synced',
      });
  });

  it('isolates old revisions and preserves ambiguous leases for explicit remediation', () => {
    const old = seedInterruptedCycle('old-revision', {
      modeRevision: 0,
      observedRouteCount: 0,
    });
    expect(reconcile(old)).toMatchObject({
      ok: false,
      changed: false,
      code: 'stale_cycle_context',
    });
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, old.cycleId)).get())
      .toMatchObject({ reconciliationState: 'unresolved' });
    const oldStatus = identity.getGitHubIdentityStatus(old.connectorId, { now }) as {
      operationalState: { incompleteWriteCycles: number };
    };
    expect(oldStatus.operationalState.incompleteWriteCycles).toBe(1);

    const ambiguous = seedInterruptedCycle('ambiguous-shared-run', {
      observedRouteCount: 0,
      pendingCandidateCount: 0,
    });
    database.default.insert(schema.githubIdentityWriteCycles).values({
      id: `${ambiguous.cycleId}-other`,
      connectorInstanceId: ambiguous.connectorId,
      modeRevision: 1,
      pendingCandidateCount: 1,
      state: 'interrupted',
      startedAt: '2026-08-10T13:59:00.000Z',
      completedAt: '2026-08-10T14:01:00.000Z',
    }).run();
    expect(reconcile(ambiguous)).toMatchObject({
      ok: false,
      changed: true,
      code: 'ambiguous_cycle_evidence',
    });
    expect(database.default.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, ambiguous.leaseId)).get())
      .toMatchObject({ state: 'claimed' });
  });

  it('does not expose the unaudited token assertion helper', () => {
    const fixture = seedInterruptedCycle('ambiguous-unknown', {
      leaseState: 'unknown',
      unknownCount: 1,
      writeCycleId: null,
    });
    database.default.insert(schema.githubIdentityWriteCycles).values({
      id: `${fixture.cycleId}-other`,
      connectorInstanceId: fixture.connectorId,
      modeRevision: 1,
      pendingCandidateCount: 1,
      unknownCount: 1,
      state: 'interrupted',
      startedAt: '2026-08-10T14:00:30.000Z',
      completedAt: '2026-08-10T14:01:00.000Z',
    }).run();

    expect((identity as unknown as Record<string, unknown>).reconcileUnknownGitHubWrite)
      .toBeUndefined();
    expect(database.default.select({
      id: schema.githubIdentityWriteCycles.id,
      unknownCount: schema.githubIdentityWriteCycles.unknownCount,
      failedCount: schema.githubIdentityWriteCycles.failedCount,
    }).from(schema.githubIdentityWriteCycles)
      .where(eq(
        schema.githubIdentityWriteCycles.connectorInstanceId,
        fixture.connectorId,
      )).all()).toEqual(expect.arrayContaining([
      { id: fixture.cycleId, unknownCount: 1, failedCount: 0 },
      { id: `${fixture.cycleId}-other`, unknownCount: 1, failedCount: 0 },
    ]));
  });

  it('keeps one active cycle and rejects an unrelated concurrent comparison owner', () => {
    const fixture = seedInterruptedCycle('single-active-invariant');
    const snapshot = identity.getGitHubIdentityModeSnapshot(fixture.connectorId);
    const firstCycle = identity.beginGitHubWriteCycle({
      connectorInstanceId: fixture.connectorId,
      modeSnapshot: snapshot,
      pendingCandidateCount: 1,
    });
    const secondCycle = identity.beginGitHubWriteCycle({
      connectorInstanceId: fixture.connectorId,
      modeSnapshot: snapshot,
      pendingCandidateCount: 1,
    });
    expect(database.default.select({
      id: schema.githubIdentityWriteCycles.id,
      state: schema.githubIdentityWriteCycles.state,
    }).from(schema.githubIdentityWriteCycles)
      .where(eq(
        schema.githubIdentityWriteCycles.connectorInstanceId,
        fixture.connectorId,
      )).all()).toEqual(expect.arrayContaining([
      { id: firstCycle, state: 'interrupted' },
      { id: secondCycle, state: 'running' },
    ]));
    expect(database.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM github_identity_write_cycles
      WHERE connector_instance_id = ? AND state = 'running'
    `).get(fixture.connectorId)).toEqual({ count: 1 });
    expect(identity.finishGitHubWriteCycle(secondCycle, {
      observed: 0,
      applied: 0,
      blocked: 0,
      failed: 0,
      unknown: 0,
    })).toBe(false);
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, secondCycle)).get())
      .toMatchObject({ state: 'interrupted' });

    // Multiple stable identity runtimes are ordinary now: they hold no durable
    // run ownership because they never write evidence.
    const firstRun = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: fixture.connectorId,
      modeSnapshot: snapshot,
      syncKind: 'incremental',
    });
    const secondRun = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: fixture.connectorId,
      modeSnapshot: snapshot,
      syncKind: 'incremental',
    });
    expect(firstRun.modeSnapshot.modeRevision).toBe(secondRun.modeSnapshot.modeRevision);
    firstRun.complete('cancelled', 'test_complete');
    secondRun.complete('cancelled', 'test_complete');
  });
});

interface SeedOptions {
  modeRevision?: number;
  pendingCandidateCount?: number;
  observedRouteCount?: number;
  cycleObservedAt?: string | null;
  leaseState?: 'claimed' | 'authorized' | 'dispatched' | 'unknown';
  dispatchedAt?: string | null;
  expiresAt?: string;
  writeCycleId?: string | null;
  unknownCount?: number;
}

function seedInterruptedCycle(suffix: string, options: SeedOptions = {}) {
  const connectorId = `cycle-${suffix}`;
  const cycleId = `cycle-${suffix}`;
  const taskId = `task-${suffix}`;
  const leaseId = `lease-${suffix}`;
  const token = `token-${suffix}`;
  const modeRevision = options.modeRevision ?? 1;
  database.default.insert(schema.connectorConfigs).values({
    id: connectorId,
    type: 'github-issues',
    name: connectorId,
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: {},
    settings: { repos: [] },
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: connectorId,
    phase: 'complete',
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: connectorId,
    modeRevision: 1,
    updatedAt: now,
  }).run();
  database.default.insert(schema.tasks).values({
    id: taskId,
    sourceId: `local:${taskId}`,
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: taskId,
    syncStatus: 'pending_push',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityWriteCycles).values({
    id: cycleId,
    connectorInstanceId: connectorId,
    modeRevision,
    pendingCandidateCount: options.pendingCandidateCount ?? 1,
    observedRouteCount: options.observedRouteCount ?? 0,
    unknownCount: options.unknownCount ?? 0,
    state: 'interrupted',
    startedAt: '2026-08-10T13:59:00.000Z',
    completedAt: '2026-08-10T14:01:00.000Z',
  }).run();
  database.default.insert(schema.taskSourceWriteLeases).values({
    id: leaseId,
    token,
    connectorInstanceId: connectorId,
    taskId,
    operation: 'update',
    taskVersion: now,
    idempotencyKey: `${taskId}:update:${now}`,
    modeRevision,
    writeCycleId: options.writeCycleId === undefined ? cycleId : options.writeCycleId,
    state: options.leaseState ?? 'claimed',
    cycleObservedAt: options.cycleObservedAt === undefined
      ? '2026-08-10T14:00:00.000Z'
      : options.cycleObservedAt,
    dispatchedAt: options.dispatchedAt ?? null,
    expiresAt: options.expiresAt ?? '2026-08-10T14:30:00.000Z',
    createdAt: '2026-08-10T14:00:00.000Z',
    updatedAt: '2026-08-10T14:00:00.000Z',
  }).run();
  return { connectorId, cycleId, taskId, leaseId, token };
}

function reconcile(
  fixture: ReturnType<typeof seedInterruptedCycle>,
  overrides: Partial<{
    reason: string;
    idempotencyKey: string;
  }> = {},
) {
  return identity.reconcileInterruptedGitHubWriteCycle({
    connectorInstanceId: fixture.connectorId,
    cycleId: fixture.cycleId,
    expectedRevision: 1,
    actor: 'restart-operator',
    reason: overrides.reason ?? 'Verified restart before dispatch',
    idempotencyKey: overrides.idempotencyKey ?? `reconcile-${fixture.cycleId}`,
    confirmPreDispatch: true,
    now,
  });
}
