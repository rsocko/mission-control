import { describe, expect, it } from 'vitest';
import type { GitHubRecoveryPersistence } from '@/db/persistence/github-recovery';
import {
  BACKUP_ATTESTATION_MAX_AGE_MS,
  BACKUP_ATTESTATION_MAX_CLOCK_SKEW_MS,
  isBackupAttestationReady,
} from '@/db/persistence/github-recovery-values';

/**
 * Shared Layer 3B contract suite.
 *
 * The same assertions run against the SQLite adapter
 * (`tests/db/sqlite-github-recovery-repositories.test.ts`) and the live
 * PostgreSQL adapter
 * (`tests/db/postgres-github-recovery-repositories.integration.test.ts`), so a
 * behavioural difference between the backends fails the build rather than
 * surfacing during an operator recovery.
 */

export interface RecoveryEntityFixture {
  id: string;
  entityType: 'repository' | 'issue';
  stableId: string;
  owner: string;
  repository: string;
  issueNumber?: number;
  repositoryEntityId?: string;
}

export interface RecoveryFixture {
  connectorInstanceId: string;
  enabled: boolean;
  repos: string[];
  syncedLists: string[];
  token: string;
  modeRevision: number;
  sourceLists: Array<{ id: string; sourceId: string }>;
  entities: RecoveryEntityFixture[];
  bindings: Array<{
    id: string;
    externalEntityId: string;
    bindingType: 'task' | 'source_list';
    localId: string;
    state: 'shadow' | 'active';
  }>;
  tasks: Array<{ id: string; sourceId: string; title: string; status: string }>;
}

export interface GitHubRecoveryHarness {
  repositories: GitHubRecoveryPersistence;
  seed(fixture: RecoveryFixture): Promise<void>;
  readTask(taskId: string): Promise<{ sourceId: string; sourceListId: string | null } | null>;
  setTaskTitle(taskId: string, title: string): Promise<void>;
  connectorEnabled(connectorInstanceId: string): Promise<boolean>;
  countOpenCollisions(connectorInstanceId: string): Promise<number>;
  countMaintenanceLocks(connectorInstanceId: string): Promise<number>;
  readSourceList(id: string): Promise<{ sourceId: string; name: string } | null>;
}

const OBSERVED_AT = '2026-08-20T12:00:00.000Z';
const NOW = '2026-08-20T12:05:00.000Z';

export function describeGitHubRecoveryBackupAttestationContract(backend: string): void {
  describe(`GitHub recovery backup attestation (${backend})`, () => {
    const now = new Date('2026-08-30T20:00:00.000Z');
    const current = {
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      modifiedAt: '2026-08-30T19:00:00.000Z',
      integrityCheck: 'ok',
      verifiedAt: '2026-08-30T19:05:00.000Z',
    };

    it('accepts current snapshots and the inclusive 24-hour boundary', () => {
      expect(isBackupAttestationReady(current, now)).toBe(true);
      expect(isBackupAttestationReady({
        ...current,
        modifiedAt: new Date(now.getTime() - BACKUP_ATTESTATION_MAX_AGE_MS).toISOString(),
        verifiedAt: new Date(now.getTime() - BACKUP_ATTESTATION_MAX_AGE_MS).toISOString(),
      }, now)).toBe(true);
      expect(isBackupAttestationReady({
        ...current,
        modifiedAt: new Date(
          now.getTime() + BACKUP_ATTESTATION_MAX_CLOCK_SKEW_MS,
        ).toISOString(),
        verifiedAt: new Date(
          now.getTime() + BACKUP_ATTESTATION_MAX_CLOCK_SKEW_MS,
        ).toISOString(),
      }, now)).toBe(true);
    });

    it('rejects an old snapshot even when verification is fresh', () => {
      expect(isBackupAttestationReady({
        ...current,
        modifiedAt: new Date(
          now.getTime() - BACKUP_ATTESTATION_MAX_AGE_MS - 1,
        ).toISOString(),
        verifiedAt: now.toISOString(),
      }, now)).toBe(false);
    });

    it('rejects an old verification even when the snapshot is current', () => {
      expect(isBackupAttestationReady({
        ...current,
        modifiedAt: new Date(now.getTime() - BACKUP_ATTESTATION_MAX_AGE_MS).toISOString(),
        verifiedAt: new Date(
          now.getTime() - BACKUP_ATTESTATION_MAX_AGE_MS - 1,
        ).toISOString(),
      }, now)).toBe(false);
    });

    it('rejects malformed and excessively future timestamps', () => {
      expect(isBackupAttestationReady({ ...current, modifiedAt: 'invalid' }, now)).toBe(false);
      expect(isBackupAttestationReady({ ...current, verifiedAt: 'invalid' }, now)).toBe(false);
      expect(isBackupAttestationReady({
        ...current,
        modifiedAt: new Date(
          now.getTime() + BACKUP_ATTESTATION_MAX_CLOCK_SKEW_MS + 1,
        ).toISOString(),
      }, now)).toBe(false);
      expect(isBackupAttestationReady({
        ...current,
        verifiedAt: new Date(
          now.getTime() + BACKUP_ATTESTATION_MAX_CLOCK_SKEW_MS + 1,
        ).toISOString(),
      }, now)).toBe(false);
    });
  });
}

export function baseFixture(connectorInstanceId: string): RecoveryFixture {
  return {
    connectorInstanceId,
    enabled: true,
    repos: ['acme/source'],
    syncedLists: ['acme/source'],
    token: 'ghp_contract_token',
    modeRevision: 4,
    sourceLists: [{ id: 'list-source', sourceId: 'acme/source' }],
    entities: [
      {
        id: 'entity-source-repo',
        entityType: 'repository',
        stableId: 'R_source',
        owner: 'acme',
        repository: 'source',
      },
      {
        id: 'entity-target-repo',
        entityType: 'repository',
        stableId: 'R_target',
        owner: 'acme',
        repository: 'target',
      },
      {
        id: 'entity-issue-7',
        entityType: 'issue',
        stableId: 'I_seven',
        owner: 'acme',
        repository: 'source',
        issueNumber: 7,
        repositoryEntityId: 'entity-source-repo',
      },
    ],
    bindings: [
      {
        id: 'binding-source-list',
        externalEntityId: 'entity-source-repo',
        bindingType: 'source_list',
        localId: 'list-source',
        state: 'active',
      },
      {
        id: 'binding-target-list',
        externalEntityId: 'entity-target-repo',
        bindingType: 'source_list',
        localId: 'list-target',
        state: 'active',
      },
      {
        id: 'binding-task-7',
        externalEntityId: 'entity-issue-7',
        bindingType: 'task',
        localId: 'task-7',
        state: 'active',
      },
    ],
    tasks: [
      { id: 'task-7', sourceId: 'acme/source:7', title: 'Seven', status: 'todo' },
    ],
  };
}

export function describeGitHubRecoveryRepositoriesContract(
  backend: string,
  createHarness: () => Promise<GitHubRecoveryHarness>,
): void {
  describe(`GitHub recovery repositories contract (${backend})`, () => {
    it('projects a non-secret connector snapshot and keeps credentials separate', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);

      const snapshot = await harness.repositories.transfer.getConnector(
        fixture.connectorInstanceId,
      );
      expect(snapshot).toMatchObject({
        id: fixture.connectorInstanceId,
        type: 'github-issues',
        enabled: true,
        syncedLists: ['acme/source'],
      });
      expect(JSON.stringify(snapshot)).not.toContain(fixture.token);

      const credentials = await harness.repositories.transfer.getConnectorCredentials(
        fixture.connectorInstanceId,
      );
      expect(credentials?.token).toBe(fixture.token);
      expect(await harness.repositories.transfer.getConnector('missing')).toBeNull();
    });

    it('resolves the durable identity epoch', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);

      expect(await harness.repositories.transfer.getIdentityModeSnapshot(
        fixture.connectorInstanceId,
      )).toEqual({
        connectorInstanceId: fixture.connectorInstanceId,
        modeRevision: 4,
      });
      expect(await harness.repositories.transfer.getIdentityModeSnapshot('missing'))
        .toEqual({ connectorInstanceId: 'missing', modeRevision: 0 });
    });

    it('resolves unambiguous repository bindings only', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);

      expect(await harness.repositories.repoint.getRepositoryBinding(
        fixture.connectorInstanceId,
        'acme/source',
      )).toEqual({
        repositoryEntityId: 'entity-source-repo',
        repositoryStableId: 'R_source',
        localId: 'list-source',
      });
      expect(await harness.repositories.bulkTransfer.getRepositoryBinding(
        fixture.connectorInstanceId,
        'ACME/Target',
      )).toEqual({ entityId: 'entity-target-repo', stableId: 'R_target' });
      expect(await harness.repositories.repoint.getRepositoryBinding(
        fixture.connectorInstanceId,
        'acme/unknown',
      )).toBeNull();
    });

    it('joins connector tasks to their stable issue bindings by route prefix', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);

      expect(await harness.repositories.transfer.listIssuePlanRows(
        fixture.connectorInstanceId,
        'acme/source',
      )).toEqual([{
        taskId: 'task-7',
        sourceId: 'acme/source:7',
        issueEntityId: 'entity-issue-7',
        issueStableId: 'I_seven',
        issueNumber: 7,
        repositoryEntityId: 'entity-source-repo',
      }]);
      expect(await harness.repositories.transfer.listIssuePlanRows(
        fixture.connectorInstanceId,
        'acme/target',
      )).toEqual([]);
      expect(await harness.repositories.transfer.getRepositoryStableId('entity-source-repo'))
        .toBe('R_source');
      expect(await harness.repositories.transfer.getRepositoryStableId('nope')).toBeNull();
    });

    it('reads the stable transfer binding and rejects a drifted route', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);

      expect(await harness.repositories.transfer.readTaskTransferBinding(
        fixture.connectorInstanceId,
        'task-7',
      )).toMatchObject({
        taskId: 'task-7',
        externalEntityId: 'entity-issue-7',
        stableId: 'I_seven',
        repositoryEntityId: 'entity-source-repo',
        locatorSourceId: 'acme/source:7',
      });
      await expect(harness.repositories.transfer.readTaskTransferBinding(
        fixture.connectorInstanceId,
        'missing-task',
      )).rejects.toThrow(/was not found/);
    });

    it('applies native transfer routing and refreshes bounded metadata', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);

      const result = await harness.repositories.transfer.applyNativeTransferRouting({
        connectorInstanceId: fixture.connectorInstanceId,
        taskId: 'task-7',
        issueEntityId: 'entity-issue-7',
        legacySourceId: 'acme/source:7',
        newSourceId: 'acme/target:31',
        targetRepository: 'acme/target',
        targetRepositoryEntityId: 'entity-target-repo',
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue',
          stableId: 'I_seven',
        },
        locator: { owner: 'acme', repository: 'target', issueNumber: 31 },
        observedAt: NOW,
        now: NOW,
        refreshMetadata: () => ({ issueNumber: 31 }),
      });

      expect(result).toEqual({ outcome: 'applied' });
      expect(await harness.readTask('task-7')).toMatchObject({
        sourceId: 'acme/target:31',
        sourceListId: 'acme/target',
      });
      expect(await harness.connectorEnabled(fixture.connectorInstanceId)).toBe(true);
    });

    it('fails closed on a destination locator collision', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      fixture.entities.push({
        id: 'entity-issue-31',
        entityType: 'issue',
        stableId: 'I_thirtyone',
        owner: 'acme',
        repository: 'target',
        issueNumber: 31,
        repositoryEntityId: 'entity-target-repo',
      });
      await harness.seed(fixture);

      const result = await harness.repositories.transfer.applyNativeTransferRouting({
        connectorInstanceId: fixture.connectorInstanceId,
        taskId: 'task-7',
        issueEntityId: 'entity-issue-7',
        legacySourceId: 'acme/source:7',
        newSourceId: 'acme/target:31',
        targetRepository: 'acme/target',
        targetRepositoryEntityId: 'entity-target-repo',
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue',
          stableId: 'I_seven',
        },
        locator: { owner: 'acme', repository: 'target', issueNumber: 31 },
        observedAt: NOW,
        now: NOW,
        refreshMetadata: () => ({}),
      });

      expect(result).toEqual({ outcome: 'collision' });
      expect(await harness.readTask('task-7')).toMatchObject({ sourceId: 'acme/source:7' });
      expect(await harness.connectorEnabled(fixture.connectorInstanceId)).toBe(false);
      expect(await harness.countOpenCollisions(fixture.connectorInstanceId)).toBe(1);
    });

    it('produces a stable task digest that reacts to local drift', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);

      const first = await harness.repositories.bulkTransfer.taskMetadataDigest('task-7');
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(await harness.repositories.bulkTransfer.taskMetadataDigest('task-7')).toBe(first);
      await harness.setTaskTitle('task-7', 'Seven (edited)');
      expect(await harness.repositories.bulkTransfer.taskMetadataDigest('task-7'))
        .not.toBe(first);
      await expect(harness.repositories.bulkTransfer.taskMetadataDigest('gone'))
        .rejects.toThrow(/disappeared/);
    });

    it('runs the bulk transfer run and item lifecycle', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);
      const ports = harness.repositories.bulkTransfer;
      const runId = '11111111-1111-4111-8111-111111111111';
      const beforeDigest = await ports.taskMetadataDigest('task-7');

      await ports.createRun({
        runId,
        connectorInstanceId: fixture.connectorInstanceId,
        idempotencyKey: 'contract-run-key',
        actor: 'operator',
        sourceRepository: 'acme/source',
        targetRepository: 'acme/target',
        planHash: 'a'.repeat(64),
        plan: { globalBeforeDigest: 'x', targetIssueStableIds: [] },
        items: [{
          taskId: 'task-7',
          issueEntityId: 'entity-issue-7',
          issueStableId: 'I_seven',
          sourceNumber: 7,
          beforeDigest,
        }],
        now: NOW,
      });

      expect(await harness.connectorEnabled(fixture.connectorInstanceId)).toBe(false);
      expect(await ports.findRun(fixture.connectorInstanceId, 'contract-run-key'))
        .toMatchObject({ id: runId, phase: 'running', connectorWasEnabled: true });
      expect(await ports.listItems(runId)).toHaveLength(1);
      expect(await ports.listItems(runId, ['transferring'])).toEqual([]);

      await ports.setItemState({
        runId,
        taskId: 'task-7',
        state: 'transferring',
        now: NOW,
      });
      expect(await ports.countItems(runId)).toEqual({
        totalCount: 1,
        transferredCount: 0,
        pendingCount: 0,
        ambiguousCount: 1,
        failedCount: 1,
      });

      await ports.appendEvent({
        runId,
        taskId: 'task-7',
        eventType: 'dispatch_accepted',
        payload: { targetNumber: 31 },
        createdAt: NOW,
      });
      expect(await ports.listAcceptedDispatchTargets(runId, 'task-7')).toEqual([31]);

      await ports.completeItem({
        runId,
        taskId: 'task-7',
        targetNumber: 31,
        newSourceId: 'acme/target:31',
        eventPayload: { newSourceId: 'acme/target:31' },
        now: NOW,
      });
      expect(await ports.getRun(runId)).toMatchObject({ transferredCount: 1 });
      expect(await ports.countItems(runId)).toMatchObject({
        transferredCount: 1,
        failedCount: 0,
      });

      await ports.completeRun({
        runId,
        connectorInstanceId: fixture.connectorInstanceId,
        connectorWasEnabled: true,
        transferredCount: 1,
        destinationBeforeCount: 0,
        destinationAfterCount: 1,
        now: NOW,
      });
      expect(await ports.getRun(runId)).toMatchObject({
        phase: 'completed',
        completedAt: NOW,
      });
      expect(await harness.connectorEnabled(fixture.connectorInstanceId)).toBe(true);
    });

    it('records failure counts and bounds the persisted error', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);
      const ports = harness.repositories.bulkTransfer;
      const runId = '22222222-2222-4222-8222-222222222222';
      await ports.createRun({
        runId,
        connectorInstanceId: fixture.connectorInstanceId,
        idempotencyKey: 'contract-fail-key',
        actor: 'operator',
        sourceRepository: 'acme/source',
        targetRepository: 'acme/target',
        planHash: 'b'.repeat(64),
        plan: {},
        items: [{
          taskId: 'task-7',
          issueEntityId: 'entity-issue-7',
          issueStableId: 'I_seven',
          sourceNumber: 7,
          beforeDigest: await ports.taskMetadataDigest('task-7'),
        }],
        now: NOW,
      });
      await ports.setItemState({
        runId,
        taskId: 'task-7',
        state: 'failed',
        lastError: 'boom',
        now: NOW,
      });
      await ports.failRun(runId, 'x'.repeat(2_000), NOW);

      const run = await ports.getRun(runId);
      expect(run).toMatchObject({ phase: 'failed', failedCount: 1 });
      expect(run?.lastError).toHaveLength(1_000);

      await expect(ports.getSuccession(runId, 'task-7')).resolves.toBeNull();
      expect(await ports.listSuccessions(runId)).toEqual([]);
    });

    it('locks, applies, verifies, and rolls back a repository repoint', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);
      const ports = harness.repositories.repoint;

      const inventory = await ports.collectInventory({
        connectorInstanceId: fixture.connectorInstanceId,
        from: 'acme/source',
        to: 'acme/renamed',
      });
      expect(inventory.counts).toMatchObject({
        connectorSettings: 1,
        connectorSyncedLists: 1,
        sourceLists: 1,
        tasks: 1,
        targetTaskConflicts: 0,
        targetSourceListConflicts: 0,
      });
      expect(inventory.activity).toEqual({
        queuedSyncJobs: 0,
        runningSyncJobs: 0,
        operationLeases: 0,
        maintenanceLocks: 0,
      });
      expect(inventory.deletionCandidates).toEqual([]);

      const operation = await ports.acquireOperation({
        connectorInstanceId: fixture.connectorInstanceId,
        idempotencyKey: 'contract-repoint-key',
        actor: 'operator',
        from: 'acme/source',
        to: 'acme/renamed',
        hostKey: 'github.com',
        repositoryEntityId: 'entity-source-repo',
        repositoryStableId: 'R_source',
        sourceListId: 'list-source',
        backupProof: { sha256: 'c'.repeat(64) },
        preflight: { counts: inventory.counts },
        relationships: inventory.relationships,
        taskIdDigest: 'd'.repeat(64),
        counts: inventory.counts,
        backupSha256: 'c'.repeat(64),
        now: NOW,
      });
      expect(operation).toMatchObject({
        phase: 'locked',
        connectorLocked: true,
        connectorWasEnabled: true,
      });
      expect(await harness.connectorEnabled(fixture.connectorInstanceId)).toBe(false);
      expect(await harness.countMaintenanceLocks(fixture.connectorInstanceId)).toBe(1);

      await expect(ports.acquireOperation({
        connectorInstanceId: fixture.connectorInstanceId,
        idempotencyKey: 'contract-repoint-key-2',
        actor: 'operator',
        from: 'acme/source',
        to: 'acme/renamed',
        hostKey: 'github.com',
        repositoryEntityId: 'entity-source-repo',
        repositoryStableId: 'R_source',
        sourceListId: 'list-source',
        backupProof: {},
        preflight: {},
        relationships: inventory.relationships,
        taskIdDigest: 'd'.repeat(64),
        counts: inventory.counts,
        backupSha256: 'c'.repeat(64),
        now: NOW,
      })).rejects.toThrow(/already has a maintenance lock/);

      expect(await ports.findOperationByIdempotency(
        fixture.connectorInstanceId,
        'contract-repoint-key',
      )).toMatchObject({ id: operation.id });

      const applied = await ports.applyOperation({
        operationId: operation.id,
        repositoryIdentity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'repository',
          stableId: 'R_source',
        },
        repositoryLocator: { owner: 'acme', repository: 'renamed' },
        repositoryObservedAt: NOW,
        repositorySourceListId: 'list-source',
        issues: [{
          taskId: 'task-7',
          issueEntityId: 'entity-issue-7',
          issueNumber: 7,
          identity: {
            provider: 'github',
            hostKey: 'github.com',
            entityType: 'issue',
            stableId: 'I_seven',
          },
          locator: { owner: 'acme', repository: 'renamed', issueNumber: 7 },
          observedAt: NOW,
        }],
        sourceListsUpdated: 1,
        now: NOW,
      });
      expect(applied).toEqual({ outcome: 'applied', tasksUpdated: 1 });
      expect(await harness.readTask('task-7')).toMatchObject({
        sourceId: 'acme/renamed:7',
        sourceListId: 'acme/renamed',
      });
      expect(await harness.readSourceList('list-source'))
        .toMatchObject({ sourceId: 'acme/renamed', name: 'acme/renamed' });

      // A second apply is a no-op: the operation already left `locked`.
      expect(await ports.applyOperation({
        operationId: operation.id,
        repositoryIdentity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'repository',
          stableId: 'R_source',
        },
        repositoryLocator: { owner: 'acme', repository: 'renamed' },
        repositoryObservedAt: NOW,
        repositorySourceListId: 'list-source',
        issues: [],
        sourceListsUpdated: 1,
        now: NOW,
      })).toEqual({ outcome: 'not-applicable' });

      expect(await ports.readRoutingSnapshot({
        connectorInstanceId: fixture.connectorInstanceId,
        from: 'acme/source',
        to: 'acme/renamed',
      })).toEqual({
        configuredRepositoryMatches: 1,
        configuredRepositorySourceMatches: 0,
        syncedListMatches: 1,
        syncedListSourceMatches: 0,
        targetSourceLists: 1,
        sourceSourceLists: 0,
        targetTasks: 1,
        sourceTasks: 0,
      });

      await ports.setOperationPhase({
        operationId: operation.id,
        phase: 'verifying',
        actor: 'operator',
        payload: {},
        now: NOW,
      });
      await ports.failVerification({
        operationId: operation.id,
        verification: { mismatchCount: 1 },
        error: 'mismatch',
        now: NOW,
      });
      expect(await ports.getOperation(operation.id)).toMatchObject({
        phase: 'verification_failed',
        lastError: 'mismatch',
        connectorLocked: true,
      });

      const rolledBack = await ports.rollbackOperation({
        operationId: operation.id,
        actor: 'operator',
        from: 'acme/source',
        to: 'acme/renamed',
        now: NOW,
      });
      expect(rolledBack).toEqual({ outcome: 'rolled-back' });
      expect(await harness.readTask('task-7')).toMatchObject({
        sourceId: 'acme/source:7',
        sourceListId: 'acme/source',
      });
      expect(await harness.readSourceList('list-source'))
        .toMatchObject({ sourceId: 'acme/source' });
      expect(await harness.connectorEnabled(fixture.connectorInstanceId)).toBe(false);
      expect(await harness.countMaintenanceLocks(fixture.connectorInstanceId)).toBe(0);

      // Re-running the rollback is an idempotent no-op once state already matches.
      expect(await ports.rollbackOperation({
        operationId: operation.id,
        actor: 'operator',
        from: 'acme/source',
        to: 'acme/renamed',
        now: NOW,
      })).toEqual({ outcome: 'already-rolled-back' });
    });

    it('completes and verifies a repoint, releasing the maintenance lock', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      await harness.seed(fixture);
      const ports = harness.repositories.repoint;
      const inventory = await ports.collectInventory({
        connectorInstanceId: fixture.connectorInstanceId,
        from: 'acme/source',
        to: 'acme/renamed',
      });
      const operation = await ports.acquireOperation({
        connectorInstanceId: fixture.connectorInstanceId,
        idempotencyKey: 'contract-repoint-verify',
        actor: 'operator',
        from: 'acme/source',
        to: 'acme/renamed',
        hostKey: 'github.com',
        repositoryEntityId: 'entity-source-repo',
        repositoryStableId: 'R_source',
        sourceListId: 'list-source',
        backupProof: { sha256: 'c'.repeat(64) },
        preflight: { counts: inventory.counts },
        relationships: inventory.relationships,
        taskIdDigest: 'd'.repeat(64),
        counts: inventory.counts,
        backupSha256: 'c'.repeat(64),
        now: NOW,
      });
      await ports.completeVerification({
        operationId: operation.id,
        verification: { mismatchCount: 0 },
        now: NOW,
      });

      expect(await ports.getOperation(operation.id)).toMatchObject({
        phase: 'verified',
        completedAt: NOW,
        connectorLocked: false,
      });
      expect(await harness.connectorEnabled(fixture.connectorInstanceId)).toBe(true);
      expect(await harness.countMaintenanceLocks(fixture.connectorInstanceId)).toBe(0);
    });

    it('records a historical succession once and replays it idempotently', async () => {
      const harness = await createHarness();
      const fixture = baseFixture('recovery-contract');
      fixture.entities.push({
        id: 'entity-issue-99',
        entityType: 'issue',
        stableId: 'I_ninetynine',
        owner: 'acme',
        repository: 'source',
        issueNumber: 99,
        repositoryEntityId: 'entity-source-repo',
      });
      fixture.bindings.push({
        id: 'binding-task-99',
        externalEntityId: 'entity-issue-99',
        bindingType: 'task',
        localId: 'task-99',
        state: 'active',
      });
      fixture.tasks.push({
        id: 'task-99',
        sourceId: 'acme/source:99',
        title: 'Ninety nine',
        status: 'todo',
      });
      await harness.seed(fixture);

      const request = {
        connectorInstanceId: fixture.connectorInstanceId,
        sourceTaskId: 'task-7',
        successorTaskId: 'task-99',
        expectedRevision: 4,
        requestedSourceId: 'acme/source:7',
        actor: 'operator',
        reason: 'REST historical endpoint resolves to the successor',
        idempotencyKey: 'contract-historical-key',
        now: NOW,
        observation: {
          evidence: {
            entity: {
              identity: {
                provider: 'github',
                hostKey: 'github.com',
                entityType: 'issue' as const,
                stableId: 'I_ninetynine',
              },
              locator: { owner: 'acme', repository: 'source', issueNumber: 99 },
              observationSource: 'rest' as const,
              observedAt: OBSERVED_AT,
            },
          },
          title: 'Ninety nine',
          state: 'open',
          stateReason: null,
        },
      };

      const first = await harness.repositories.transfer
        .recordHistoricalTransferReconciliation(request);
      expect(first).toMatchObject({
        changed: true,
        sourceTaskId: 'task-7',
        successorTaskId: 'task-99',
        proofKind: 'rest_historical_redirect',
      });

      const replay = await harness.repositories.transfer
        .recordHistoricalTransferReconciliation(request);
      expect(replay).toMatchObject({ changed: false, reconciliationId: first.reconciliationId });

      await expect(harness.repositories.transfer.recordHistoricalTransferReconciliation({
        ...request,
        idempotencyKey: 'contract-historical-other',
      })).rejects.toThrow(/already reconciled/);

      await expect(harness.repositories.transfer.recordHistoricalTransferReconciliation({
        ...request,
        expectedRevision: 9,
      })).rejects.toThrow(/identity mode revision changed/);
    });
  });
}
