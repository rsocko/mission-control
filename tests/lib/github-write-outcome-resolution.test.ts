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

const databasePath = join(tmpdir(), `mc-github-write-outcome-${process.pid}.db`);
const now = '2026-08-10T18:00:00.000Z';
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

describe('GitHub post-dispatch outcome resolution', () => {
  it('inspects bounded evidence without tokens, credentials, node IDs, or bodies', async () => {
    const fixture = seedOutcome('inspect-redaction');
    const inspected = await identity.inspectGitHubWriteOutcomes({
      connectorInstanceId: fixture.connectorId,
      cycleId: fixture.cycleId,
      limit: 1,
    }) as {
      bounded: boolean;
      returnedCount: number;
      outcomes: Array<{
        lease: { id: string; taskId: string; idempotencyKey: string };
        frozenTargets: Array<Record<string, unknown>>;
      }>;
    };

    expect(inspected).toMatchObject({
      bounded: true,
      returnedCount: 1,
      outcomes: [{
        lease: {
          id: fixture.leaseId,
          taskId: fixture.taskId,
          idempotencyKey: `${fixture.taskId}:complete:${now}`,
        },
      }],
    });
    expect(inspected.outcomes[0].frozenTargets[0]).toHaveProperty('locatorRevision');
    expect(inspected.outcomes[0].frozenTargets[0]).toHaveProperty('bindingRevision');
    const serialized = JSON.stringify(inspected);
    expect(serialized).not.toContain(fixture.token);
    expect(serialized).not.toContain('connector-secret');
    expect(serialized).not.toContain(fixture.issueStableId);
    expect(serialized).not.toContain(fixture.repositoryStableId);
    expect(serialized).not.toContain('sensitive body');
    await expect(identity.inspectGitHubWriteOutcomes({
      connectorInstanceId: fixture.connectorId,
      limit: 51,
    })).rejects.toThrow('between 1 and 50');
  });

  it('proves a completed issue applied and finalizes a clean interrupted cycle', async () => {
    const fixture = seedOutcome('remote-applied');
    const reader = {
      readGitHubWriteOutcome: vi.fn(async () => ({
        availability: 'present' as const,
        repositoryStableId: fixture.repositoryStableId,
        issueStableId: fixture.issueStableId,
        state: 'closed' as const,
      })),
    };

    const result = await resolve(fixture, reader);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      outcome: 'proven_applied',
      proofKind: 'issue_state',
      cycleFinalized: true,
      reconciliationState: 'resolved',
    });
    expect(reader.readGitHubWriteOutcome).toHaveBeenCalledTimes(1);
    expect(database.default.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, fixture.leaseId)).get())
      .toMatchObject({
        state: 'succeeded',
        cycleOutcome: 'succeeded',
        unknownReason: null,
      });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, fixture.taskId)).get())
      .toMatchObject({
        id: fixture.taskId,
        sourceId: fixture.sourceId,
        syncStatus: 'synced',
      });
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).get())
      .toMatchObject({
        state: 'completed',
        observedRouteCount: 1,
        appliedCount: 1,
        unknownCount: 0,
        reconciliationState: 'resolved',
      });
    const event = database.default.select().from(schema.githubWriteOutcomeEvents)
      .where(eq(schema.githubWriteOutcomeEvents.leaseId, fixture.leaseId)).get();
    expect(event).toMatchObject({
      connectorInstanceId: fixture.connectorId,
      cycleId: fixture.cycleId,
      leaseId: fixture.leaseId,
      taskId: fixture.taskId,
      operation: 'complete',
      outcome: 'proven_applied',
      proofKind: 'issue_state',
      remoteState: 'closed',
      actor: 'outcome-operator',
    });
    expect(event?.proofDigest).toHaveLength(64);

    expect(await resolve(fixture, reader)).toMatchObject({
      ok: true,
      changed: false,
      outcome: 'proven_applied',
    });
    expect(reader.readGitHubWriteOutcome).toHaveBeenCalledTimes(1);

    const status = await identity.getGitHubIdentityStatus(fixture.connectorId, {
      now,
    }) as {
      operationalState: {
        incompleteWriteCycles: number;
      };
    };
    expect(status.operationalState).toMatchObject({
      incompleteWriteCycles: 0,
    });
  });

  it('quarantines an orphaned running dispatch only after stopped-owner confirmation', async () => {
    const live = seedOutcome('running-live', {
      cycleState: 'running',
      leaseState: 'dispatched',
      cycleOutcome: null,
      expiresAt: '2026-08-10T18:01:00.000Z',
    });
    const liveReader = { readGitHubWriteOutcome: vi.fn() };
    expect(await resolve(live, liveReader, { confirmOwnerStopped: true })).toMatchObject({
      ok: false,
      code: 'active_dispatch',
    });
    expect(liveReader.readGitHubWriteOutcome).not.toHaveBeenCalled();
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, live.cycleId)).get())
      .toMatchObject({ state: 'running', reconciliationState: 'quarantined' });

    const orphaned = seedOutcome('running-orphaned', {
      cycleState: 'running',
      leaseState: 'dispatched',
      cycleOutcome: null,
      expiresAt: '2026-08-10T17:59:00.000Z',
      pendingCandidateCount: 3,
    });
    const reader = {
      readGitHubWriteOutcome: vi.fn(async () => ({
        availability: 'present' as const,
        repositoryStableId: orphaned.repositoryStableId,
        issueStableId: orphaned.issueStableId,
        state: 'closed' as const,
      })),
    };
    expect(await resolve(orphaned, reader)).toMatchObject({
      ok: false,
      code: 'active_dispatch',
    });
    expect(reader.readGitHubWriteOutcome).not.toHaveBeenCalled();

    expect(await resolve(orphaned, reader, { confirmOwnerStopped: true })).toMatchObject({
      ok: true,
      changed: true,
      outcome: 'proven_applied',
      reconciliationState: 'resolved',
    });
    expect(reader.readGitHubWriteOutcome).toHaveBeenCalledTimes(1);
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, orphaned.cycleId)).get())
      .toMatchObject({
        state: 'completed',
        pendingCandidateCount: 3,
        observedRouteCount: 1,
        reconciliationState: 'resolved',
        reconciledBy: 'outcome-operator',
        reconciliationReason: 'Authoritative outcome inspection',
        reconciliationIdempotencyKey: `resolve-${orphaned.leaseId}`,
      });
    expect((await identity.getGitHubIdentityStatus(orphaned.connectorId, {
      now,
    }) as { operationalState: { incompleteWriteCycles: number } })
      .operationalState.incompleteWriteCycles).toBe(0);

    const unsupported = seedOutcome('running-unsupported', {
      operation: 'update',
      cycleState: 'running',
      leaseState: 'dispatched',
      cycleOutcome: null,
      expiresAt: '2026-08-10T17:59:00.000Z',
    });
    expect(await resolve(unsupported, { readGitHubWriteOutcome: vi.fn() }, {
      confirmOwnerStopped: true,
    })).toMatchObject({
      ok: false,
      changed: true,
      code: 'unsupported_outcome_proof',
    });
    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, unsupported.cycleId)).get())
      .toMatchObject({
        state: 'interrupted',
        reconciliationState: 'quarantined',
        reconciliationIdempotencyKey: `resolve-${unsupported.leaseId}`,
      });
  });

  it('proves a currently open issue was not applied and preserves one retry', async () => {
    const fixture = seedOutcome('remote-not-applied');
    const result = await resolve(fixture, {
      readGitHubWriteOutcome: async () => ({
        availability: 'present',
        repositoryStableId: fixture.repositoryStableId,
        issueStableId: fixture.issueStableId,
        state: 'open',
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: 'proven_not_applied_retryable',
      reconciliationState: 'post_dispatch_retryable',
    });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, fixture.taskId)).get())
      .toMatchObject({
        syncStatus: 'pending_push',
        pushRetryCount: 0,
      });
    let status = await identity.getGitHubIdentityStatus(fixture.connectorId, {
      now,
    }) as {
      operationalState: { incompleteWriteCycles: number };
    };
    expect(status.operationalState.incompleteWriteCycles).toBe(1);

    const retryCycle = database.default.insert(schema.githubIdentityWriteCycles).values({
      id: `${fixture.cycleId}-retry`,
      connectorInstanceId: fixture.connectorId,
      modeRevision: 1,
      pendingCandidateCount: 1,
      observedRouteCount: 1,
      state: 'running',
      startedAt: '2026-08-10T18:01:00.000Z',
    }).returning({ id: schema.githubIdentityWriteCycles.id }).get();
    database.default.insert(schema.taskSourceWriteLeases).values({
      id: `${fixture.leaseId}-retry`,
      token: `${fixture.token}-retry`,
      connectorInstanceId: fixture.connectorId,
      taskId: fixture.taskId,
      operation: 'complete',
      taskVersion: now,
      idempotencyKey: `${fixture.taskId}:complete:${now}`,
      modeRevision: 1,
      writeCycleId: retryCycle.id,
      state: 'dispatched',
      cycleObservedAt: '2026-08-10T18:01:01.000Z',
      dispatchedAt: '2026-08-10T18:01:02.000Z',
      expiresAt: '2026-08-10T18:02:00.000Z',
      createdAt: '2026-08-10T18:01:00.000Z',
      updatedAt: '2026-08-10T18:01:02.000Z',
    }).run();
    await identity.finalizeGitHubWrite({
      leaseId: `${fixture.leaseId}-retry`,
      token: `${fixture.token}-retry`,
      connectorInstanceId: fixture.connectorId,
      taskId: fixture.taskId,
      operation: 'complete',
      sourceId: fixture.sourceId,
      owner: 'owner',
      repository: 'repo',
      issueNumber: 7,
      expiresAt: '2026-08-10T18:02:00.000Z',
      targets: [],
    }, 'succeeded');
    await identity.finishGitHubWriteCycle(retryCycle.id, {
      observed: 1,
      applied: 1,
      blocked: 0,
      failed: 0,
      unknown: 0,
    });

    expect(database.default.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, fixture.cycleId)).get())
      .toMatchObject({ reconciliationState: 'superseded' });
    status = await identity.getGitHubIdentityStatus(fixture.connectorId, { now }) as typeof status;
    expect(status.operationalState.incompleteWriteCycles).toBe(0);
  });

  it.each([
    { operation: 'update', changeTaskVersion: true, changeBinding: false },
    { operation: 'complete', changeTaskVersion: false, changeBinding: true },
    { operation: 'delete', changeTaskVersion: true, changeBinding: true },
  ] as const)(
    'repairs locally succeeded $operation after mutable task or binding drift',
    async ({ operation, changeTaskVersion, changeBinding }) => {
      const fixture = seedOutcome(`local-succeeded-${operation}`, {
        operation,
        leaseState: 'succeeded',
        cycleOutcome: 'succeeded',
        unknownCount: 0,
      });
      if (changeTaskVersion) {
        database.default.update(schema.tasks).set({
          updatedAt: '2026-08-10T18:01:00.000Z',
        }).where(eq(schema.tasks.id, fixture.taskId)).run();
      }
      if (changeBinding) {
        database.sqlite.prepare(`
          UPDATE external_entity_bindings
          SET verified_at = '2026-08-10T18:01:00.000Z'
          WHERE connector_instance_id = ? AND local_id = ?
        `).run(fixture.connectorId, fixture.taskId);
      }
      const inspected = await identity.inspectGitHubWriteOutcomes({
        connectorInstanceId: fixture.connectorId,
        cycleId: fixture.cycleId,
        leaseId: fixture.leaseId,
        limit: 1,
      }) as {
        outcomes: Array<{
          resolutionSupport: {
            supported: boolean;
            proofKind?: string;
            outcome?: string;
          };
        }>;
      };
      expect(inspected.outcomes[0]?.resolutionSupport).toMatchObject({
        supported: true,
        proofKind: 'local_finalization',
        outcome: 'proven_applied',
      });
      const reader = { readGitHubWriteOutcome: vi.fn() };

      expect(await resolve(fixture, reader)).toMatchObject({
        ok: true,
        outcome: 'proven_applied',
        proofKind: 'local_finalization',
        reconciliationState: 'resolved',
      });
      expect(reader.readGitHubWriteOutcome).not.toHaveBeenCalled();
      expect(database.default.select().from(schema.githubWriteOutcomeEvents)
        .where(eq(schema.githubWriteOutcomeEvents.leaseId, fixture.leaseId)).get())
        .toMatchObject({
          connectorInstanceId: fixture.connectorId,
          cycleId: fixture.cycleId,
          leaseId: fixture.leaseId,
          taskId: fixture.taskId,
          operation,
          proofKind: 'local_finalization',
          outcome: 'proven_applied',
        });
    },
  );

  it.each(['create', 'sub_issue', 'transfer'] as const)(
    'keeps locally succeeded %s unsupported and does not bypass mutable-context drift',
    async (operation) => {
      const unsupported = seedOutcome(`local-unsupported-${operation}`, {
        operation,
        leaseState: 'succeeded',
        cycleOutcome: 'succeeded',
        unknownCount: 0,
      });
      const reader = { readGitHubWriteOutcome: vi.fn() };
      const inspected = await identity.inspectGitHubWriteOutcomes({
        connectorInstanceId: unsupported.connectorId,
        cycleId: unsupported.cycleId,
        leaseId: unsupported.leaseId,
        limit: 1,
      }) as {
        outcomes: Array<{ resolutionSupport: { supported: boolean } }>;
      };

      expect(inspected.outcomes[0]?.resolutionSupport).toMatchObject({ supported: false });
      expect(await resolve(unsupported, reader)).toMatchObject({
        ok: false,
        code: 'unsupported_outcome_proof',
      });
      expect(reader.readGitHubWriteOutcome).not.toHaveBeenCalled();

      const drifted = seedOutcome(`local-unsupported-drift-${operation}`, {
        operation,
        leaseState: 'succeeded',
        cycleOutcome: 'succeeded',
        unknownCount: 0,
      });
      database.default.update(schema.tasks).set({
        updatedAt: '2026-08-10T18:01:00.000Z',
      }).where(eq(schema.tasks.id, drifted.taskId)).run();
      expect(await resolve(drifted, reader)).toMatchObject({
        ok: false,
        code: 'task_version_changed',
      });
      expect(reader.readGitHubWriteOutcome).not.toHaveBeenCalled();
    },
  );

  it('rejects mutable task drift for failed pre-dispatch local proof', async () => {
    const fixture = seedOutcome('local-failed-pre-dispatch-drift', {
      operation: 'update',
      leaseState: 'failed',
      cycleOutcome: 'failed',
      dispatchedAt: null,
      unknownCount: 0,
    });
    database.default.update(schema.tasks).set({
      updatedAt: '2026-08-10T18:01:00.000Z',
    }).where(eq(schema.tasks.id, fixture.taskId)).run();
    const reader = { readGitHubWriteOutcome: vi.fn() };

    expect(await resolve(fixture, reader)).toMatchObject({
      ok: false,
      changed: false,
      code: 'task_version_changed',
    });
    expect(reader.readGitHubWriteOutcome).not.toHaveBeenCalled();
    expect(database.default.select().from(schema.githubWriteOutcomeEvents)
      .where(eq(schema.githubWriteOutcomeEvents.leaseId, fixture.leaseId)).get())
      .toBeUndefined();
  });

  it('repairs strict local terminal evidence without network readback', async () => {
    const fixture = seedOutcome('local-succeeded', {
      operation: 'update',
      leaseState: 'succeeded',
      cycleOutcome: 'succeeded',
      unknownCount: 0,
    });
    const reader = { readGitHubWriteOutcome: vi.fn() };

    expect(await resolve(fixture, reader)).toMatchObject({
      ok: true,
      outcome: 'proven_applied',
      proofKind: 'local_finalization',
      reconciliationState: 'resolved',
    });
    expect(reader.readGitHubWriteOutcome).not.toHaveBeenCalled();
  });

  it('keeps unsupported and ambiguous outcomes quarantined without asserted flags', async () => {
    const unsupported = seedOutcome('unsupported-update', { operation: 'update' });
    const unsupportedReader = { readGitHubWriteOutcome: vi.fn() };
    expect(await resolve(unsupported, unsupportedReader)).toMatchObject({
      ok: false,
      changed: false,
      code: 'unsupported_outcome_proof',
    });
    expect(unsupportedReader.readGitHubWriteOutcome).not.toHaveBeenCalled();
    expect(database.default.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, unsupported.leaseId)).get())
      .toMatchObject({ state: 'unknown', cycleOutcome: 'unknown' });

    const ambiguous = seedOutcome('ambiguous-readback');
    expect(await resolve(ambiguous, {
      readGitHubWriteOutcome: async () => {
        throw new Error('403 credential=do-not-print');
      },
    })).toMatchObject({
      ok: false,
      changed: false,
      code: 'remote_outcome_ambiguous',
    });
    expect(database.default.select().from(schema.githubWriteOutcomeEvents)
      .where(eq(schema.githubWriteOutcomeEvents.leaseId, ambiguous.leaseId)).get())
      .toBeUndefined();
  });

  it('aborts when task, binding, or locator context changes during readback', async () => {
    const taskRace = seedOutcome('task-race');
    expect(await resolve(taskRace, {
      readGitHubWriteOutcome: async () => {
        database.default.update(schema.tasks).set({
          updatedAt: '2026-08-10T18:01:00.000Z',
        }).where(eq(schema.tasks.id, taskRace.taskId)).run();
        return {
          availability: 'present',
          repositoryStableId: taskRace.repositoryStableId,
          issueStableId: taskRace.issueStableId,
          state: 'closed',
        };
      },
    })).toMatchObject({
      ok: false,
      code: 'task_version_changed',
    });
    expect(database.default.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, taskRace.leaseId)).get())
      .toMatchObject({ state: 'unknown' });

    const bindingRace = seedOutcome('binding-race');
    expect(await resolve(bindingRace, {
      readGitHubWriteOutcome: async () => {
        database.sqlite.prepare(`
          UPDATE external_entity_bindings
          SET verified_at = '2026-08-10T18:01:00.000Z'
          WHERE connector_instance_id = ? AND local_id = ?
        `).run(bindingRace.connectorId, bindingRace.taskId);
        return {
          availability: 'present',
          repositoryStableId: bindingRace.repositoryStableId,
          issueStableId: bindingRace.issueStableId,
          state: 'closed',
        };
      },
    })).toMatchObject({
      ok: false,
      code: 'binding_or_locator_changed',
    });
  });

  it('rejects wrong remote identity and conflicting idempotency reuse', async () => {
    const identityRace = seedOutcome('identity-race');
    expect(await resolve(identityRace, {
      readGitHubWriteOutcome: async () => ({
        availability: 'present',
        repositoryStableId: 'R_other',
        issueStableId: 'I_other',
        state: 'closed',
      }),
    })).toMatchObject({
      ok: false,
      code: 'binding_or_locator_changed',
    });

    const resolved = seedOutcome('idempotency-conflict');
    const reader = {
      readGitHubWriteOutcome: async () => ({
        availability: 'present' as const,
        repositoryStableId: resolved.repositoryStableId,
        issueStableId: resolved.issueStableId,
        state: 'closed' as const,
      }),
    };
    expect(await resolve(resolved, reader)).toMatchObject({ ok: true });
    expect(await identity.resolveGitHubWriteOutcome({
      connectorInstanceId: resolved.connectorId,
      cycleId: resolved.cycleId,
      leaseId: resolved.leaseId,
      expectedRevision: 1,
      actor: 'different-operator',
      reason: 'Different audited reason',
      idempotencyKey: `resolve-${resolved.leaseId}`,
      now,
    }, reader)).toMatchObject({
      ok: false,
      code: 'idempotency_conflict',
    });
  });
});

interface SeedOptions {
  operation?: 'complete' | 'create' | 'delete' | 'sub_issue' | 'transfer' | 'update';
  leaseState?: 'dispatched' | 'failed' | 'unknown' | 'succeeded';
  cycleOutcome?: 'failed' | 'unknown' | 'succeeded' | null;
  cycleState?: 'interrupted' | 'running';
  unknownCount?: number;
  expiresAt?: string;
  pendingCandidateCount?: number;
  dispatchedAt?: string | null;
}

function seedOutcome(suffix: string, options: SeedOptions = {}) {
  const connectorId = `outcome-${suffix}`;
  const taskId = `task-${suffix}`;
  const runId = `run-${suffix}`;
  const cycleId = `cycle-${suffix}`;
  const leaseId = `lease-${suffix}`;
  const token = `token-${suffix}`;
  const repositoryStableId = `R_secret_${suffix}`;
  const issueStableId = `I_secret_${suffix}`;
  const owner = 'owner';
  const repository = `repo-${suffix}`;
  const sourceListId = `${owner}/${repository}`;
  const sourceId = `${sourceListId}:7`;
  const operation = options.operation ?? 'complete';
  const leaseState = options.leaseState ?? 'unknown';
  const cycleOutcome = options.cycleOutcome === undefined ? 'unknown' : options.cycleOutcome;
  const cycleState = options.cycleState ?? 'interrupted';
  database.default.insert(schema.connectorConfigs).values({
    id: connectorId,
    type: 'github-issues',
    name: connectorId,
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: { token: 'connector-secret' },
    settings: { repos: [sourceListId] },
    syncedLists: [sourceListId],
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
  database.default.insert(schema.sourceLists).values({
    id: `list-${suffix}`,
    connectorInstanceId: connectorId,
    sourceId: sourceListId,
    name: sourceListId,
    type: 'repo',
  }).run();
  database.default.insert(schema.tasks).values({
    id: taskId,
    sourceId,
    sourceListId: `list-${suffix}`,
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: 'Resolve safely',
    description: 'sensitive body',
    status: 'done',
    syncStatus: 'push_failed',
    pushRetryCount: 5,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  }).run();
  database.default.insert(schema.externalEntities).values([
    {
      id: `repo-${suffix}`,
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository',
      stableId: repositoryStableId,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    {
      id: `issue-${suffix}`,
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'issue',
      stableId: issueStableId,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  ]).run();
  database.default.insert(schema.externalEntityLocators).values([
    {
      id: `repo-locator-${suffix}`,
      externalEntityId: `repo-${suffix}`,
      provider: 'github',
      hostKey: 'github.com',
      owner,
      repository,
      ownerKey: owner,
      repositoryKey: repository,
      validFrom: now,
      lastSeenAt: now,
      observationSource: 'rest',
      locatorRevision: 1,
    },
    {
      id: `issue-locator-${suffix}`,
      externalEntityId: `issue-${suffix}`,
      repositoryEntityId: `repo-${suffix}`,
      provider: 'github',
      hostKey: 'github.com',
      owner,
      repository,
      ownerKey: owner,
      repositoryKey: repository,
      issueNumber: 7,
      validFrom: now,
      lastSeenAt: now,
      observationSource: 'rest',
      locatorRevision: 1,
    },
  ]).run();
  database.default.insert(schema.externalEntityBindings).values([
    {
      id: `repo-binding-${suffix}`,
      externalEntityId: `repo-${suffix}`,
      connectorInstanceId: connectorId,
      bindingType: 'source_list',
      localId: `list-${suffix}`,
      state: 'shadow',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `issue-binding-${suffix}`,
      externalEntityId: `issue-${suffix}`,
      connectorInstanceId: connectorId,
      bindingType: 'task',
      localId: taskId,
      state: 'shadow',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]).run();
  database.default.insert(schema.githubIdentityWriteCycles).values({
    id: cycleId,
    connectorInstanceId: connectorId,
    modeRevision: 1,
    pendingCandidateCount: options.pendingCandidateCount ?? 1,
    observedRouteCount: 0,
    unknownCount: options.unknownCount ?? (leaseState === 'unknown' ? 1 : 0),
    state: cycleState,
    reconciliationState: 'quarantined',
    reconciliationCode: 'possible_post_dispatch_outcome',
    startedAt: '2026-08-10T17:59:00.000Z',
    completedAt: cycleState === 'running' ? null : now,
  }).run();
  database.default.insert(schema.taskSourceWriteLeases).values({
    id: leaseId,
    token,
    connectorInstanceId: connectorId,
    taskId,
    operation,
    taskVersion: now,
    idempotencyKey: `${taskId}:${operation}:${now}`,
    modeRevision: 1,
    writeCycleId: cycleId,
    state: leaseState,
    cycleObservedAt: now,
    cycleOutcome,
    dispatchedAt: options.dispatchedAt === undefined ? now : options.dispatchedAt,
    finalizedAt: leaseState === 'dispatched' ? null : now,
    expiresAt: options.expiresAt ?? '2026-08-10T18:01:00.000Z',
    createdAt: '2026-08-10T17:59:30.000Z',
    updatedAt: now,
  }).run();
  database.default.insert(schema.taskSourceWriteLeaseTargets).values([
    {
      leaseId,
      role: 'primary_issue',
      externalEntityId: `issue-${suffix}`,
      repositoryEntityId: `repo-${suffix}`,
      hostKey: 'github.com',
      locatorRevision: 1,
      bindingRevision: now,
      legacyLocatorDigest: 'locator-digest',
      owner,
      repository,
      issueNumber: 7,
    },
    {
      leaseId,
      role: 'source_repository',
      externalEntityId: `repo-${suffix}`,
      hostKey: 'github.com',
      locatorRevision: 1,
      bindingRevision: now,
      legacyLocatorDigest: 'repository-digest',
      owner,
      repository,
      issueNumber: null,
    },
  ]).run();
  return {
    connectorId,
    taskId,
    runId,
    cycleId,
    leaseId,
    token,
    repositoryStableId,
    issueStableId,
    sourceId,
  };
}

function resolve(
  fixture: ReturnType<typeof seedOutcome>,
  reader: Parameters<typeof identity.resolveGitHubWriteOutcome>[1],
  overrides: Partial<Parameters<typeof identity.resolveGitHubWriteOutcome>[0]> = {},
) {
  return identity.resolveGitHubWriteOutcome({
    connectorInstanceId: fixture.connectorId,
    cycleId: fixture.cycleId,
    leaseId: fixture.leaseId,
    expectedRevision: 1,
    actor: 'outcome-operator',
    reason: 'Authoritative outcome inspection',
    idempotencyKey: `resolve-${fixture.leaseId}`,
    now,
    ...overrides,
  }, reader);
}
