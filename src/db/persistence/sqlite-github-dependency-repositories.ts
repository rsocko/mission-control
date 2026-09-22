import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  dependencyReconciliationCandidates,
  dependencyReconciliationEdges,
  dependencyReconciliationItems,
  dependencyReconciliationSnapshots,
  taskDependencies,
  tasks,
} from '@/db/schema';
import { getGitHubIdentityModeSnapshotInTransaction } from '@/lib/external-identities';
import type {
  ApplyReconciliationBatchInput,
  ApplyTargetedReconciliationInput,
  ApplyTargetedReconciliationResult,
  CompleteCollectionInput,
  CompleteSnapshotPartialInput,
  CompleteSnapshotPartialResult,
  CreateGenerationInput,
  DependencyRecord,
  DependencySnapshotEdgeRecord,
  DependencySnapshotFence,
  DependencySnapshotItemEvidence,
  DependencySnapshotRecord,
  DependencyTaskRow,
  FailCollectionInput,
  FinalizeSnapshotGenerationInput,
  FinalizeSnapshotGenerationResult,
  GitHubDependencyPersistence,
  MarkSnapshotFailedInput,
  RecordResumeOutcomeInput,
  StageCollectionPageInput,
  UpdateDependencySyncInput,
} from './github-dependencies';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;

/** Aborts a transaction while carrying the caller-visible result to return. */
class RollbackSignal<R> extends Error {
  constructor(readonly result: R) {
    super('github-dependency-rollback');
    this.name = 'RollbackSignal';
  }
}

/**
 * SQLite/Drizzle adapter for GitHub dependency generation, reconciliation,
 * resume, and polling. The statements here are carried verbatim from the legacy
 * `task-dependency-manager.ts` so behaviour is bit-for-bit preserved.
 */
export function createSqliteGitHubDependencyRepositories(
  _sqlite: SqliteDatabase,
  db: SqliteDrizzle,
): GitHubDependencyPersistence {
  function runTx<R>(fn: (tx: SqliteDrizzle) => R): R {
    try {
      return db.transaction(fn, { behavior: 'immediate' });
    } catch (error) {
      if (error instanceof RollbackSignal) return error.result as R;
      throw error;
    }
  }

  /**
   * The dependency snapshot write fence, carried verbatim from
   * `validateDependencySnapshotMutationInTransaction`. Re-reads the persisted
   * snapshot, the frozen identity mode/revision, and the live identity epoch;
   * writes the `dependency_identity_context_changed` partial completion when the
   * epoch drifted.
   */
  function validate(
    tx: SqliteDrizzle,
    snapshot: DependencySnapshotFence,
    options: {
      phase?: DependencySnapshotRecord['phase'];
      cursor?: number;
      now?: string;
    } = {},
  ): boolean {
    const persisted = tx.select({
      status: dependencyReconciliationSnapshots.status,
      phase: dependencyReconciliationSnapshots.phase,
      cursor: dependencyReconciliationSnapshots.cursor,
      identityMode: dependencyReconciliationSnapshots.identityMode,
      identityModeRevision: dependencyReconciliationSnapshots.identityModeRevision,
    }).from(dependencyReconciliationSnapshots)
      .where(eq(dependencyReconciliationSnapshots.id, snapshot.id))
      .limit(1)
      .get();
    if (
      !persisted
      || persisted.identityMode !== snapshot.identityMode
      || persisted.identityModeRevision !== snapshot.identityModeRevision
    ) {
      return false;
    }
    const current = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      snapshot.connectorInstanceId,
    );
    if (current.modeRevision !== snapshot.identityModeRevision) {
      const now = options.now ?? new Date().toISOString();
      tx.update(dependencyReconciliationSnapshots).set({
        status: 'partial',
        phase: 'completed',
        identityEvidenceEligible: false,
        identityEvidenceFailureReason: 'dependency_identity_context_changed',
        completedAt: now,
        failedAt: now,
        updatedAt: now,
        nextAttemptAt: null,
        failureReason:
          `identity context changed from ${snapshot.identityMode}:${snapshot.identityModeRevision}`
          + ` to ${current.effectiveMode}:${current.modeRevision}`,
      }).where(and(
        eq(dependencyReconciliationSnapshots.id, snapshot.id),
        eq(dependencyReconciliationSnapshots.identityMode, snapshot.identityMode),
        eq(
          dependencyReconciliationSnapshots.identityModeRevision,
          snapshot.identityModeRevision,
        ),
        inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
      )).run();
      return false;
    }
    return (options.phase === undefined || persisted.phase === options.phase)
      && (options.cursor === undefined || persisted.cursor === options.cursor);
  }

  function toSnapshot(row: typeof dependencyReconciliationSnapshots.$inferSelect):
    DependencySnapshotRecord {
    return row as DependencySnapshotRecord;
  }

  function edgeRecord(row: {
    blockerSourceId: string;
    blockedSourceId: string;
    blockerIdentityEvidence: DependencySnapshotEdgeRecord['blockerIdentityEvidence'];
    blockerIdentityEvidenceState: DependencySnapshotEdgeRecord['blockerIdentityEvidenceState'];
  }): DependencySnapshotEdgeRecord {
    return {
      blockerSourceId: row.blockerSourceId,
      blockedSourceId: row.blockedSourceId,
      blockerIdentityEvidence: row.blockerIdentityEvidence ?? null,
      blockerIdentityEvidenceState: row.blockerIdentityEvidenceState,
    };
  }

  function itemEvidence(row: {
    sourceId: string;
    identityEvidence: DependencySnapshotItemEvidence['identityEvidence'];
    identityEvidenceState: DependencySnapshotItemEvidence['identityEvidenceState'];
  }): DependencySnapshotItemEvidence {
    return {
      sourceId: row.sourceId,
      identityEvidence: row.identityEvidence ?? null,
      identityEvidenceState: row.identityEvidenceState,
    };
  }

  const connectorFilterExpr = (connectorInstanceIds?: readonly string[]) =>
    connectorInstanceIds
      ? inArray(
          dependencyReconciliationSnapshots.connectorInstanceId,
          [...connectorInstanceIds],
        )
      : undefined;

  return {
    async getDependencyById(id) {
      const row = db.select().from(taskDependencies)
        .where(eq(taskDependencies.id, id))
        .limit(1)
        .get();
      return (row as DependencyRecord | undefined) ?? null;
    },

    async updateDependencySync(input: UpdateDependencySyncInput) {
      const set: Record<string, unknown> = {};
      if (input.connectorInstanceId !== undefined) {
        set.connectorInstanceId = input.connectorInstanceId;
      }
      if (input.syncStatus !== undefined) set.syncStatus = input.syncStatus;
      if (input.syncAction !== undefined) set.syncAction = input.syncAction;
      if (input.syncError !== undefined) set.syncError = input.syncError;
      if (input.lastSyncedAt !== undefined) set.lastSyncedAt = input.lastSyncedAt;
      if (Object.keys(set).length === 0) return;
      db.update(taskDependencies).set(set)
        .where(eq(taskDependencies.id, input.id))
        .run();
    },

    async deleteDependencyById(id) {
      db.delete(taskDependencies).where(eq(taskDependencies.id, id)).run();
    },

    async listConnectorTasks(connectorInstanceId) {
      return db.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorInstanceId: tasks.connectorInstanceId,
        isChecklistItem: tasks.isChecklistItem,
        metadata: tasks.metadata,
      }).from(tasks)
        .where(eq(tasks.connectorInstanceId, connectorInstanceId))
        .all() as DependencyTaskRow[];
    },

    async listBlocksDependenciesForTasks(taskIds) {
      if (taskIds.length === 0) return [];
      return db.select().from(taskDependencies).where(and(
        inArray(taskDependencies.taskId, [...taskIds]),
        eq(taskDependencies.type, 'blocks'),
      )).all() as DependencyRecord[];
    },

    async getDeletionCandidateDependencyIds(connectorInstanceId) {
      const rows = db.select({ id: taskDependencies.id })
        .from(taskDependencies).where(and(
          eq(taskDependencies.connectorInstanceId, connectorInstanceId),
          eq(taskDependencies.syncStatus, 'synced'),
          isNull(taskDependencies.syncAction),
        )).all();
      return rows.map(({ id }) => id);
    },

    async getSnapshotById(id) {
      const row = db.select().from(dependencyReconciliationSnapshots)
        .where(eq(dependencyReconciliationSnapshots.id, id))
        .limit(1)
        .get();
      return row ? toSnapshot(row) : null;
    },

    async loadActiveSnapshot(connectorInstanceId) {
      const row = db.select().from(dependencyReconciliationSnapshots)
        .where(and(
          eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
          inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
        ))
        .orderBy(desc(dependencyReconciliationSnapshots.startedAt))
        .limit(1)
        .get();
      return row ? toSnapshot(row) : null;
    },

    async getLastCompletedSnapshot(connectorInstanceId) {
      const row = db.select().from(dependencyReconciliationSnapshots).where(and(
        eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
        eq(dependencyReconciliationSnapshots.status, 'completed'),
      )).orderBy(desc(dependencyReconciliationSnapshots.completedAt)).limit(1).get();
      return row ? toSnapshot(row) : null;
    },

    async getTerminalSnapshotIdsToRetain({
      connectorInstanceId,
      currentSnapshotId,
      maxHistory,
    }) {
      const recentSnapshots = db.select({
        id: dependencyReconciliationSnapshots.id,
      }).from(dependencyReconciliationSnapshots).where(and(
        eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
        inArray(dependencyReconciliationSnapshots.status, ['completed', 'partial']),
        ne(dependencyReconciliationSnapshots.id, currentSnapshotId),
      )).orderBy(
        desc(dependencyReconciliationSnapshots.updatedAt),
        desc(dependencyReconciliationSnapshots.id),
      ).limit(maxHistory - 1).all();
      const lastCompletedSnapshots = db.select({
        id: dependencyReconciliationSnapshots.id,
      }).from(dependencyReconciliationSnapshots).where(and(
        eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
        eq(dependencyReconciliationSnapshots.status, 'completed'),
        ne(dependencyReconciliationSnapshots.id, currentSnapshotId),
      )).orderBy(
        desc(dependencyReconciliationSnapshots.completedAt),
        desc(dependencyReconciliationSnapshots.id),
      ).limit(1).all();
      const retainedIds = new Set([
        currentSnapshotId,
        ...lastCompletedSnapshots.map(({ id }) => id),
      ]);
      for (const { id } of recentSnapshots) {
        if (retainedIds.size >= maxHistory) break;
        retainedIds.add(id);
      }
      return [...retainedIds];
    },

    async getHealthLatestSnapshots(connectorInstanceIds) {
      const rows = db.select().from(dependencyReconciliationSnapshots).where(and(
        connectorFilterExpr(connectorInstanceIds),
        eq(
          dependencyReconciliationSnapshots.id,
          sql`(
            SELECT latest.id
            FROM dependency_reconciliation_snapshots AS latest
            WHERE latest.connector_instance_id =
              ${dependencyReconciliationSnapshots.connectorInstanceId}
            ORDER BY latest.started_at DESC
            LIMIT 1
          )`,
        ),
      )).all();
      return rows.map(toSnapshot);
    },

    async getHealthCompletedSnapshots(connectorInstanceIds) {
      const rows = db.select().from(dependencyReconciliationSnapshots).where(and(
        connectorFilterExpr(connectorInstanceIds),
        eq(
          dependencyReconciliationSnapshots.id,
          sql`(
            SELECT completed.id
            FROM dependency_reconciliation_snapshots AS completed
            WHERE completed.connector_instance_id =
              ${dependencyReconciliationSnapshots.connectorInstanceId}
              AND completed.status = 'completed'
            ORDER BY completed.completed_at DESC
            LIMIT 1
          )`,
        ),
      )).all();
      return rows.map(toSnapshot);
    },

    async countEdgesBySnapshotIds(snapshotIds) {
      if (snapshotIds.length === 0) return [];
      const rows = db.select({
        snapshotId: dependencyReconciliationEdges.snapshotId,
        count: sql<number>`COUNT(*)`,
      }).from(dependencyReconciliationEdges)
        .where(inArray(dependencyReconciliationEdges.snapshotId, [...snapshotIds]))
        .groupBy(dependencyReconciliationEdges.snapshotId)
        .all();
      return rows.map((row) => ({ snapshotId: row.snapshotId, count: Number(row.count) }));
    },

    async getHealthTerminalStatuses(connectorInstanceIds) {
      return db.select({
        connectorInstanceId: dependencyReconciliationSnapshots.connectorInstanceId,
        status: dependencyReconciliationSnapshots.status,
        startedAt: dependencyReconciliationSnapshots.startedAt,
      }).from(dependencyReconciliationSnapshots).where(and(
        connectorFilterExpr(connectorInstanceIds),
        inArray(
          dependencyReconciliationSnapshots.status,
          ['completed', 'partial', 'failed'],
        ),
      )).orderBy(
        dependencyReconciliationSnapshots.connectorInstanceId,
        desc(dependencyReconciliationSnapshots.startedAt),
      ).all();
    },

    async countSnapshotEdges(snapshotId) {
      const row = db.select({
        count: sql<number>`COUNT(*)`,
      }).from(dependencyReconciliationEdges).where(
        eq(dependencyReconciliationEdges.snapshotId, snapshotId),
      ).get();
      return Number(row?.count ?? 0);
    },

    async getSnapshotStatus(snapshotId) {
      const row = db.select({
        status: dependencyReconciliationSnapshots.status,
      }).from(dependencyReconciliationSnapshots)
        .where(eq(dependencyReconciliationSnapshots.id, snapshotId))
        .limit(1)
        .get();
      return row?.status ?? null;
    },

    async listGenerationEdgePage({ snapshotId, offset, limit }) {
      return db.select({
        blockerSourceId: dependencyReconciliationEdges.blockerSourceId,
        blockedSourceId: dependencyReconciliationEdges.blockedSourceId,
      }).from(dependencyReconciliationEdges)
        .where(eq(dependencyReconciliationEdges.snapshotId, snapshotId))
        .orderBy(
          asc(dependencyReconciliationEdges.blockedSourceId),
          asc(dependencyReconciliationEdges.blockerSourceId),
        )
        .limit(limit)
        .offset(offset)
        .all();
    },

    async getResumableReconciliations() {
      const rows = db.select({
        connectorId: dependencyReconciliationSnapshots.connectorInstanceId,
        generationId: dependencyReconciliationSnapshots.id,
        status: dependencyReconciliationSnapshots.status,
        processed: dependencyReconciliationSnapshots.cursor,
        total: dependencyReconciliationSnapshots.total,
        nextAttemptAt: dependencyReconciliationSnapshots.nextAttemptAt,
      }).from(dependencyReconciliationSnapshots)
        .innerJoin(
          connectorConfigs,
          eq(connectorConfigs.id, dependencyReconciliationSnapshots.connectorInstanceId),
        )
        .where(and(
          inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
          ne(dependencyReconciliationSnapshots.phase, 'collecting'),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        )).all();
      return rows.map((row) => ({
        connectorId: row.connectorId,
        generationId: row.generationId,
        status: row.status as 'running' | 'failed',
        processed: row.processed,
        total: row.total,
        nextAttemptAt: row.nextAttemptAt,
      }));
    },

    async listSnapshotItemsForSourceIds({ snapshotId, sourceIds }) {
      if (sourceIds.length === 0) return [];
      const rows = db.select({
        sourceId: dependencyReconciliationItems.sourceId,
        identityEvidence: dependencyReconciliationItems.identityEvidence,
        identityEvidenceState: dependencyReconciliationItems.identityEvidenceState,
      }).from(dependencyReconciliationItems).where(and(
        eq(dependencyReconciliationItems.snapshotId, snapshotId),
        inArray(dependencyReconciliationItems.sourceId, [...sourceIds]),
      )).all();
      return rows.map(itemEvidence);
    },

    async listVerifiedSnapshotItems(snapshotId) {
      const rows = db.select({
        sourceId: dependencyReconciliationItems.sourceId,
        identityEvidence: dependencyReconciliationItems.identityEvidence,
        identityEvidenceState: dependencyReconciliationItems.identityEvidenceState,
      }).from(dependencyReconciliationItems).where(and(
        eq(dependencyReconciliationItems.snapshotId, snapshotId),
        eq(dependencyReconciliationItems.verified, true),
      )).all();
      return rows.map(itemEvidence);
    },

    async listVerifiedItemsForSourceIds({ snapshotId, sourceIds }) {
      if (sourceIds.length === 0) return [];
      const rows = db.select({
        sourceId: dependencyReconciliationItems.sourceId,
        identityEvidence: dependencyReconciliationItems.identityEvidence,
        identityEvidenceState: dependencyReconciliationItems.identityEvidenceState,
      }).from(dependencyReconciliationItems).where(and(
        eq(dependencyReconciliationItems.snapshotId, snapshotId),
        inArray(dependencyReconciliationItems.sourceId, [...sourceIds]),
        eq(dependencyReconciliationItems.verified, true),
      )).all();
      return rows.map(itemEvidence);
    },

    async listSnapshotItemsInWindow({ snapshotId, start, end }) {
      return db.select({
        position: dependencyReconciliationItems.position,
        sourceId: dependencyReconciliationItems.sourceId,
      }).from(dependencyReconciliationItems).where(and(
        eq(dependencyReconciliationItems.snapshotId, snapshotId),
        gte(dependencyReconciliationItems.position, start),
        lt(dependencyReconciliationItems.position, end),
      )).orderBy(asc(dependencyReconciliationItems.position)).all();
    },

    async listSnapshotEdges(snapshotId) {
      const rows = db.select().from(dependencyReconciliationEdges).where(
        eq(dependencyReconciliationEdges.snapshotId, snapshotId),
      ).all();
      return rows.map(edgeRecord);
    },

    async listStagedEdgesForSourceIds({ snapshotId, blockedSourceIds }) {
      if (blockedSourceIds.length === 0) return [];
      const rows = db.select({
        blockerSourceId: dependencyReconciliationEdges.blockerSourceId,
        blockedSourceId: dependencyReconciliationEdges.blockedSourceId,
        blockerIdentityEvidence: dependencyReconciliationEdges.blockerIdentityEvidence,
        blockerIdentityEvidenceState:
          dependencyReconciliationEdges.blockerIdentityEvidenceState,
      }).from(dependencyReconciliationEdges).where(and(
        eq(dependencyReconciliationEdges.snapshotId, snapshotId),
        inArray(dependencyReconciliationEdges.blockedSourceId, [...blockedSourceIds]),
      )).all();
      return rows.map(edgeRecord);
    },

    async listSnapshotCandidateDependencyIds(snapshotId) {
      const rows = db.select({
        dependencyId: dependencyReconciliationCandidates.dependencyId,
      }).from(dependencyReconciliationCandidates)
        .where(eq(dependencyReconciliationCandidates.snapshotId, snapshotId))
        .all();
      return rows.map(({ dependencyId }) => dependencyId);
    },

    async createGeneration(input: CreateGenerationInput) {
      return runTx((tx) => {
        const current = getGitHubIdentityModeSnapshotInTransaction(
          tx,
          input.connectorInstanceId,
        );
        const contextMatches = current.modeRevision === input.frozenModeRevision;
        tx.insert(dependencyReconciliationSnapshots)
          .values(contextMatches ? input.matchInsert : input.mismatchInsert)
          .run();
        if (contextMatches && input.items && input.items.length > 0) {
          tx.insert(dependencyReconciliationItems).values(
            input.items.map((item) => ({
              snapshotId: input.matchInsert.id,
              position: item.position,
              sourceId: item.sourceId,
              verified: item.verified,
              identityEvidence: item.identityEvidence,
              identityEvidenceState: item.identityEvidenceState,
            })),
          ).run();
        }
        if (contextMatches && input.deletionCandidateIds.length > 0) {
          tx.insert(dependencyReconciliationCandidates).values(
            input.deletionCandidateIds.map((dependencyId) => ({
              snapshotId: input.matchInsert.id,
              dependencyId,
            })),
          ).run();
        }
        return contextMatches;
      });
    },

    async abandonInterruptedCollection({ fence, failedAt }) {
      return runTx((tx) => {
        if (!validate(tx, fence, { phase: 'collecting', now: failedAt })) return false;
        tx.update(dependencyReconciliationSnapshots).set({
          status: 'partial',
          phase: 'completed',
          identityEvidenceEligible: false,
          identityEvidenceFailureReason: 'dependency_collection_incomplete',
          completedAt: failedAt,
          failedAt,
          updatedAt: failedAt,
          failureReason: 'dependency collection was interrupted before completion',
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          eq(dependencyReconciliationSnapshots.phase, 'collecting'),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run();
        return true;
      });
    },

    async stageCollectionPage(input: StageCollectionPageInput) {
      const { fence } = input;
      return runTx((tx) => {
        // A fence failure must COMMIT the identity-context-changed partial write
        // that `validate` performed (legacy `return false` semantics), not roll
        // it back — so return false instead of throwing a RollbackSignal.
        if (!validate(tx, fence, { phase: 'collecting', now: input.updatedAt })) {
          return false;
        }
        const persisted = tx.select({ total: dependencyReconciliationSnapshots.total })
          .from(dependencyReconciliationSnapshots)
          .where(eq(dependencyReconciliationSnapshots.id, fence.id))
          .limit(1)
          .get();
        if (!persisted || persisted.total !== input.expectedTotal) {
          return false;
        }
        if (input.newItems.length > 0) {
          tx.insert(dependencyReconciliationItems).values(
            input.newItems.map((item) => ({
              snapshotId: fence.id,
              position: item.position,
              sourceId: item.sourceId,
              verified: item.verified,
              identityEvidence: item.identityEvidence,
              identityEvidenceState: item.identityEvidenceState,
            })),
          ).run();
        }
        if (input.edges.length > 0) {
          tx.insert(dependencyReconciliationEdges).values(
            input.edges.map((edge) => ({
              snapshotId: fence.id,
              blockerSourceId: edge.blockerSourceId,
              blockedSourceId: edge.blockedSourceId,
              blockerIdentityEvidence: edge.blockerIdentityEvidence,
              blockerIdentityEvidenceState: edge.blockerIdentityEvidenceState,
            })),
          ).onConflictDoNothing().run();
        }
        const advanced = tx.update(dependencyReconciliationSnapshots).set({
          readMode: input.readMode,
          identityEvidenceSource: input.identityEvidenceSource,
          identityEvidenceEligible: false,
          identityEvidenceFailureReason: null,
          total: input.expectedTotal + input.newSourceIdCount,
          collectionPageCount: sql`${dependencyReconciliationSnapshots.collectionPageCount} + 1`,
          overflowFetchCount: sql`${dependencyReconciliationSnapshots.overflowFetchCount} + ${input.overflowFetchCount}`,
          updatedAt: input.updatedAt,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          eq(dependencyReconciliationSnapshots.phase, 'collecting'),
          eq(dependencyReconciliationSnapshots.total, input.expectedTotal),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run();
        if (advanced.changes !== 1) {
          throw new Error('Dependency collection page CAS failed');
        }
        return true;
      });
    },

    async completeCollection(input: CompleteCollectionInput) {
      const { fence } = input;
      return runTx((tx) => {
        if (!validate(tx, fence, { phase: 'collecting', now: input.completedAt })) {
          return false;
        }
        const blockedEvidenceCounts = tx.select({
          incomplete: sql<number>`SUM(CASE WHEN ${dependencyReconciliationItems.identityEvidenceState} != 'verified' THEN 1 ELSE 0 END)`,
        }).from(dependencyReconciliationItems).where(
          eq(dependencyReconciliationItems.snapshotId, fence.id),
        ).get();
        const blockerEvidenceCounts = tx.select({
          incomplete: sql<number>`SUM(CASE WHEN ${dependencyReconciliationEdges.blockerIdentityEvidenceState} != 'verified' THEN 1 ELSE 0 END)`,
        }).from(dependencyReconciliationEdges).where(
          eq(dependencyReconciliationEdges.snapshotId, fence.id),
        ).get();
        const incompleteEvidence = Number(blockedEvidenceCounts?.incomplete ?? 0)
          + Number(blockerEvidenceCounts?.incomplete ?? 0);
        const evidence = input.deriveEvidence(incompleteEvidence);
        const changed = tx.update(dependencyReconciliationSnapshots).set({
          phase: 'ready',
          readMode: input.readMode,
          identityEvidenceSource: input.identityEvidenceSource,
          identityEvidenceEligible: evidence.identityEvidenceEligible,
          identityEvidenceFailureReason: evidence.identityEvidenceFailureReason,
          collectionCompletedAt: input.completedAt,
          updatedAt: input.completedAt,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          eq(dependencyReconciliationSnapshots.phase, 'collecting'),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run();
        return changed.changes === 1;
      });
    },

    async failCollection(input: FailCollectionInput) {
      const { fence } = input;
      return runTx((tx) => {
        if (!validate(tx, fence, { phase: 'collecting', now: input.failedAt })) {
          return false;
        }
        const result = tx.update(dependencyReconciliationSnapshots).set({
          status: 'partial',
          identityEvidenceEligible: false,
          identityEvidenceFailureReason: 'dependency_collection_incomplete',
          failedAt: input.failedAt,
          updatedAt: input.failedAt,
          failureReason: input.failureReason,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          eq(dependencyReconciliationSnapshots.status, 'running'),
          eq(dependencyReconciliationSnapshots.phase, 'collecting'),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run();
        return result.changes > 0;
      });
    },

    async recordResumeOutcome(input: RecordResumeOutcomeInput) {
      runTx((tx) => {
        const snapshot = tx.select().from(dependencyReconciliationSnapshots)
          .where(eq(dependencyReconciliationSnapshots.id, input.generationId))
          .limit(1)
          .get();
        if (!snapshot || !validate(tx, snapshot, { now: input.attemptedAt })) return;
        tx.update(dependencyReconciliationSnapshots).set({
          lastResumeAttemptAt: input.attemptedAt,
          lastResumeOutcome: input.outcome,
          lastResumeReason: input.reason.slice(0, 120),
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, input.generationId),
          eq(dependencyReconciliationSnapshots.identityMode, snapshot.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            snapshot.identityModeRevision,
          ),
        )).run();
      });
    },

    async applyTargetedReconciliation(
      input: ApplyTargetedReconciliationInput,
    ): Promise<ApplyTargetedReconciliationResult> {
      return runTx<ApplyTargetedReconciliationResult>((tx) => {
        const current = getGitHubIdentityModeSnapshotInTransaction(
          tx,
          input.connectorInstanceId,
        );
        if (current.modeRevision !== input.expectedModeRevision) {
          throw new RollbackSignal<ApplyTargetedReconciliationResult>({
            status: 'identity-context-changed',
          });
        }
        for (const id of input.syncedUpdateIds) {
          tx.update(taskDependencies).set({
            connectorInstanceId: input.connectorInstanceId,
            syncStatus: 'synced',
            syncError: null,
            lastSyncedAt: input.syncedAt,
          }).where(and(
            eq(taskDependencies.id, id),
            isNull(taskDependencies.syncAction),
          )).run();
        }
        let imported = 0;
        for (const insert of input.inserts) {
          imported += tx.insert(taskDependencies).values(insert)
            .onConflictDoNothing().run().changes;
        }
        let removed = 0;
        for (const id of input.deletionIds) {
          removed += tx.delete(taskDependencies).where(and(
            eq(taskDependencies.id, id),
            eq(taskDependencies.connectorInstanceId, input.connectorInstanceId),
            eq(taskDependencies.syncStatus, 'synced'),
            isNull(taskDependencies.syncAction),
          )).run().changes;
        }
        return { status: 'applied', imported, removed };
      });
    },

    async applyReconciliationBatch(input: ApplyReconciliationBatchInput) {
      const { fence } = input;
      return runTx((tx) => {
        if (!validate(tx, fence, { cursor: input.batchStart, now: input.lastSyncedAt })) {
          return false;
        }
        if (input.stagedEdges.length > 0) {
          tx.insert(dependencyReconciliationEdges).values(
            input.stagedEdges.map((edge) => ({
              snapshotId: fence.id,
              blockerSourceId: edge.blockerSourceId,
              blockedSourceId: edge.blockedSourceId,
              blockerIdentityEvidence: edge.blockerIdentityEvidence,
              blockerIdentityEvidenceState: edge.blockerIdentityEvidenceState,
            })),
          ).onConflictDoNothing().run();
        }
        for (const update of input.verifiedUpdates) {
          tx.update(dependencyReconciliationItems).set({
            verified: true,
            ...(update.identityEvidenceState !== undefined
              ? {
                  identityEvidence: update.identityEvidence,
                  identityEvidenceState: update.identityEvidenceState,
                }
              : {}),
          }).where(and(
            eq(dependencyReconciliationItems.snapshotId, fence.id),
            eq(dependencyReconciliationItems.sourceId, update.sourceId),
          )).run();
        }
        const advanced = tx.update(dependencyReconciliationSnapshots).set({
          status: 'running',
          phase: 'reconciling',
          cursor: input.batchEnd,
          failureCount: 0,
          failedAt: null,
          nextAttemptAt: null,
          failureReason: null,
          importedCount: sql`${dependencyReconciliationSnapshots.importedCount} + 0`,
          updatedAt: input.lastSyncedAt,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          eq(dependencyReconciliationSnapshots.cursor, input.batchStart),
          inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run();
        if (advanced.changes !== 1) {
          throw new Error('Dependency snapshot cursor CAS failed');
        }
        return true;
      });
    },

    async markSnapshotFailed(input: MarkSnapshotFailedInput) {
      const { fence } = input;
      return runTx((tx) => {
        if (!validate(tx, fence, { cursor: input.cursor, now: input.failedAt })) {
          return false;
        }
        return tx.update(dependencyReconciliationSnapshots).set({
          status: 'failed',
          failureCount: input.failureCount,
          failedAt: input.failedAt,
          updatedAt: input.failedAt,
          nextAttemptAt: input.nextAttemptAt,
          failureReason: input.failureReason,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          eq(dependencyReconciliationSnapshots.cursor, input.cursor),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run().changes === 1;
      });
    },

    async abandonSnapshotForIdentityContextChange(fence, now) {
      runTx((tx) => {
        validate(tx, fence, { now });
      });
    },

    async completeSnapshotPartial(
      input: CompleteSnapshotPartialInput,
    ): Promise<CompleteSnapshotPartialResult> {
      const { fence } = input;
      return runTx<CompleteSnapshotPartialResult>((tx) => {
        // Fence failure commits the identity-context-changed partial write.
        if (!validate(tx, fence, { cursor: input.cursor, now: input.completedAt })) {
          return { status: 'fenced' };
        }
        const changed = tx.update(dependencyReconciliationSnapshots).set({
          status: 'partial',
          phase: 'completed',
          updatedAt: input.completedAt,
          failedAt: input.completedAt,
          nextAttemptAt: null,
          failureReason: input.failureReason,
          identityEvidenceEligible: false,
          identityEvidenceFailureReason: input.identityEvidenceFailureReason,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
          gte(dependencyReconciliationSnapshots.cursor, input.total),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run();
        if (changed.changes !== 1) {
          throw new Error('Dependency partial completion CAS failed');
        }
        const prunedSnapshots = tx.delete(dependencyReconciliationSnapshots).where(and(
          eq(dependencyReconciliationSnapshots.connectorInstanceId, input.connectorInstanceId),
          inArray(dependencyReconciliationSnapshots.status, ['completed', 'partial']),
          notInArray(dependencyReconciliationSnapshots.id, [...input.retainedSnapshotIds]),
        )).run().changes;
        return { status: 'applied', prunedSnapshots };
      });
    },

    async finalizeSnapshotGeneration(
      input: FinalizeSnapshotGenerationInput,
    ): Promise<FinalizeSnapshotGenerationResult> {
      const { fence } = input;
      return runTx<FinalizeSnapshotGenerationResult>((tx) => {
        // Fence failure commits the identity-context-changed partial write.
        if (!validate(tx, fence, { cursor: input.cursor, now: input.completedAt })) {
          return { status: 'fenced' };
        }
        let imported = 0;
        for (
          let index = 0;
          index < input.insertableEdges.length;
          index += input.insertChunkSize
        ) {
          imported += tx.insert(taskDependencies).values(
            input.insertableEdges.slice(index, index + input.insertChunkSize) as
              typeof taskDependencies.$inferInsert[],
          ).onConflictDoNothing().run().changes;
        }
        let removed = 0;
        for (
          let index = 0;
          index < input.removableDependencyIds.length;
          index += input.deleteChunkSize
        ) {
          removed += tx.delete(taskDependencies).where(and(
            inArray(
              taskDependencies.id,
              input.removableDependencyIds.slice(index, index + input.deleteChunkSize),
            ),
            eq(taskDependencies.connectorInstanceId, input.connectorInstanceId),
            eq(taskDependencies.syncStatus, 'synced'),
            isNull(taskDependencies.syncAction),
          )).run().changes;
        }
        const completed = tx.update(dependencyReconciliationSnapshots).set({
          status: 'completed',
          phase: 'completed',
          identityEvidenceEligible: input.identityEvidenceEligible,
          identityEvidenceFailureReason: input.identityEvidenceFailureReason,
          importedCount: sql`${dependencyReconciliationSnapshots.importedCount} + ${imported}`,
          removedCount: sql`${dependencyReconciliationSnapshots.removedCount} + ${removed}`,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
          failedAt: null,
          nextAttemptAt: null,
          failureReason: null,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, fence.id),
          inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
          gte(dependencyReconciliationSnapshots.cursor, input.total),
          eq(dependencyReconciliationSnapshots.identityMode, fence.identityMode),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            fence.identityModeRevision,
          ),
        )).run();
        if (completed.changes !== 1) {
          throw new Error('Dependency finalization CAS failed');
        }
        const prunedSnapshots = tx.delete(dependencyReconciliationSnapshots).where(and(
          eq(dependencyReconciliationSnapshots.connectorInstanceId, input.connectorInstanceId),
          inArray(dependencyReconciliationSnapshots.status, ['completed', 'partial']),
          notInArray(dependencyReconciliationSnapshots.id, [...input.retainedSnapshotIds]),
        )).run().changes;
        return { status: 'applied', imported, removed, prunedSnapshots };
      });
    },
  };
}
