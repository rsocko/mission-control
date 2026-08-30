import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DependencyEvidenceState,
  DependencyRecord,
  DependencySnapshotFence,
  DependencySnapshotRecord,
  GitHubDependencyPersistence,
} from '@/db/persistence/github-dependencies';

/**
 * Backend-neutral behavioural contract for the GitHub dependency persistence
 * port. Both the SQLite and PostgreSQL adapters must satisfy every assertion so
 * the fenced-write invariants (cursor compare-and-set, identity-epoch fencing,
 * bounded terminal retention, idempotent edge writes, no-delete on incomplete
 * collections) stay bit-for-bit portable.
 */
export interface GitHubDependencyHarness {
  repositories: GitHubDependencyPersistence;
  /** Sets the live GitHub identity epoch (`github_identity_controls.mode_revision`). */
  setIdentityEpoch(connectorInstanceId: string, revision: number): Promise<void>;
  /** Seeds an enabled connector config so resume reads can join it. */
  seedConnectorConfig(connectorId: string): Promise<void>;
  /** Inserts a full snapshot row verbatim. */
  seedSnapshot(record: DependencySnapshotRecord): Promise<void>;
  /** Inserts a minimal task row (dependencies FK-reference tasks). */
  seedTask(id: string, connectorInstanceId: string): Promise<void>;
  /** Inserts a task_dependencies row verbatim. */
  seedDependency(row: DependencyRecord): Promise<void>;
  close(): Promise<void> | void;
}

export const DEP_CONNECTOR = 'portable-dependency-connector';
const NOW = '2026-09-01T12:00:00.000Z';

export function dependencySnapshotRecord(
  overrides: Partial<DependencySnapshotRecord> = {},
): DependencySnapshotRecord {
  return {
    id: 'gen-1',
    connectorInstanceId: DEP_CONNECTOR,
    status: 'running',
    phase: 'reconciling',
    readMode: 'graphql-bulk',
    cursor: 0,
    total: 0,
    batchSize: 25,
    failureCount: 0,
    importedCount: 0,
    removedCount: 0,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    collectionCompletedAt: null,
    collectionPageCount: 0,
    overflowFetchCount: 0,
    identityMode: 'stable',
    identityModeRevision: 1,
    identityEvidenceSource: 'graphql-node',
    identityEvidenceEligible: false,
    identityEvidenceFailureReason: null,
    failedAt: null,
    nextAttemptAt: null,
    failureReason: null,
    lastResumeAttemptAt: null,
    lastResumeOutcome: null,
    lastResumeReason: null,
    ...overrides,
  };
}

export function dependencyRow(
  overrides: Partial<DependencyRecord> = {},
): DependencyRecord {
  return {
    id: 'dep-1',
    taskId: 'task-blocked',
    dependsOnTaskId: 'task-blocker',
    type: 'blocks',
    connectorInstanceId: DEP_CONNECTOR,
    syncStatus: 'synced',
    syncAction: null,
    syncError: null,
    lastSyncedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function fenceOf(record: DependencySnapshotRecord): DependencySnapshotFence {
  return {
    id: record.id,
    connectorInstanceId: record.connectorInstanceId,
    identityMode: record.identityMode,
    identityModeRevision: record.identityModeRevision,
  };
}

function evidenceState(state: DependencyEvidenceState): DependencyEvidenceState {
  return state;
}

export function describeGitHubDependencyRepositoriesContract(
  name: string,
  createHarness: () => Promise<GitHubDependencyHarness> | GitHubDependencyHarness,
): void {
  describe(`${name} GitHub dependency persistence contract`, () => {
    let harness: GitHubDependencyHarness;
    let repositories: GitHubDependencyPersistence;

    beforeEach(async () => {
      harness = await createHarness();
      repositories = harness.repositories;
      await harness.seedConnectorConfig(DEP_CONNECTOR);
      await harness.setIdentityEpoch(DEP_CONNECTOR, 1);
    });

    it('rejects a reconciliation batch whose cursor is stale (CAS)', async () => {
      const record = dependencySnapshotRecord({ cursor: 0, total: 4 });
      await harness.seedSnapshot(record);
      const fence = fenceOf(record);

      const firstAdvance = await repositories.applyReconciliationBatch({
        fence,
        batchStart: 0,
        batchEnd: 2,
        lastSyncedAt: NOW,
        stagedEdges: [],
        verifiedUpdates: [],
      });
      expect(firstAdvance).toBe(true);
      expect((await repositories.getSnapshotById(record.id))?.cursor).toBe(2);

      // A concurrent worker still believes the cursor is 0 — CAS must reject it.
      const staleAdvance = await repositories.applyReconciliationBatch({
        fence,
        batchStart: 0,
        batchEnd: 2,
        lastSyncedAt: NOW,
        stagedEdges: [],
        verifiedUpdates: [],
      });
      expect(staleAdvance).toBe(false);
      expect((await repositories.getSnapshotById(record.id))?.cursor).toBe(2);
    });

    it('schedules retry/backoff metadata when a batch is marked failed', async () => {
      const record = dependencySnapshotRecord({ cursor: 10, total: 20 });
      await harness.seedSnapshot(record);
      const fence = fenceOf(record);
      const nextAttemptAt = '2026-09-01T12:05:00.000Z';

      const staleReject = await repositories.markSnapshotFailed({
        fence,
        cursor: 9,
        failureCount: 1,
        failedAt: NOW,
        nextAttemptAt,
        failureReason: 'stale cursor',
      });
      expect(staleReject).toBe(false);

      const marked = await repositories.markSnapshotFailed({
        fence,
        cursor: 10,
        failureCount: 3,
        failedAt: NOW,
        nextAttemptAt,
        failureReason: 'boom',
      });
      expect(marked).toBe(true);

      const snapshot = await repositories.getSnapshotById(record.id);
      expect(snapshot?.status).toBe('failed');
      expect(snapshot?.failureCount).toBe(3);
      expect(snapshot?.nextAttemptAt).toBe(nextAttemptAt);
      expect(snapshot?.failureReason).toBe('boom');
    });

    it('finalization fences to a terminal partial on identity-epoch change without deleting dependencies', async () => {
      await harness.seedTask('task-blocker', DEP_CONNECTOR);
      await harness.seedTask('task-blocked', DEP_CONNECTOR);
      await harness.seedDependency(dependencyRow({ id: 'dep-keep' }));
      const record = dependencySnapshotRecord({
        id: 'gen-drift',
        cursor: 5,
        total: 5,
        identityModeRevision: 1,
      });
      await harness.seedSnapshot(record);
      // The live identity epoch drifted underneath the frozen generation.
      await harness.setIdentityEpoch(DEP_CONNECTOR, 2);

      const result = await repositories.finalizeSnapshotGeneration({
        fence: fenceOf(record),
        cursor: 5,
        total: 5,
        connectorInstanceId: DEP_CONNECTOR,
        completedAt: NOW,
        identityEvidenceEligible: true,
        identityEvidenceFailureReason: null,
        insertableEdges: [],
        removableDependencyIds: ['dep-keep'],
        retainedSnapshotIds: [record.id],
        insertChunkSize: 100,
        deleteChunkSize: 500,
      });

      expect(result.status).toBe('fenced');
      const snapshot = await repositories.getSnapshotById(record.id);
      expect(snapshot?.status).toBe('partial');
      expect(snapshot?.phase).toBe('completed');
      expect(snapshot?.identityEvidenceFailureReason).toBe(
        'dependency_identity_context_changed',
      );
      expect(snapshot?.failureReason).toContain('identity context changed');
      // Fenced finalization must never remove existing dependencies.
      expect(await repositories.getDependencyById('dep-keep')).not.toBeNull();
    });

    it('bounds retained terminal snapshot history to maxHistory', async () => {
      const current = dependencySnapshotRecord({ id: 'gen-current' });
      await harness.seedSnapshot(current);
      for (let index = 0; index < 12; index += 1) {
        await harness.seedSnapshot(dependencySnapshotRecord({
          id: `terminal-${index}`,
          status: 'completed',
          phase: 'completed',
          completedAt: `2026-09-01T10:${String(index).padStart(2, '0')}:00.000Z`,
          updatedAt: `2026-09-01T10:${String(index).padStart(2, '0')}:00.000Z`,
        }));
      }

      const retained = await repositories.getTerminalSnapshotIdsToRetain({
        connectorInstanceId: DEP_CONNECTOR,
        currentSnapshotId: 'gen-current',
        maxHistory: 10,
      });
      expect(retained).toHaveLength(10);
      expect(retained).toContain('gen-current');
    });

    it('prunes non-retained terminal snapshots on finalization', async () => {
      const current = dependencySnapshotRecord({ id: 'gen-current', cursor: 0, total: 0 });
      await harness.seedSnapshot(current);
      for (const id of ['old-0', 'old-1', 'old-2']) {
        await harness.seedSnapshot(dependencySnapshotRecord({
          id,
          status: 'completed',
          phase: 'completed',
          completedAt: NOW,
        }));
      }

      const result = await repositories.finalizeSnapshotGeneration({
        fence: fenceOf(current),
        cursor: 0,
        total: 0,
        connectorInstanceId: DEP_CONNECTOR,
        completedAt: NOW,
        identityEvidenceEligible: true,
        identityEvidenceFailureReason: null,
        insertableEdges: [],
        removableDependencyIds: [],
        retainedSnapshotIds: ['gen-current'],
        insertChunkSize: 100,
        deleteChunkSize: 500,
      });

      expect(result).toEqual({
        status: 'applied',
        imported: 0,
        removed: 0,
        prunedSnapshots: 3,
      });
      expect((await repositories.getSnapshotById('gen-current'))?.status).toBe('completed');
      expect(await repositories.getSnapshotById('old-0')).toBeNull();
      expect(await repositories.getSnapshotById('old-1')).toBeNull();
      expect(await repositories.getSnapshotById('old-2')).toBeNull();
    });

    it('writes edges idempotently across collection pages', async () => {
      const record = dependencySnapshotRecord({
        id: 'gen-collect',
        status: 'running',
        phase: 'collecting',
        readMode: null,
        total: 0,
      });
      await harness.seedSnapshot(record);
      const fence = fenceOf(record);
      const edge = {
        blockerSourceId: 'blocker-1',
        blockedSourceId: 'blocked-1',
        blockerIdentityEvidence: null,
        blockerIdentityEvidenceState: evidenceState('verified'),
      };

      const firstPage = await repositories.stageCollectionPage({
        fence,
        expectedTotal: 0,
        readMode: 'graphql-bulk',
        identityEvidenceSource: 'graphql-node',
        newItems: [{
          position: 0,
          sourceId: 'blocked-1',
          verified: true,
          identityEvidenceState: evidenceState('verified'),
        }],
        edges: [edge],
        newSourceIdCount: 1,
        overflowFetchCount: 0,
        updatedAt: NOW,
      });
      expect(firstPage).toBe(true);
      expect(await repositories.countSnapshotEdges(record.id)).toBe(1);

      // Re-observing the same edge on a later page must not duplicate it.
      const secondPage = await repositories.stageCollectionPage({
        fence,
        expectedTotal: 1,
        readMode: 'graphql-bulk',
        identityEvidenceSource: 'graphql-node',
        newItems: [],
        edges: [edge],
        newSourceIdCount: 0,
        overflowFetchCount: 0,
        updatedAt: NOW,
      });
      expect(secondPage).toBe(true);
      expect(await repositories.countSnapshotEdges(record.id)).toBe(1);
    });

    it('does not delete dependencies when a collection fails incomplete', async () => {
      await harness.seedTask('task-blocker', DEP_CONNECTOR);
      await harness.seedTask('task-blocked', DEP_CONNECTOR);
      await harness.seedDependency(dependencyRow({ id: 'dep-collect' }));
      const record = dependencySnapshotRecord({
        id: 'gen-fail-collect',
        status: 'running',
        phase: 'collecting',
        readMode: null,
        cursor: 0,
        total: 3,
      });
      await harness.seedSnapshot(record);

      const failed = await repositories.failCollection({
        fence: fenceOf(record),
        failedAt: NOW,
        failureReason: 'collection failed',
      });
      expect(failed).toBe(true);

      const snapshot = await repositories.getSnapshotById(record.id);
      expect(snapshot?.status).toBe('partial');
      expect(snapshot?.identityEvidenceFailureReason).toBe(
        'dependency_collection_incomplete',
      );
      expect(await repositories.getDependencyById('dep-collect')).not.toBeNull();
    });

    it('does not delete dependencies on a partial completion', async () => {
      await harness.seedTask('task-blocker', DEP_CONNECTOR);
      await harness.seedTask('task-blocked', DEP_CONNECTOR);
      await harness.seedDependency(dependencyRow({ id: 'dep-partial' }));
      const record = dependencySnapshotRecord({
        id: 'gen-partial',
        cursor: 5,
        total: 5,
      });
      await harness.seedSnapshot(record);

      const result = await repositories.completeSnapshotPartial({
        fence: fenceOf(record),
        cursor: 5,
        total: 5,
        connectorInstanceId: DEP_CONNECTOR,
        completedAt: NOW,
        failureReason: '2 source task(s) could not be verified; dependency removals skipped',
        identityEvidenceFailureReason: 'dependency_remote_verification_incomplete',
        retainedSnapshotIds: [record.id],
      });

      expect(result.status).toBe('applied');
      const snapshot = await repositories.getSnapshotById(record.id);
      expect(snapshot?.status).toBe('partial');
      expect(snapshot?.phase).toBe('completed');
      expect(snapshot?.identityEvidenceFailureReason).toBe(
        'dependency_remote_verification_incomplete',
      );
      expect(await repositories.getDependencyById('dep-partial')).not.toBeNull();
    });

    it('creates a generation when the identity epoch matches and rejects a drifted one', async () => {
      const matchInsert = dependencySnapshotRecord({
        id: 'gen-create-match',
        status: 'running',
        phase: 'collecting',
        readMode: null,
        total: 1,
      });
      const created = await repositories.createGeneration({
        connectorInstanceId: DEP_CONNECTOR,
        frozenModeRevision: 1,
        matchInsert,
        mismatchInsert: dependencySnapshotRecord({
          ...matchInsert,
          status: 'partial',
          phase: 'completed',
          identityEvidenceFailureReason: 'dependency_identity_context_changed',
        }),
        items: [{
          position: 0,
          sourceId: 'src-1',
          verified: false,
          identityEvidenceState: evidenceState('missing'),
        }],
        deletionCandidateIds: [],
      });
      expect(created).toBe(true);
      expect((await repositories.getSnapshotById('gen-create-match'))?.status).toBe('running');

      // Drift the epoch so the next create resolves through the mismatch insert.
      await harness.setIdentityEpoch(DEP_CONNECTOR, 5);
      const mismatchInsert = dependencySnapshotRecord({
        id: 'gen-create-mismatch',
        status: 'partial',
        phase: 'completed',
        identityEvidenceFailureReason: 'dependency_identity_context_changed',
      });
      const drifted = await repositories.createGeneration({
        connectorInstanceId: DEP_CONNECTOR,
        frozenModeRevision: 1,
        matchInsert: dependencySnapshotRecord({ id: 'gen-create-mismatch' }),
        mismatchInsert,
        items: [],
        deletionCandidateIds: [],
      });
      expect(drifted).toBe(false);
      const drift = await repositories.getSnapshotById('gen-create-mismatch');
      expect(drift?.status).toBe('partial');
      expect(drift?.identityEvidenceFailureReason).toBe(
        'dependency_identity_context_changed',
      );
    });
  });
}
