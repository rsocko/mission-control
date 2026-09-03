import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import { eq } from 'drizzle-orm';
import type {
  ExternalIdentityObservation,
  ExternalIdentityWrite,
} from '@/lib/external-identities';
import type { GitHubRepositoryRepointRemote } from '@/lib/connectors/github-issues/repoint-service';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-github-repoint-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

const observedAt = '2026-08-10T12:00:00.000Z';
const operationTime = new Date('2026-08-10T12:05:00.000Z');

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identities: typeof import('@/lib/external-identities');
let service: typeof import('@/lib/connectors/github-issues/repoint-service');

beforeAll(async () => {
  database = await importInitializedSqliteDatabase();
  const { registerSqliteGitHubRepointBackupVerifier } = await import(
    '@/lib/connectors/github-issues/backup-verifier'
  );
  registerSqliteGitHubRepointBackupVerifier();
  schema = await import('@/db/schema');
  identities = await import('@/lib/external-identities');
  service = await import('@/lib/connectors/github-issues/repoint-service');
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GitHub repository repoint service', () => {
  it('transfers issues with GitHub GraphQL stable node IDs', async () => {
    const graphqlFetch = vi.fn(async () => ({
      data: {
        transferIssue: {
          issue: {
            number: 42,
            repository: { id: 'R_target' },
          },
        },
      },
    }));

    await expect(service.transferGitHubIssueByStableIdentity(
      { graphqlFetch },
      'I_issue',
      'R_target',
    )).resolves.toBe(42);
    expect(graphqlFetch).toHaveBeenCalledWith(
      expect.stringContaining('transferIssue(input:'),
      { issueId: 'I_issue', repositoryId: 'R_target' },
    );
  });

  it('rejects transfer responses that do not confirm the target repository', async () => {
    const graphqlFetch = vi.fn(async () => ({
      data: {
        transferIssue: {
          issue: {
            number: 42,
            repository: { id: 'R_other' },
          },
        },
      },
    }));

    await expect(service.transferGitHubIssueByStableIdentity(
      { graphqlFetch },
      'I_issue',
      'R_target',
    )).rejects.toThrow('invalid destination');
  });

  it('proves backup readability, integrity, recency, and digest', async () => {
    const backupPath = join(directory, 'verified-backup.db');
    await database.sqlite.backup(backupPath);
    const proof = await service.inspectGitHubRepointBackup(backupPath, new Date());
    expect(proof).toMatchObject({
      path: backupPath,
      integrityCheck: 'ok',
    });
    expect(proof.sizeBytes).toBeGreaterThan(0);
    expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.inspectGitHubRepointBackup(process.env.MC_DB_PATH!, new Date()))
      .rejects.toThrow('must not be the active');
  });

  it('enforces SQLite snapshot age and future-clock boundaries', async () => {
    const backupPath = join(directory, 'freshness-backup.db');
    const now = new Date('2026-08-30T20:00:00.000Z');
    await database.sqlite.backup(backupPath);

    const exactBoundary = new Date(now.getTime() - 24 * 60 * 60_000);
    utimesSync(backupPath, exactBoundary, exactBoundary);
    await expect(service.inspectGitHubRepointBackup(backupPath, now))
      .resolves.toMatchObject({ modifiedAt: exactBoundary.toISOString() });

    const oldSnapshot = new Date(exactBoundary.getTime() - 1);
    utimesSync(backupPath, oldSnapshot, oldSnapshot);
    await expect(service.inspectGitHubRepointBackup(backupPath, now))
      .rejects.toThrow('older than 24 hours');

    const futureSnapshot = new Date(now.getTime() + 5 * 60_000 + 1);
    utimesSync(backupPath, futureSnapshot, futureSnapshot);
    await expect(service.inspectGitHubRepointBackup(backupPath, now))
      .rejects.toThrow('future');
  });

  it('repoints a rename atomically, verifies identities, and preserves local relationships', async () => {
    const seeded = seedRepository('rename', 'old-owner/repo', 'R_rename', 'I_rename');
    const remote = stableRemote('old-owner/repo', 'new-owner/repo', 'R_rename', 'I_rename');

    const preflight = await service.preflightGitHubRepositoryRepoint(
      input('rename', 'old-owner/repo', 'new-owner/repo'),
      dependencies(remote),
    );
    expect(preflight).toMatchObject({
      go: true,
      repositoryIdentityMatches: true,
      oldPathStatus: 'same_repository',
      issueIdentitiesChecked: 1,
      issueIdentityMismatches: 0,
      missingIssueBindings: 0,
      counts: {
        connectorSettings: 1,
        connectorSyncedLists: 1,
        sourceLists: 1,
        tasks: 1,
      },
      relationships: { dependencies: 1 },
    });

    const result = await service.executeGitHubRepositoryRepoint(
      { ...input('rename', 'old-owner/repo', 'new-owner/repo'), idempotencyKey: 'rename-1' },
      dependencies(remote),
    );
    expect(result.phase).toBe('verified');
    expect(result.connectorLocked).toBe(false);

    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskId)).get()).toMatchObject({
      id: seeded.taskId,
      sourceId: 'new-owner/repo:17',
      sourceListId: 'new-owner/repo',
    });
    expect(database.default.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.id, seeded.dependencyId)).get()).toMatchObject({
      taskId: seeded.taskId,
      dependsOnTaskId: seeded.relatedTaskId,
    });
    expect(database.default.select().from(schema.connectorConfigs)
      .where(eq(schema.connectorConfigs.id, 'rename')).get()).toMatchObject({
      enabled: true,
      settings: { repos: ['new-owner/repo'] },
      syncedLists: ['new-owner/repo'],
    });

    const issueBinding = database.default.select().from(schema.externalEntityBindings)
      .where(eq(schema.externalEntityBindings.localId, seeded.taskId)).get()!;
    const locatorHistory = identities.listExternalEntityLocatorHistory(issueBinding.externalEntityId);
    expect(locatorHistory.map((locator) => `${locator.owner}/${locator.repository}`)).toEqual([
      'old-owner/repo',
      'new-owner/repo',
    ]);
    expect(locatorHistory[0].validTo).not.toBeNull();

    const events = database.default.select().from(schema.githubRepositoryRepointEvents)
      .where(eq(schema.githubRepositoryRepointEvents.operationId, result.id)).all();
    expect(events.map((event) => event.phase)).toEqual([
      'locked',
      'applying',
      'applied',
      'verifying',
      'verified',
    ]);
    expect(await service.executeGitHubRepositoryRepoint(
      { ...input('rename', 'old-owner/repo', 'new-owner/repo'), idempotencyKey: 'rename-1' },
      dependencies(remote),
    )).toMatchObject({ id: result.id, phase: 'verified' });
  });

  it('accepts an owner transfer but rejects path reuse and clean replacements', async () => {
    seedRepository('transfer', 'source/repo', 'R_transfer', 'I_transfer');
    expect((await service.preflightGitHubRepositoryRepoint(
      input('transfer', 'source/repo', 'destination/repo'),
      dependencies(stableRemote('source/repo', 'destination/repo', 'R_transfer', 'I_transfer')),
    )).go).toBe(true);

    seedRepository('reused', 'reused-old/repo', 'R_expected', 'I_expected');
    const reused = stableRemote('reused-old/repo', 'reused-new/repo', 'R_expected', 'I_expected', {
      oldStableId: 'R_replacement',
    });
    expect(await service.preflightGitHubRepositoryRepoint(
      input('reused', 'reused-old/repo', 'reused-new/repo'),
      dependencies(reused),
    )).toMatchObject({
      go: false,
      oldPathStatus: 'replacement',
      reasons: expect.arrayContaining(['old_repository_path_has_been_reused']),
    });

    seedRepository('replacement', 'replacement-old/repo', 'R_original', 'I_original');
    const replacement = stableRemote(
      'replacement-old/repo',
      'replacement-new/repo',
      'R_replacement',
      'I_original',
    );
    expect(await service.preflightGitHubRepositoryRepoint(
      input('replacement', 'replacement-old/repo', 'replacement-new/repo'),
      dependencies(replacement),
    )).toMatchObject({
      go: false,
      repositoryIdentityMatches: false,
      reasons: expect.arrayContaining(['target_repository_is_a_replacement']),
    });

    seedRepository('inaccessible', 'inaccessible-old/repo', 'R_inaccessible', 'I_inaccessible');
    const inaccessible: GitHubRepositoryRepointRemote = {
      async resolveRepository(repository) {
        if (repository === 'inaccessible-new/repo') return null;
        return repositoryObservation('inaccessible-old', 'repo', 'R_inaccessible');
      },
      async resolveIssue() {
        throw new Error('Issue resolution must not run without target repository evidence');
      },
    };
    expect(await service.preflightGitHubRepositoryRepoint(
      input('inaccessible', 'inaccessible-old/repo', 'inaccessible-new/repo'),
      dependencies(inaccessible),
    )).toMatchObject({
      go: false,
      reasons: expect.arrayContaining(['target_repository_inaccessible_or_missing_identity']),
    });
  });

  it('reports every mutable-state blocker with exact counts', async () => {
    const seeded = seedRepository('blocked', 'blocked-old/repo', 'R_blocked', 'I_blocked');
    database.default.update(schema.tasks).set({ syncStatus: 'pending_push' })
      .where(eq(schema.tasks.id, seeded.taskId)).run();
    database.default.update(schema.tasks).set({ syncStatus: 'push_failed' })
      .where(eq(schema.tasks.id, seeded.relatedTaskId)).run();
    database.default.insert(schema.syncDeletionCandidates).values({
      id: 'delete-blocked',
      connectorId: 'blocked',
      taskId: seeded.taskId,
      sourceId: 'blocked-old/repo:17',
      firstMissingAt: observedAt,
      lastMissingAt: observedAt,
      missingCount: 1,
    }).run();
    database.default.insert(schema.dependencyReconciliationSnapshots).values({
      id: 'dependency-blocked',
      connectorInstanceId: 'blocked',
      status: 'failed',
      cursor: 0,
      total: 1,
      batchSize: 1,
      failureCount: 1,
      importedCount: 0,
      removedCount: 0,
      startedAt: observedAt,
      updatedAt: observedAt,
    }).run();
    const issueBinding = database.default.select().from(schema.externalEntityBindings)
      .where(eq(schema.externalEntityBindings.localId, seeded.taskId)).get()!;
    identities.recordExternalIdentityCollision({
      connectorInstanceId: 'blocked',
      category: 'stable_legacy_disagree',
      bindingType: 'task',
      localIds: [seeded.taskId],
      externalEntityIds: [issueBinding.externalEntityId],
      legacyIdentity: 'blocked-old/repo:17',
      observedAt,
    });
    database.default.insert(schema.syncJobs).values({
      id: 'queued-blocked',
      connectorId: 'blocked',
      full: false,
      source: 'api',
      status: 'queued',
      attempt: 0,
      maxAttempts: 3,
      availableAt: observedAt,
      scheduledFor: observedAt,
      durationBudgetMs: 300_000,
      createdAt: observedAt,
      updatedAt: observedAt,
    }).run();

    const report = await service.preflightGitHubRepositoryRepoint(
      input('blocked', 'blocked-old/repo', 'blocked-new/repo'),
      dependencies(stableRemote('blocked-old/repo', 'blocked-new/repo', 'R_blocked', 'I_blocked')),
    );
    expect(report).toMatchObject({
      go: false,
      counts: {
        pendingPushes: 1,
        failedPushes: 1,
        deletionCandidates: 1,
        dependencySnapshots: 1,
        openIdentityCollisions: 1,
      },
      deletionCandidates: ['blocked-old/repo:17'],
      activity: { queuedSyncJobs: 1 },
      reasons: expect.arrayContaining([
        'pending_pushes_must_be_drained',
        'failed_pushes_must_be_resolved',
        'deletion_candidates_must_be_cleared',
        'dependency_snapshots_must_be_completed_or_cancelled',
        'open_identity_collisions',
        'connector_activity_must_be_drained',
      ]),
    });
  });

  it('resumes verification after interruption with the same idempotency key', async () => {
    seedRepository('resume', 'resume-old/repo', 'R_resume', 'I_resume');
    const base = stableRemote('resume-old/repo', 'resume-new/repo', 'R_resume', 'I_resume');
    let repositoryCalls = 0;
    const interrupted: GitHubRepositoryRepointRemote = {
      ...base,
      async resolveRepository(repository) {
        repositoryCalls++;
        if (repositoryCalls === 3) throw new Error('simulated verification interruption');
        return base.resolveRepository(repository);
      },
    };
    const executeInput = {
      ...input('resume', 'resume-old/repo', 'resume-new/repo'),
      idempotencyKey: 'resume-1',
    };

    await expect(service.executeGitHubRepositoryRepoint(
      executeInput,
      dependencies(interrupted),
    )).rejects.toThrow('simulated verification interruption');
    const operation = database.default.select().from(schema.githubRepositoryRepoints)
      .where(eq(schema.githubRepositoryRepoints.connectorInstanceId, 'resume')).get()!;
    expect(await service.getGitHubRepositoryRepointStatus(operation.id)).toMatchObject({
      phase: 'verifying',
      connectorLocked: true,
    });
    expect(await service.executeGitHubRepositoryRepoint(
      executeInput,
      dependencies(base),
    )).toMatchObject({ id: operation.id, phase: 'verified' });
  });

  it('resumes an operation interrupted immediately after durable lock acquisition', async () => {
    seedRepository(
      'locked-resume',
      'locked-old/repo',
      'R_locked',
      'I_locked',
    );
    const executeInput = {
      ...input('locked-resume', 'locked-old/repo', 'locked-new/repo'),
      idempotencyKey: 'locked-1',
    };
    seedInterruptedOperation(
      'locked-operation',
      executeInput,
      'R_locked',
      'locked',
    );

    const remote = stableRemote(
        'locked-old/repo',
        'locked-new/repo',
        'R_locked',
        'I_locked',
    );
    expect(await service.executeGitHubRepositoryRepoint(
      executeInput,
      {
        remote,
        now: () => new Date(operationTime.getTime() + 48 * 60 * 60_000),
      },
    )).toMatchObject({ id: 'locked-operation', phase: 'verified', connectorLocked: false });
  });

  it('never verifies a failed apply and recovers it only through guarded rollback', async () => {
    seedRepository('failed-apply', 'failed-old/repo', 'R_failed', 'I_failed');
    const executeInput = {
      ...input('failed-apply', 'failed-old/repo', 'failed-new/repo'),
      idempotencyKey: 'failed-1',
    };
    seedInterruptedOperation('failed-operation', executeInput, 'R_failed', 'failed');
    const remote = stableRemote(
      'failed-old/repo',
      'failed-new/repo',
      'R_failed',
      'I_failed',
    );

    await expect(service.verifyGitHubRepositoryRepoint(
      'failed-operation',
      dependencies(remote),
    )).rejects.toThrow('cannot be verified from phase failed');
    expect(await service.rollbackGitHubRepositoryRepoint(
      'failed-operation',
      'incident-operator',
      dependencies(remote),
    )).toMatchObject({
      id: 'failed-operation',
      phase: 'rolled_back',
      connectorLocked: false,
    });
  });

  it('leaves verification failures disabled and supports guarded rollback', async () => {
    const seeded = seedRepository('rollback', 'rollback-old/repo', 'R_rollback', 'I_rollback');
    const base = stableRemote('rollback-old/repo', 'rollback-new/repo', 'R_rollback', 'I_rollback');
    let issueCalls = 0;
    const mismatching: GitHubRepositoryRepointRemote = {
      ...base,
      async resolveIssue(repository, issueNumber, repositoryEvidence) {
        issueCalls++;
        const evidence = await base.resolveIssue(repository, issueNumber, repositoryEvidence);
        if (issueCalls === 2 && evidence) {
          return {
            ...evidence,
            entity: {
              ...evidence.entity,
              identity: { ...evidence.entity.identity, stableId: 'I_unexpected' },
            },
          };
        }
        return evidence;
      },
    };
    const failed = await service.executeGitHubRepositoryRepoint(
      {
        ...input('rollback', 'rollback-old/repo', 'rollback-new/repo'),
        idempotencyKey: 'rollback-1',
      },
      dependencies(mismatching),
    );
    expect(failed).toMatchObject({ phase: 'verification_failed', connectorLocked: true });
    expect(database.default.select().from(schema.connectorConfigs)
      .where(eq(schema.connectorConfigs.id, 'rollback')).get()?.enabled).toBe(false);

    await expect(service.rollbackGitHubRepositoryRepoint(
      failed.id,
      'incident-operator',
      dependencies(stableRemote(
        'rollback-old/repo',
        'rollback-new/repo',
        'R_rollback',
        'I_rollback',
        { oldStableId: 'R_reused' },
      )),
    )).rejects.toThrow('Rollback source repository identity verification failed');
    expect(await service.getGitHubRepositoryRepointStatus(failed.id))
      .toMatchObject({ phase: 'verification_failed', connectorLocked: true });

    const rolledBack = await service.rollbackGitHubRepositoryRepoint(
      failed.id,
      'incident-operator',
      dependencies(base),
    );
    expect(rolledBack).toMatchObject({ phase: 'rolled_back', connectorLocked: false });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskId)).get()).toMatchObject({
      id: seeded.taskId,
      sourceId: 'rollback-old/repo:17',
    });
    expect(database.default.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.id, seeded.dependencyId)).get()).toBeDefined();
    expect(database.default.select().from(schema.connectorConfigs)
      .where(eq(schema.connectorConfigs.id, 'rollback')).get()).toMatchObject({
      enabled: false,
      settings: { repos: ['rollback-old/repo'] },
    });
    expect(database.default.select().from(schema.sourceLists)
      .where(eq(schema.sourceLists.id, seeded.sourceListId)).get()).toMatchObject({
      sourceId: 'rollback-old/repo',
      name: 'rollback-old/repo',
      lastKnownRemoteName: null,
    });

    const operation = database.default.select().from(schema.githubRepositoryRepoints)
      .where(eq(schema.githubRepositoryRepoints.id, failed.id)).get()!;
    database.default.update(schema.sourceLists).set({
      sourceId: 'rollback-new/repo',
      name: 'rollback-new/repo',
      lastKnownRemoteName: 'rollback-new/repo',
    }).where(eq(schema.sourceLists.id, seeded.sourceListId)).run();
    database.default.update(schema.githubRepositoryRepoints).set({
      rollbackSnapshot: {
        ...operation.rollbackSnapshot,
        sourceList: undefined,
      },
    }).where(eq(schema.githubRepositoryRepoints.id, failed.id)).run();

    const repaired = await service.rollbackGitHubRepositoryRepoint(
      failed.id,
      'repair-operator',
      dependencies(base),
    );
    expect(repaired).toMatchObject({ phase: 'rolled_back', connectorLocked: false });
    expect(repaired.actor).toBe('incident-operator');
    expect(database.default.select().from(schema.sourceLists)
      .where(eq(schema.sourceLists.id, seeded.sourceListId)).get()).toMatchObject({
      sourceId: 'rollback-old/repo',
      name: 'rollback-old/repo',
      lastKnownRemoteName: 'rollback-old/repo',
    });
    const events = database.default.select().from(schema.githubRepositoryRepointEvents)
      .where(eq(schema.githubRepositoryRepointEvents.operationId, failed.id)).all();
    expect(events.at(-1)).toMatchObject({
      phase: 'rolled_back',
      actor: 'repair-operator',
      payload: {
        idempotentRepair: true,
        restoredSourceList: true,
        sourceListSnapshotMode: 'legacy_derived',
      },
    });
  });

  it('transfers an issue only after stable identity checks and writes parser-safe routing', async () => {
    const seeded = seedRepository('native', 'native/repo-a', 'R_native_a', 'I_native');
    seedTargetRepository('native', 'native/repo-b', 'R_native_b');
    database.default.update(schema.tasks).set({
      metadata: {
        issueNumber: 17,
        nodeId: 'I_native',
        url: 'https://github.test/native/repo-a/issues/17',
        retained: true,
      },
    }).where(eq(schema.tasks.id, seeded.taskId)).run();
    const transferIssue = vi.fn(async () => 42);
    const remote: GitHubRepositoryRepointRemote = {
      async resolveRepository(repository) {
        expect(database.sqlite.inTransaction).toBe(false);
        const [owner, name] = repository.split('/');
        return repositoryObservation(
          owner,
          name,
          repository === 'native/repo-a' ? 'R_native_a' : 'R_native_b',
        );
      },
      async resolveIssue(repository, issueNumber) {
        expect(database.sqlite.inTransaction).toBe(false);
        const [owner, name] = repository.split('/');
        return {
          repository: repositoryObservation(
            owner,
            name,
            repository === 'native/repo-a' ? 'R_native_a' : 'R_native_b',
          ),
          entity: issueObservation(owner, name, issueNumber, 'I_native'),
        };
      },
      transferIssue,
    };

    const result = await service.transferGitHubIssueSafely({
      connectorInstanceId: 'native',
      sourceId: 'native/repo-a:17',
      targetRepository: 'native/repo-b',
      actor: 'task-move-api',
    }, dependencies(remote));
    expect(result).toMatchObject({
      newSourceId: 'native/repo-b:42',
      identityVerified: true,
      issueStableId: 'I_native',
      repositoryStableId: 'R_native_b',
    });
    expect(transferIssue).toHaveBeenCalledWith('I_native', 'R_native_b');
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskId)).get()).toMatchObject({
      id: seeded.taskId,
      sourceId: 'native/repo-b:42',
      sourceListId: 'native/repo-b',
      metadata: {
        issueNumber: 42,
        nodeId: 'I_native',
        url: 'https://github.test/native/repo-b/issues/42',
        retained: true,
      },
    });
    expect(database.default.select().from(schema.connectorOperationLeases)
      .where(eq(schema.connectorOperationLeases.connectorId, 'native')).all()).toEqual([]);
  });

  it('waits for the transferred issue to become visible in the target repository', async () => {
    const seeded = seedRepository('eventual', 'eventual/repo-a', 'R_eventual_a', 'I_eventual');
    seedTargetRepository('eventual', 'eventual/repo-b', 'R_eventual_b');
    let destinationLookups = 0;
    const sleep = vi.fn(async () => {});
    const remote: GitHubRepositoryRepointRemote = {
      async resolveRepository(repository) {
        const [owner, name] = repository.split('/');
        return repositoryObservation(
          owner,
          name,
          repository === 'eventual/repo-a' ? 'R_eventual_a' : 'R_eventual_b',
        );
      },
      async resolveIssue(repository, issueNumber) {
        const [owner, name] = repository.split('/');
        if (repository === 'eventual/repo-b' && destinationLookups++ === 0) return null;
        return {
          repository: repositoryObservation(
            owner,
            name,
            repository === 'eventual/repo-a' ? 'R_eventual_a' : 'R_eventual_b',
          ),
          entity: issueObservation(owner, name, issueNumber, 'I_eventual'),
        };
      },
      async transferIssue() {
        return 42;
      },
    };

    await expect(service.transferGitHubIssueSafely({
      connectorInstanceId: 'eventual',
      sourceId: 'eventual/repo-a:17',
      targetRepository: 'eventual/repo-b',
      actor: 'task-move-api',
    }, {
      remote,
      now: () => operationTime,
      sleep,
    })).resolves.toMatchObject({
      newSourceId: 'eventual/repo-b:42',
      identityVerified: true,
    });
    expect(sleep).toHaveBeenCalledWith(250);
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskId)).get()).toMatchObject({
      sourceId: 'eventual/repo-b:42',
      sourceListId: 'eventual/repo-b',
    });
    expect(database.default.select().from(schema.connectorConfigs)
      .where(eq(schema.connectorConfigs.id, 'eventual')).get()?.enabled).toBe(true);
  });
});

function seedRepository(
  connectorId: string,
  repository: string,
  repositoryStableId: string,
  issueStableId: string,
) {
  const taskId = `${connectorId}-task`;
  const relatedTaskId = `${connectorId}-related`;
  const dependencyId = `${connectorId}-dependency`;
  const sourceListId = `${connectorId}:repo:${repository}`;
  database.default.insert(schema.connectorConfigs).values({
    id: connectorId,
    type: 'github-issues',
    name: connectorId,
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: { read: true, write: true, sync: true },
    credentials: { token: 'test-token' },
    settings: { repos: [repository] },
    syncedLists: [repository],
    createdAt: observedAt,
    updatedAt: observedAt,
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: connectorId,
    phase: 'shadow_write',
    updatedAt: observedAt,
  }).run();
  database.default.insert(schema.sourceLists).values({
    id: sourceListId,
    connectorInstanceId: connectorId,
    sourceId: repository,
    name: repository,
    type: 'repo',
    taskCount: 1,
    lastSyncedAt: observedAt,
  }).run();
  database.default.insert(schema.tasks).values([
    taskRow(taskId, connectorId, `${repository}:17`, repository),
    taskRow(relatedTaskId, connectorId, `local/${connectorId}:999`, repository),
  ]).run();
  database.default.insert(schema.taskDependencies).values({
    id: dependencyId,
    taskId,
    dependsOnTaskId: relatedTaskId,
    type: 'blocks',
    connectorInstanceId: connectorId,
    syncStatus: 'synced',
    createdAt: observedAt,
  }).run();

  const [owner, name] = repository.split('/');
  identities.persistExternalIdentityBatch([
    {
      target: {
        connectorInstanceId: connectorId,
        bindingType: 'source_list',
        localId: sourceListId,
        legacyIdentity: repository,
      },
      evidence: { entity: repositoryObservation(owner, name, repositoryStableId) },
    },
    issueWrite(connectorId, taskId, repository, 17, issueStableId, repositoryStableId),
  ]);
  return { taskId, relatedTaskId, dependencyId, sourceListId };
}

function taskRow(id: string, connectorId: string, sourceId: string, repository: string) {
  return {
    id,
    sourceId,
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: id,
    status: 'todo',
    priority: 'none',
    createdAt: observedAt,
    updatedAt: observedAt,
    lastSyncedAt: observedAt,
    sourceListId: repository,
    sourceListName: repository,
    metadata: {},
    syncStatus: 'synced',
  };
}

function seedTargetRepository(
  connectorId: string,
  repository: string,
  repositoryStableId: string,
): void {
  const sourceListId = `${connectorId}:repo:${repository}`;
  database.default.insert(schema.sourceLists).values({
    id: sourceListId,
    connectorInstanceId: connectorId,
    sourceId: repository,
    name: repository,
    type: 'repo',
    taskCount: 0,
    lastSyncedAt: observedAt,
  }).run();
  const [owner, name] = repository.split('/');
  identities.persistExternalIdentityBatch([{
    target: {
      connectorInstanceId: connectorId,
      bindingType: 'source_list',
      localId: sourceListId,
      legacyIdentity: repository,
    },
    evidence: { entity: repositoryObservation(owner, name, repositoryStableId) },
  }]);
}

function seedInterruptedOperation(
  operationId: string,
  executeInput: ReturnType<typeof input> & { idempotencyKey: string },
  repositoryStableId: string,
  phase: 'locked' | 'failed',
): void {
  const sourceListId = `${executeInput.connectorInstanceId}:repo:${executeInput.from}`;
  const repositoryBinding = database.default.select().from(schema.externalEntityBindings)
    .where(eq(schema.externalEntityBindings.localId, sourceListId)).get()!;
  const [fromOwner, fromRepository] = executeInput.from.split('/');
  const [toOwner, toRepository] = executeInput.to.split('/');
  database.default.insert(schema.githubRepositoryRepoints).values({
    id: operationId,
    connectorInstanceId: executeInput.connectorInstanceId,
    idempotencyKey: executeInput.idempotencyKey,
    phase,
    actor: executeInput.actor,
    hostKey: 'github.com',
    repositoryEntityId: repositoryBinding.externalEntityId,
    repositoryStableId,
    fromOwner,
    fromRepository,
    toOwner,
    toRepository,
    connectorWasEnabled: true,
    backupProof: executeInput.backupProof,
    preflight: { counts: { tasks: 1 } },
    rollbackSnapshot: {
      settings: { repos: [executeInput.from] },
      syncedLists: [executeInput.from],
    },
    createdAt: operationTime.toISOString(),
    updatedAt: operationTime.toISOString(),
  }).run();
  database.default.insert(schema.connectorMaintenanceLocks).values({
    connectorInstanceId: executeInput.connectorInstanceId,
    operationId,
    actor: executeInput.actor,
    reason: 'github_repository_repoint',
    acquiredAt: operationTime.toISOString(),
    updatedAt: operationTime.toISOString(),
  }).run();
  database.default.update(schema.connectorConfigs).set({ enabled: false })
    .where(eq(schema.connectorConfigs.id, executeInput.connectorInstanceId)).run();
}

function issueWrite(
  connectorId: string,
  taskId: string,
  repository: string,
  issueNumber: number,
  issueStableId: string,
  repositoryStableId: string,
): ExternalIdentityWrite {
  const [owner, name] = repository.split('/');
  return {
    target: {
      connectorInstanceId: connectorId,
      bindingType: 'task',
      localId: taskId,
      legacyIdentity: `${repository}:${issueNumber}`,
    },
    evidence: {
      repository: repositoryObservation(owner, name, repositoryStableId),
      entity: issueObservation(owner, name, issueNumber, issueStableId),
    },
  };
}

function repositoryObservation(
  owner: string,
  repository: string,
  stableId: string,
): ExternalIdentityObservation {
  return {
    identity: { provider: 'github', hostKey: 'github.com', entityType: 'repository', stableId },
    locator: { owner, repository },
    observationSource: 'rest',
    observedAt,
  };
}

function issueObservation(
  owner: string,
  repository: string,
  issueNumber: number,
  stableId: string,
): ExternalIdentityObservation {
  return {
    identity: { provider: 'github', hostKey: 'github.com', entityType: 'issue', stableId },
    locator: {
      owner,
      repository,
      issueNumber,
      webUrl: `https://github.test/${owner}/${repository}/issues/${issueNumber}`,
    },
    observationSource: 'rest',
    observedAt,
  };
}

function stableRemote(
  from: string,
  to: string,
  repositoryStableId: string,
  issueStableId: string,
  options: { oldStableId?: string } = {},
): GitHubRepositoryRepointRemote {
  return {
    async resolveRepository(repository) {
      expect(database.sqlite.inTransaction).toBe(false);
      const [owner, name] = (repository === from ? from : to).split('/');
      return repositoryObservation(
        owner,
        name,
        repository === from ? options.oldStableId ?? repositoryStableId : repositoryStableId,
      );
    },
    async resolveIssue(repository, issueNumber) {
      expect(database.sqlite.inTransaction).toBe(false);
      const [owner, name] = repository.split('/');
      const stableId = issueNumber === 17 ? issueStableId : `${issueStableId}_related`;
      return {
        repository: repositoryObservation(owner, name, repositoryStableId),
        entity: issueObservation(owner, name, issueNumber, stableId),
      };
    },
  };
}

function input(connectorInstanceId: string, from: string, to: string) {
  return {
    connectorInstanceId,
    from,
    to,
    actor: 'test-operator',
    backupProof: {
      path: join(directory, 'backup.db'),
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      modifiedAt: operationTime.toISOString(),
      integrityCheck: 'ok' as const,
      verifiedAt: operationTime.toISOString(),
    },
  };
}

function dependencies(remote: GitHubRepositoryRepointRemote) {
  return { remote, now: () => operationTime };
}
