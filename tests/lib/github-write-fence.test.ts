import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import type { GitHubWriteAuthorization } from '@/lib/external-identities';
import type { ConnectorConfig } from '@/types';

describe('GitHub write fence', () => {
  beforeEach(() => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.MC_MODE = 'live';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MC_DB_PATH;
    delete process.env.MC_MODE;
  });

  it('explains how to recover from blocked stable identity evidence', async () => {
    const { GitHubWriteFenceError } = await import('@/lib/external-identities');
    const error = new GitHubWriteFenceError('stable_identity_evidence_blocked');

    expect(error).toMatchObject({
      code: 'stable_identity_evidence_blocked',
      message:
        'GitHub sync is paused because this task identity needs reconciliation. Run a full GitHub sync, then retry.',
    });
  });

  it('dispatches only an agreeing legacy route and quarantines a stale mode lease', async () => {
    const [{ default: db, sqlite }, schema, identity] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/external-identities'),
    ]);
    const now = '2026-08-10T12:00:00.000Z';
    db.insert(schema.connectorConfigs).values({
      id: 'github-fence',
      type: 'github-issues',
      name: 'GitHub',
      capabilities: {},
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: 'github-fence',
      phase: 'complete',
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityControls).values({
      connectorInstanceId: 'github-fence',
      modeRevision: 4,
      updatedAt: now,
    }).run();
    db.insert(schema.sourceLists).values({
      id: 'repo-list',
      connectorInstanceId: 'github-fence',
      sourceId: 'owner/repo',
      name: 'owner/repo',
      type: 'repo',
    }).run();
    db.insert(schema.tasks).values({
      id: 'task-1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-fence',
      sourceId: 'owner/repo:7',
      sourceListId: 'repo-list',
      title: 'Fence me',
      status: 'todo',
      priority: 'normal',
      metadata: {},
      syncStatus: 'pending_push',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    }).run();
    seedIdentity(db, schema, now);

    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'full',
    });
    const firstCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const authorization = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: firstCycle,
    });
    await identity.verifyGitHubWritePreflight(authorization, {
      targets: {
        primary_issue: { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
        source_repository: { repositoryStableId: 'R_repo' },
      },
    });
    await identity.confirmGitHubWriteDispatch(authorization);
    await identity.finalizeGitHubWrite(authorization, 'succeeded');
    expect(db.select().from(schema.taskSourceWriteLeases).all()
      .find((lease) => lease.id === authorization.leaseId)).toMatchObject({
      state: 'succeeded',
      modeRevision: 4,
    });
    await expect(identity.quarantineUnknownGitHubWrite(
      authorization,
      new Error('late transport failure'),
    )).rejects.toThrow(identity.GitHubUnknownWriteOutcomeError);
    await identity.finishGitHubWriteCycle(firstCycle, {
      observed: 1,
      applied: 1,
      blocked: 0,
      failed: 0,
      unknown: 0,
    });

    const staleCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const stale = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'comment',
      identityRuntime: runtime,
      writeCycleId: staleCycle,
    });
    sqlite.prepare(`
      UPDATE github_identity_controls
      SET mode_revision = 5, updated_at = ?
      WHERE connector_instance_id = ?
    `).run(now, 'github-fence');
    await expect(identity.confirmGitHubWriteDispatch(stale))
      .rejects.toThrow('stale_mode_lease_or_locator');
    expect(db.select().from(schema.taskSourceWriteLeases).all()
      .find((lease) => lease.id === stale.leaseId)?.state).toBe('blocked');
    runtime.complete('succeeded');

    sqlite.prepare(`
      UPDATE github_identity_controls
      SET mode_revision = 4, updated_at = ?
      WHERE connector_instance_id = ?
    `).run(now, 'github-fence');
    await expect(identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'label',
      connector: {
        type: 'github-issues',
        preflightWriteRoute: async () => ({
          targets: {
            primary_issue: { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
            source_repository: { repositoryStableId: 'R_repo' },
          },
        }),
        runAuthorizedWrite: async (_route, write) => write(),
      },
      write: async () => 'legacy-applied',
    })).resolves.toBe('legacy-applied');
    expect(db.select().from(schema.githubIdentityWriteCycles).all()
      .some((cycle) => cycle.pendingCandidateCount === 1
        && cycle.observedRouteCount === 1
        && cycle.appliedCount === 1
        && cycle.state === 'completed')).toBe(true);
  });

  it('preserves the primary fence error when runtime and cycle cleanup fail', async () => {
    const { db, sqlite, schema, identity } = await setupFixture();
    const failure = await identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      connector: {
        type: 'github-issues',
        preflightWriteRoute: async () => {
          sqlite.prepare(`
            UPDATE github_identity_write_cycles
            SET state = 'interrupted', completed_at = ?
            WHERE connector_instance_id = ? AND state = 'running'
          `).run('2026-08-10T12:10:00.000Z', 'github-fence');
          throw new identity.GitHubWriteFenceError('primary_preflight_failure');
        },
        runAuthorizedWrite: async (_route, write) => write(),
      },
      write: async () => 'unreachable',
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(identity.GitHubWriteFenceError);
    expect(failure).toMatchObject({ code: 'primary_preflight_failure' });
    expect(db.select().from(schema.githubIdentityWriteCycles).all()).toContainEqual(
      expect.objectContaining({ state: 'interrupted' }),
    );
  });

  it('preserves a quarantined unknown outcome when comparison cleanup fails', async () => {
    const { db, sqlite, schema, identity } = await setupFixture();
    const failure = await identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'comment',
      connector: {
        type: 'github-issues',
        preflightWriteRoute: async () => ({
          targets: {
            primary_issue: { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
            source_repository: { repositoryStableId: 'R_repo' },
          },
        }),
        runAuthorizedWrite: async (_route, write) => write(),
      },
      write: async () => {
        throw new Error('connection_closed_after_dispatch');
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(identity.GitHubUnknownWriteOutcomeError);
    expect(db.select().from(schema.taskSourceWriteLeases).all()).toContainEqual(
      expect.objectContaining({
        taskId: 'task-1',
        operation: 'comment',
        state: 'unknown',
        cycleOutcome: 'unknown',
      }),
    );
    expect(db.select().from(schema.githubIdentityWriteCycles).all()).toContainEqual(
      expect.objectContaining({
        state: 'completed',
        observedRouteCount: 1,
        unknownCount: 1,
      }),
    );
  });

  it('preserves a successful write when comparison cleanup fails and completes its cycle', async () => {
    const { db, sqlite, schema, identity } = await setupFixture();

    await expect(identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      connector: {
        type: 'github-issues',
        preflightWriteRoute: async () => ({
          targets: {
            primary_issue: { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
            source_repository: { repositoryStableId: 'R_repo' },
          },
        }),
        runAuthorizedWrite: async (_route, write) => write(),
      },
      write: async () => 'applied',
    })).resolves.toBe('applied');

    expect(db.select().from(schema.githubIdentityWriteCycles).all()).toContainEqual(
      expect.objectContaining({
        state: 'completed',
        observedRouteCount: 1,
        appliedCount: 1,
      }),
    );
  });

  it('fences repository-only writes and quarantines every post-dispatch error', async () => {
    const { db, schema, identity } = await setupFixture();
    const connector = {
      type: 'github-issues',
      preflightWriteRoute: async (route: GitHubWriteAuthorization) => ({
        targets: Object.fromEntries(route.targets.map((target) => [
          target.role,
          target.issueNumber === null
            ? { repositoryStableId: 'R_repo' }
            : { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
        ])),
      }),
      runAuthorizedWrite: async <T>(
        _route: GitHubWriteAuthorization,
        write: () => Promise<T>,
      ) => write(),
    };

    await expect(identity.executeFencedGitHubSourceMutation({
      connectorInstanceId: 'github-fence',
      sourceListId: 'repo-list',
      operation: 'label',
      connector,
      write: async () => 'created-label',
    })).resolves.toBe('created-label');

    await expect(identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'comment',
      connector,
      write: async () => {
        throw new identity.GitHubWriteFenceError('authorized_route_mismatch');
      },
    })).rejects.toBeInstanceOf(identity.GitHubUnknownWriteOutcomeError);

    expect(db.select().from(schema.taskSourceWriteLeases).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'source-list:repo-list', state: 'succeeded' }),
        expect.objectContaining({ taskId: 'task-1', operation: 'comment', state: 'unknown' }),
      ]),
    );
    const cycles = db.select().from(schema.githubIdentityWriteCycles).all();
    expect(cycles.some((cycle) => cycle.unknownCount === 1 && cycle.appliedCount === 0))
      .toBe(true);
  });

  it('keeps a renamed locator authoritative by NodeID and blocks a binding revision race', async () => {
    const { db, sqlite, schema, identity, now } = await setupFixture();
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'full',
    });
    const disagreementCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });

    // source_id is a mutable locator: a rename must not change the route, which
    // stays the NodeID-bound issue.
    db.update(schema.tasks).set({
      sourceId: 'owner/replacement:7',
      updatedAt: '2026-08-10T12:01:00.000Z',
    }).where((await import('drizzle-orm')).eq(schema.tasks.id, 'task-1')).run();
    const renamed = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: disagreementCycle,
    });
    expect(renamed).toMatchObject({ owner: 'owner', repository: 'repo', issueNumber: 7 });
    await identity.blockGitHubWrite(renamed.leaseId, renamed.token, 'test_cleanup');
    await identity.finishGitHubWriteCycle(disagreementCycle, {
      observed: 1,
      applied: 0,
      blocked: 1,
      failed: 0,
      unknown: 0,
    });

    db.update(schema.tasks).set({
      sourceId: 'owner/repo:7',
      updatedAt: now,
    }).where((await import('drizzle-orm')).eq(schema.tasks.id, 'task-1')).run();
    const bindingCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const authorization = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'complete',
      identityRuntime: runtime,
      writeCycleId: bindingCycle,
    });
    sqlite.prepare(`
      UPDATE external_entity_bindings
      SET verified_at = ?, updated_at = ?
      WHERE id = 'issue-binding'
    `).run('2026-08-10T12:02:00.000Z', '2026-08-10T12:02:00.000Z');
    await expect(identity.confirmGitHubWriteDispatch(authorization))
      .rejects.toThrow('stale_mode_lease_or_locator');
    runtime.complete('failed', 'binding_revision_race');
  });

  it('rolls back lease observation when the linked cycle is interrupted before its counter update', async () => {
    const { db, sqlite, schema, identity } = await setupFixture();
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'full',
    });
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const observe = runtime.applyResolvedBatch.bind(runtime);
    runtime.applyResolvedBatch = (async (...args: Parameters<typeof observe>) => {
      const decisions = await observe(...args);
      sqlite.prepare(`
        UPDATE github_identity_write_cycles
        SET state = 'interrupted', completed_at = ?
        WHERE id = ?
      `).run('2026-08-10T12:00:01.000Z', cycleId);
      return decisions;
    }) as typeof runtime.applyResolvedBatch;

    await expect(identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    })).rejects.toThrow('write_cycle_observation_lost');

    const [lease] = db.select().from(schema.taskSourceWriteLeases).all();
    expect(lease).toMatchObject({
      state: 'claimed',
      cycleObservedAt: null,
      cycleOutcome: null,
      blockReason: null,
    });
    expect(db.select().from(schema.githubIdentityWriteCycles)
      .where((await import('drizzle-orm')).eq(schema.githubIdentityWriteCycles.id, cycleId))
      .get()).toMatchObject({
      state: 'interrupted',
      observedRouteCount: 0,
    });
    runtime.complete('failed', 'interrupted_before_cycle_observation');
  });

  it('rejects dispatch when the linked cycle observation marker is absent', async () => {
    const { db, schema, identity } = await setupFixture();
    const { eq } = await import('drizzle-orm');
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'full',
    });
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const authorization = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    db.update(schema.taskSourceWriteLeases).set({
      cycleObservedAt: null,
    }).where(eq(schema.taskSourceWriteLeases.id, authorization.leaseId)).run();

    await expect(identity.confirmGitHubWriteDispatch(authorization))
      .rejects.toThrow('stale_mode_lease_or_locator');
    expect(db.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, authorization.leaseId)).get())
      .toMatchObject({
        state: 'blocked',
        dispatchedAt: null,
        cycleObservedAt: null,
      });
    runtime.complete('failed', 'missing_cycle_observation_marker');
  });

  it('fences dispatch after cycle interruption and prevents a stale finisher from changing it', async () => {
    const { db, sqlite, schema, identity } = await setupFixture();
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'full',
    });
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const authorization = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'complete',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    sqlite.prepare(`
      UPDATE github_identity_write_cycles
      SET state = 'interrupted', completed_at = ?
      WHERE id = ?
    `).run('2026-08-10T12:00:01.000Z', cycleId);

    await expect(identity.confirmGitHubWriteDispatch(authorization))
      .rejects.toThrow('stale_mode_lease_or_locator');
    expect(await identity.finishGitHubWriteCycle(cycleId, {
      observed: 1,
      applied: 1,
      blocked: 0,
      failed: 0,
      unknown: 0,
    })).toBe(false);
    expect(db.select().from(schema.githubIdentityWriteCycles)
      .where((await import('drizzle-orm')).eq(schema.githubIdentityWriteCycles.id, cycleId))
      .get()).toMatchObject({
      state: 'interrupted',
      appliedCount: 0,
      blockedCount: 0,
    });
    expect(db.select().from(schema.taskSourceWriteLeases)
      .where((await import('drizzle-orm')).eq(
        schema.taskSourceWriteLeases.id,
        authorization.leaseId,
      )).get()).toMatchObject({
      state: 'claimed',
      dispatchedAt: null,
      cycleOutcome: null,
    });
    runtime.complete('failed', 'interrupted_before_dispatch');
  });

  it('prevents a dispatched stale finisher from changing an interrupted cycle', async () => {
    const { db, sqlite, schema, identity } = await setupFixture();
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'full',
    });
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const authorization = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'complete',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    await identity.verifyGitHubWritePreflight(authorization, {
      targets: {
        primary_issue: { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
        source_repository: { repositoryStableId: 'R_repo' },
      },
    });
    await identity.confirmGitHubWriteDispatch(authorization);
    sqlite.prepare(`
      UPDATE github_identity_write_cycles
      SET state = 'interrupted', completed_at = ?
      WHERE id = ?
    `).run('2026-08-10T12:00:01.000Z', cycleId);

    await expect(identity.finalizeGitHubWrite(authorization, 'succeeded'))
      .rejects.toThrow('lease_finalization_lost');
    expect(db.select().from(schema.taskSourceWriteLeases)
      .where((await import('drizzle-orm')).eq(
        schema.taskSourceWriteLeases.id,
        authorization.leaseId,
      )).get())
      .toMatchObject({ state: 'dispatched', cycleOutcome: null });
    runtime.complete('failed', 'interrupted_after_dispatch');
  });

  it('reclaims stale candidates, prevents overlapping push passes, and creates no no-op cycle', async () => {
    const { db, schema, identity } = await setupFixture();
    const { pushPendingChanges } = await import('@/lib/sync/push-manager');
    db.update(schema.tasks).set({
      syncStatus: 'pushing',
      lastSyncedAt: '2020-01-01T00:00:00.000Z',
    }).where((await import('drizzle-orm')).eq(schema.tasks.id, 'task-1')).run();
    const modeSnapshot = await identity.getGitHubIdentityModeSnapshot('github-fence');
    const firstRuntime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      syncKind: 'incremental',
    });
    let releasePreflight!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let resumePreflight!: () => void;
    const preflightResume = new Promise<void>((resolve) => {
      resumePreflight = resolve;
    });
    const updateTask = vi.fn(async () => ({
      id: 'task-1',
      sourceId: 'owner/repo:7',
      title: 'Fence me',
      status: 'todo' as const,
      priority: 'normal' as const,
      metadata: {},
    }));
    const connector = {
      type: 'github-issues',
      updateTask,
      preflightWriteRoute: vi.fn(async () => {
        releasePreflight();
        await preflightResume;
        return {
          targets: {
            primary_issue: { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
            source_repository: { repositoryStableId: 'R_repo' },
          },
        };
      }),
      runAuthorizedWrite: async <T>(
        _route: GitHubWriteAuthorization,
        write: () => Promise<T>,
      ) => write(),
    };
    const firstPush = pushPendingChanges(
      'github-fence',
      connector,
      undefined,
      undefined,
      { identityRuntime: firstRuntime, identityMode: modeSnapshot },
    );
    await preflightStarted;

    await expect(pushPendingChanges(
      'github-fence',
      connector,
      undefined,
      undefined,
      { identityRuntime: firstRuntime, identityMode: modeSnapshot },
    )).resolves.toEqual({ pushed: 0, errors: [] });
    resumePreflight();
    await expect(firstPush).resolves.toEqual({ pushed: 1, errors: [] });
    expect(updateTask).toHaveBeenCalledTimes(1);

    db.update(schema.tasks).set({
      syncStatus: 'pending_push',
    }).where((await import('drizzle-orm')).eq(schema.tasks.id, 'task-1')).run();
    const duplicate = await pushPendingChanges(
      'github-fence',
      connector,
      undefined,
      undefined,
      { identityRuntime: firstRuntime, identityMode: modeSnapshot },
    );
    expect(duplicate.pushed).toBe(0);
    expect(duplicate.errors).toEqual([]);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'task-1'))
      .get()).toMatchObject({
      syncStatus: 'push_failed',
      pushRetryCount: 5,
    });
    firstRuntime.complete('succeeded');

    const cyclesBeforeNoOp = db.select().from(schema.githubIdentityWriteCycles).all().length;
    await expect(pushPendingChanges(
      'github-fence',
      connector,
      undefined,
      undefined,
      { identityMode: modeSnapshot },
    )).resolves.toEqual({ pushed: 0, errors: [] });
    await expect(pushPendingChanges(
      'github-fence',
      connector,
      undefined,
      [],
      { identityMode: modeSnapshot },
    )).resolves.toEqual({ pushed: 0, errors: [] });
    expect(db.select().from(schema.githubIdentityWriteCycles).all())
      .toHaveLength(cyclesBeforeNoOp);
  }, 15_000);

  it('keeps a direct mutation from interrupting a sync-owned cycle between candidates', async () => {
    const { db, schema, identity } = await setupFixture();
    db.insert(schema.connectorOperationLeases).values({
      connectorId: 'github-fence',
      operationType: 'sync',
      owner: 'sync:test-owner',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-08-10T11:59:00.000Z',
      updatedAt: '2026-08-10T11:59:00.000Z',
    }).run();
    const modeSnapshot = await identity.getGitHubIdentityModeSnapshot('github-fence');
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      syncKind: 'incremental',
    });
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      pendingCandidateCount: 2,
    });
    const first = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    await identity.confirmGitHubWriteDispatch(first);
    await identity.finalizeGitHubWrite(first, 'succeeded');

    await expect(identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      pendingCandidateCount: 1,
    })).rejects.toThrow('active_write_cycle');
    expect(db.select().from(schema.githubIdentityWriteCycles).all())
      .toHaveLength(1);
    const second = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'complete',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    await identity.blockGitHubWrite(second.leaseId, second.token, 'test_cleanup');
    await identity.finishGitHubWriteCycle(cycleId, {
      observed: 2,
      applied: 1,
      blocked: 1,
      failed: 0,
      unknown: 0,
    });
    runtime.complete('succeeded');
  });

  it('interrupts a frozen cycle instead of dispatching a task changed after its push claim', async () => {
    const { db, schema, identity } = await setupFixture();
    const { claimTaskForPush, loadClaimedTaskForPush } = await import('@/lib/sync/push-lease');
    const { eq } = await import('drizzle-orm');
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'incremental',
    });
    const token = await claimTaskForPush('task-1');
    expect(token).toEqual(expect.any(String));
    const claimed = await loadClaimedTaskForPush('task-1', token!);
    expect(claimed).not.toBeNull();
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    db.update(schema.tasks).set({
      title: 'Edited after claim',
      updatedAt: '2026-08-10T12:05:00.000Z',
      syncStatus: 'pending_push',
    }).where(eq(schema.tasks.id, 'task-1')).run();

    await expect(identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: cycleId,
      expectedTaskVersion: claimed!.updatedAt,
      taskPushLeaseToken: token!,
    })).rejects.toThrow('stale_task_push_claim');
    expect(await identity.finishGitHubWriteCycle(cycleId, {
      observed: 0,
      applied: 0,
      blocked: 0,
      failed: 0,
      unknown: 0,
    })).toBe(false);
    expect(db.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, cycleId))
      .get()).toMatchObject({
      state: 'interrupted',
      pendingCandidateCount: 1,
      observedRouteCount: 0,
    });
    expect(db.select().from(schema.taskSourceWriteLeases).all()).toHaveLength(0);
    runtime.complete('succeeded');
  });

  it('prevents a reconciler-owned cycle from being completed by its prior worker', async () => {
    const { db, schema, identity } = await setupFixture();
    const { eq } = await import('drizzle-orm');
    const modeSnapshot = await identity.getGitHubIdentityModeSnapshot('github-fence');
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      pendingCandidateCount: 1,
    });
    db.update(schema.githubIdentityWriteCycles).set({
      reconciliationState: 'quarantined',
      reconciliationCode: 'operator_owned',
    }).where(eq(schema.githubIdentityWriteCycles.id, cycleId)).run();

    expect(await identity.finishGitHubWriteCycle(cycleId, {
      observed: 1,
      applied: 0,
      blocked: 1,
      failed: 0,
      unknown: 0,
    })).toBe(false);
    expect(db.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, cycleId))
      .get()).toMatchObject({
      state: 'running',
      reconciliationState: 'quarantined',
      pendingCandidateCount: 1,
    });
  });

  it('expires an abandoned undispatched lease before authorizing its retry cycle', async () => {
    const { db, schema, identity } = await setupFixture();
    const { eq } = await import('drizzle-orm');
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'incremental',
    });
    const abandonedCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const abandoned = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: abandonedCycle,
    });
    db.update(schema.taskSourceWriteLeases).set({
      expiresAt: '2020-01-01T00:00:00.000Z',
    }).where(eq(schema.taskSourceWriteLeases.id, abandoned.leaseId)).run();

    const retryCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    expect(db.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, abandoned.leaseId))
      .get()).toMatchObject({
      state: 'expired',
      dispatchedAt: null,
      cycleOutcome: null,
    });
    expect(db.select().from(schema.githubIdentityWriteCycles)
      .where(eq(schema.githubIdentityWriteCycles.id, abandonedCycle))
      .get()).toMatchObject({
      state: 'interrupted',
      reconciliationState: 'unresolved',
    });

    const retry = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: retryCycle,
    });
    await identity.blockGitHubWrite(retry.leaseId, retry.token, 'test_cleanup');
    await identity.finishGitHubWriteCycle(retryCycle, {
      observed: 1,
      applied: 0,
      blocked: 1,
      failed: 0,
      unknown: 0,
    });
    runtime.complete('succeeded');
  });

  it('uses version-independent idempotency for creates until their identity is persisted', async () => {
    const { db, schema, identity } = await setupFixture();
    const { eq } = await import('drizzle-orm');
    db.update(schema.tasks).set({
      sourceId: 'local:task-1',
      updatedAt: '2026-08-10T12:01:00.000Z',
    }).where(eq(schema.tasks.id, 'task-1')).run();
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'incremental',
    });
    const firstCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const first = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'create',
      identityRuntime: runtime,
      writeCycleId: firstCycle,
    });
    expect(db.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, first.leaseId))
      .get()).toMatchObject({
      idempotencyKey: 'task-1:create:2026-08-10T12:01:00.000Z',
    });
    await identity.confirmGitHubWriteDispatch(first);
    await identity.finalizeGitHubWrite(first, 'succeeded', undefined, { sourceId: 'owner/repo:8' });
    await identity.finishGitHubWriteCycle(firstCycle, {
      observed: 1,
      applied: 1,
      blocked: 0,
      failed: 0,
      unknown: 0,
    });
    db.update(schema.tasks).set({
      title: 'Edited while create was in flight',
      updatedAt: '2026-08-10T12:02:00.000Z',
    }).where(eq(schema.tasks.id, 'task-1')).run();
    const retryCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });

    await expect(identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'create',
      identityRuntime: runtime,
      writeCycleId: retryCycle,
    })).rejects.toThrow('write_already_succeeded');
    expect(await identity.finishGitHubWriteCycle(retryCycle, {
      observed: 0,
      applied: 0,
      blocked: 0,
      failed: 0,
      unknown: 0,
    })).toBe(false);
    runtime.complete('failed', 'duplicate_create_fenced');
  });

  it('does not suppress a succeeded intent after its frozen locator revision changes', async () => {
    const { db, schema, identity, now } = await setupFixture();
    const { eq } = await import('drizzle-orm');
    const modeSnapshot = await identity.getGitHubIdentityModeSnapshot('github-fence');
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      syncKind: 'incremental',
    });
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      pendingCandidateCount: 1,
    });
    const authorization = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    await identity.confirmGitHubWriteDispatch(authorization);
    await identity.finalizeGitHubWrite(authorization, 'succeeded');
    await identity.finishGitHubWriteCycle(cycleId, {
      observed: 1,
      applied: 1,
      blocked: 0,
      failed: 0,
      unknown: 0,
    });
    db.update(schema.externalEntityLocators).set({
      locatorRevision: 2,
      lastSeenAt: '2026-08-10T12:02:00.000Z',
    }).where(eq(schema.externalEntityLocators.id, 'issue-locator')).run();
    db.update(schema.tasks).set({
      syncStatus: 'pushing',
      lastSyncedAt: '2026-08-10T12:03:00.000Z',
    }).where(eq(schema.tasks.id, 'task-1')).run();

    expect(await identity.hasSucceededGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      expectedTaskVersion: now,
      taskPushLeaseToken: '2026-08-10T12:03:00.000Z',
    })).toBe(false);
    runtime.complete('succeeded');
  });

  it('does not suppress a retry proven not applied by audited outcome evidence', async () => {
    const { db, schema, identity, now } = await setupFixture();
    const { eq } = await import('drizzle-orm');
    const modeSnapshot = await identity.getGitHubIdentityModeSnapshot('github-fence');
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      syncKind: 'incremental',
    });
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot,
      pendingCandidateCount: 1,
    });
    const authorization = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'complete',
      identityRuntime: runtime,
      writeCycleId: cycleId,
    });
    await identity.confirmGitHubWriteDispatch(authorization);
    await identity.finalizeGitHubWrite(authorization, 'failed', 'proven_not_applied');
    await identity.finishGitHubWriteCycle(cycleId, {
      observed: 1,
      applied: 0,
      blocked: 0,
      failed: 1,
      unknown: 0,
    });
    db.insert(schema.githubWriteOutcomeEvents).values({
      id: 'not-applied-event',
      connectorInstanceId: 'github-fence',
      cycleId,
      leaseId: authorization.leaseId,
      taskId: 'task-1',
      operation: 'complete',
      taskVersion: now,
      expectedModeRevision: modeSnapshot.modeRevision,
      outcome: 'proven_not_applied_retryable',
      proofKind: 'issue_state',
      proofDigest: 'a'.repeat(64),
      remoteState: 'open',
      actor: 'test-operator',
      reason: 'Authoritative issue state remained open',
      idempotencyKey: 'not-applied-retry-proof',
      createdAt: '2026-08-10T12:04:00.000Z',
    }).run();
    db.update(schema.tasks).set({
      syncStatus: 'pushing',
      lastSyncedAt: '2026-08-10T12:05:00.000Z',
    }).where(eq(schema.tasks.id, 'task-1')).run();

    expect(await identity.hasSucceededGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'complete',
      expectedTaskVersion: now,
      taskPushLeaseToken: '2026-08-10T12:05:00.000Z',
    })).toBe(false);
    runtime.complete('failed', 'proven_not_applied_retryable');
  });

  it('does not collapse unscoped label writes into a prior succeeded task lease', async () => {
    const { identity } = await setupFixture();
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'incremental',
    });
    const firstCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const first = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'label',
      identityRuntime: runtime,
      writeCycleId: firstCycle,
    });
    await identity.confirmGitHubWriteDispatch(first);
    await identity.finalizeGitHubWrite(first, 'succeeded');
    await identity.finishGitHubWriteCycle(firstCycle, {
      observed: 1,
      applied: 1,
      blocked: 0,
      failed: 0,
      unknown: 0,
    });
    const secondCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });

    const second = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'label',
      identityRuntime: runtime,
      writeCycleId: secondCycle,
    });
    expect(second.leaseId).not.toBe(first.leaseId);
    await identity.blockGitHubWrite(second.leaseId, second.token, 'test_cleanup');
    await identity.finishGitHubWriteCycle(secondCycle, {
      observed: 1,
      applied: 0,
      blocked: 1,
      failed: 0,
      unknown: 0,
    });
    runtime.complete('succeeded');
  });

  it('permits an empty update as a read probe but fences an actual direct update', async () => {
    await setupFixture();
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize({
      id: 'github-fence',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'manual',
      capabilities: { read: true, write: true },
      credentials: { token: 'test-token' },
      settings: {},
      syncedLists: ['owner/repo'],
    } as unknown as ConnectorConfig);
    const restFetch = vi.fn(async () => Response.json({
      number: 7,
      node_id: 'I_issue',
      title: 'Observed issue',
      body: '',
      state: 'open',
      labels: [],
      user: { login: 'octocat' },
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-03T12:00:00.000Z',
      html_url: 'https://github.com/owner/repo/issues/7',
    }, { status: 200 }));
    (connector as unknown as { client: { restFetch: typeof restFetch } }).client = { restFetch };

    await expect(connector.updateTask('owner/repo:7', {}))
      .resolves.toMatchObject({ sourceId: 'owner/repo:7', title: 'Observed issue' });
    expect(restFetch).toHaveBeenCalledWith('/repos/owner/repo/issues/7');
    await expect(connector.updateTask('owner/repo:7', { title: 'Mutation' }))
      .rejects.toMatchObject({ code: 'direct_write_requires_fence' });
    expect(restFetch).toHaveBeenCalledTimes(1);
  });

  it('routes stable writes through the current locator and revision-fences rollback', async () => {
    const { db, schema, identity, now } = await setupFixture();
    const { eq } = await import('drizzle-orm');
    db.update(schema.githubIdentityMigrations).set({
      phase: 'complete',
      updatedAt: now,
    }).where(eq(schema.githubIdentityMigrations.connectorInstanceId, 'github-fence')).run();
    db.update(schema.githubIdentityControls).set({
      modeRevision: 5,
      updatedAt: now,
    }).where(eq(schema.githubIdentityControls.connectorInstanceId, 'github-fence')).run();
    db.update(schema.externalEntityBindings).set({
      state: 'active',
    }).where(eq(schema.externalEntityBindings.connectorInstanceId, 'github-fence')).run();
    db.update(schema.tasks).set({
      sourceId: 'legacy/path:7',
    }).where(eq(schema.tasks.id, 'task-1')).run();
    db.update(schema.sourceLists).set({
      sourceId: 'legacy/path',
    }).where(eq(schema.sourceLists.id, 'repo-list')).run();

    let authorized: GitHubWriteAuthorization | undefined;
    const connector = {
      type: 'github-issues',
      preflightWriteRoute: async (route: GitHubWriteAuthorization) => {
        authorized = route;
        return {
          targets: {
            primary_issue: { repositoryStableId: 'R_repo', issueStableId: 'I_issue' },
            source_repository: { repositoryStableId: 'R_repo' },
          },
        };
      },
      runAuthorizedWrite: async <T>(
        _route: GitHubWriteAuthorization,
        write: () => Promise<T>,
      ) => write(),
    };
    await expect(identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'transfer',
      connector,
      write: async () => 'stable-applied',
    })).resolves.toBe('stable-applied');
    expect(authorized).toMatchObject({
      owner: 'owner',
      repository: 'repo',
      issueNumber: 7,
    });
    expect(db.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.taskId, 'task-1')).all())
      .toContainEqual(expect.objectContaining({
        state: 'succeeded',
      }));
    await expect(identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'label',
      connector,
      write: async () => {
        throw new Error('connection closed after stable dispatch');
      },
    })).rejects.toBeInstanceOf(identity.GitHubUnknownWriteOutcomeError);
    const unknownLease = db.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.operation, 'label')).get()!;
    expect(unknownLease).toMatchObject({
      state: 'unknown',
    });

    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const actualConnector = new GitHubIssuesConnector();
    await actualConnector.initialize({
      id: 'github-fence',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'manual',
      capabilities: { read: true, write: true },
      credentials: { token: 'test-token' },
      settings: {},
      syncedLists: ['legacy/path'],
    } as unknown as ConnectorConfig);
    const routedFetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/repos/owner/repo') {
        return Response.json({ full_name: 'owner/repo', node_id: 'R_repo' });
      }
      if (path === '/repos/owner/repo/issues/7') {
        return Response.json({
          number: 7,
          node_id: 'I_issue',
          title: init?.method === 'PATCH' ? 'Routed update' : 'Observed issue',
          body: '',
          state: 'open',
          labels: [],
          user: { login: 'octocat' },
          created_at: now,
          updated_at: now,
          html_url: 'https://github.com/owner/repo/issues/7',
        });
      }
      return new Response(null, { status: 404 });
    });
    (actualConnector as unknown as { client: { restFetch: typeof routedFetch } }).client = {
      restFetch: routedFetch,
    };
    await expect(identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      connector: actualConnector,
      write: () => actualConnector.updateTask('legacy/path:7', { title: 'Routed update' }),
    })).resolves.toMatchObject({ sourceId: 'owner/repo:7', title: 'Routed update' });
    expect(routedFetch.mock.calls.some(([path]) => path.includes('/repos/legacy/path')))
      .toBe(false);
    db.update(schema.tasks).set({
      updatedAt: '2026-08-10T20:00:01.000Z',
    }).where(eq(schema.tasks.id, 'task-1')).run();
    routedFetch.mockClear();
    await expect(identity.executeFencedGitHubTaskMutation({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'update',
      connector: actualConnector,
      write: () => actualConnector.updateTask('legacy/path:7', { priority: 'high' }),
    })).resolves.toMatchObject({
      sourceId: 'owner/repo:7',
      title: 'Observed issue',
    });
    expect(routedFetch).toHaveBeenCalledWith('/repos/owner/repo/issues/7');
    expect(routedFetch.mock.calls.some(([path]) => path.includes('/repos/legacy/path')))
      .toBe(false);

    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      syncKind: 'incremental',
    });
    const staleCycle = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-fence',
      modeSnapshot: await identity.getGitHubIdentityModeSnapshot('github-fence'),
      pendingCandidateCount: 1,
    });
    const stale = await identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-fence',
      taskId: 'task-1',
      operation: 'comment',
      identityRuntime: runtime,
      writeCycleId: staleCycle,
    });
    // Bumping the connector identity epoch must fence an already authorized write.
    db.update(schema.githubIdentityControls).set({ modeRevision: 6, updatedAt: now })
      .where(eq(schema.githubIdentityControls.connectorInstanceId, 'github-fence')).run();
    await expect(identity.confirmGitHubWriteDispatch(stale))
      .rejects.toThrow('stale_mode_lease_or_locator');
    expect(db.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, unknownLease.id)).get())
      .toMatchObject({ state: 'unknown' });
    runtime.complete('failed', 'identity_revision_fence');
  });
});

async function setupFixture() {
  const [{ default: db, sqlite }, schema, identity] = await Promise.all([
    importInitializedSqliteDatabase(),
    import('@/db/schema'),
    import('@/lib/external-identities'),
  ]);
  const now = '2026-08-10T12:00:00.000Z';
  db.insert(schema.connectorConfigs).values({
    id: 'github-fence',
    type: 'github-issues',
    name: 'GitHub',
    capabilities: {},
    credentials: {},
    settings: {},
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: 'github-fence',
    phase: 'complete',
    updatedAt: now,
  }).run();
  db.insert(schema.githubIdentityControls).values({
    connectorInstanceId: 'github-fence',
    modeRevision: 4,
    updatedAt: now,
  }).run();
  db.insert(schema.sourceLists).values({
    id: 'repo-list',
    connectorInstanceId: 'github-fence',
    sourceId: 'owner/repo',
    name: 'owner/repo',
    type: 'repo',
  }).run();
  db.insert(schema.tasks).values({
    id: 'task-1',
    connectorType: 'github-issues',
    connectorInstanceId: 'github-fence',
    sourceId: 'owner/repo:7',
    sourceListId: 'repo-list',
    title: 'Fence me',
    status: 'todo',
    priority: 'normal',
    metadata: {},
    syncStatus: 'pending_push',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  }).run();
  seedIdentity(db, schema, now);
  return { db, sqlite, schema, identity, now };
}

function seedIdentity(
  db: typeof import('@/db').default,
  schema: typeof import('@/db/schema'),
  now: string,
): void {
  db.insert(schema.externalEntities).values([
    {
      id: 'repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository',
      stableId: 'R_repo',
      firstSeenAt: now,
      lastSeenAt: now,
    },
    {
      id: 'issue-entity',
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'issue',
      stableId: 'I_issue',
      firstSeenAt: now,
      lastSeenAt: now,
    },
  ]).run();
  db.insert(schema.externalEntityLocators).values([
    {
      id: 'repo-locator',
      externalEntityId: 'repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      owner: 'owner',
      repository: 'repo',
      ownerKey: 'owner',
      repositoryKey: 'repo',
      validFrom: now,
      lastSeenAt: now,
      observationSource: 'rest',
      locatorRevision: 1,
    },
    {
      id: 'issue-locator',
      externalEntityId: 'issue-entity',
      repositoryEntityId: 'repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      owner: 'owner',
      repository: 'repo',
      ownerKey: 'owner',
      repositoryKey: 'repo',
      issueNumber: 7,
      validFrom: now,
      lastSeenAt: now,
      observationSource: 'rest',
      locatorRevision: 1,
    },
  ]).run();
  db.insert(schema.externalEntityBindings).values([
    {
      id: 'repo-binding',
      externalEntityId: 'repo-entity',
      connectorInstanceId: 'github-fence',
      bindingType: 'source_list',
      localId: 'repo-list',
      state: 'active',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'issue-binding',
      externalEntityId: 'issue-entity',
      connectorInstanceId: 'github-fence',
      bindingType: 'task',
      localId: 'task-1',
      state: 'active',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]).run();
}
