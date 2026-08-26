import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresDatabase } from './runtime';
import {
  connectorConfigs,
  dependencyReconciliationEdges,
  dependencyReconciliationSnapshots,
  syncLog,
} from './schema';
import { ensureHealthSnapshotCanRun } from '@/lib/telemetry/health-snapshot-status';
import type {
  DependencyReconciliationProgress,
} from '@/lib/sync/task-dependency-manager';

/**
 * PostgreSQL-only counterpart to the raw SQLite reads
 * `src/lib/telemetry/health-snapshot.ts` used to perform unconditionally
 * (connector configs, latest sync per connector, latest successful sync per
 * connector, and dependency-reconciliation health). Health snapshot
 * generation needs these reads to work identically under either backend, so
 * this module mirrors the exact query semantics of the SQLite path — see
 * `src/lib/sync/task-dependency-manager.ts`'s `getDependencyReconciliationHealth`/
 * `snapshotProgress` — against the PostgreSQL Drizzle schema instead. It does
 * not touch, wrap, or re-export anything from `task-dependency-manager.ts`
 * beyond its (type-only) `DependencyReconciliationProgress` shape, so the
 * SQLite-only dependency-reconciliation engine itself is untouched.
 */

type DependencySnapshotRow = typeof dependencyReconciliationSnapshots.$inferSelect;

export interface PostgresHealthSnapshotData {
  configs: (typeof connectorConfigs.$inferSelect)[];
  latestSyncPerConnector: (typeof syncLog.$inferSelect)[];
  latestSuccessfulSyncPerConnector: Array<{ connectorId: string; syncedAt: string }>;
  dependencyHealth: Map<string, DependencyReconciliationProgress>;
}

export interface CollectPostgresHealthSnapshotDataOptions {
  maxConnectors: number;
  shouldDefer?: () => boolean;
}

function snapshotProgress(
  snapshot: DependencySnapshotRow,
  lastCompleted: DependencySnapshotRow | undefined,
  edgeCounts: ReadonlyMap<string, number>,
  consecutiveFailedGenerationCount: number,
): DependencyReconciliationProgress {
  const completedAt = snapshot.completedAt ? Date.parse(snapshot.completedAt) : Number.NaN;
  const startedAt = Date.parse(snapshot.startedAt);
  return {
    generationId: snapshot.id,
    status: snapshot.status,
    phase: snapshot.phase,
    readMode: snapshot.readMode,
    processed: snapshot.cursor,
    total: snapshot.total,
    batchSize: snapshot.batchSize,
    imported: snapshot.importedCount,
    removed: snapshot.removedCount,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.completedAt,
    collectionCompletedAt: snapshot.collectionCompletedAt,
    collectionPageCount: snapshot.collectionPageCount,
    overflowFetchCount: snapshot.overflowFetchCount,
    edgeCount: edgeCounts.get(snapshot.id) ?? 0,
    identityMode: snapshot.identityMode,
    identityModeRevision: snapshot.identityModeRevision,
    identityEvidenceSource: snapshot.identityEvidenceSource,
    identityEvidenceEligible: snapshot.identityEvidenceEligible,
    identityEvidenceFailureReason: snapshot.identityEvidenceFailureReason,
    durationMs: Number.isFinite(completedAt) && Number.isFinite(startedAt)
      ? Math.max(0, completedAt - startedAt)
      : null,
    failureReason: snapshot.failureReason,
    nextAttemptAt: snapshot.nextAttemptAt,
    lastCompletedAt: lastCompleted?.completedAt ?? null,
    lastResumeAttemptAt: snapshot.lastResumeAttemptAt,
    lastResumeOutcome: snapshot.lastResumeOutcome,
    lastResumeReason: snapshot.lastResumeReason,
    collectionPhase: snapshot.phase === 'collecting'
      ? 'collecting'
      : snapshot.status === 'partial'
        ? 'partial'
        : 'complete',
    reconciliationPhase: snapshot.status === 'failed'
      ? 'failed'
      : snapshot.phase === 'ready'
        ? 'pending'
        : snapshot.phase === 'reconciling'
          ? 'reconciling'
          : 'complete',
    latestTerminalOutcome: snapshot.status === 'running' ? null : snapshot.status,
    consecutiveFailedGenerationCount,
    lastCompletedGeneration: lastCompleted?.completedAt
      ? {
          generationId: lastCompleted.id,
          readMode: lastCompleted.readMode,
          completedAt: lastCompleted.completedAt,
          collectionCompletedAt: lastCompleted.collectionCompletedAt,
          collectionPageCount: lastCompleted.collectionPageCount,
          overflowFetchCount: lastCompleted.overflowFetchCount,
          edgeCount: edgeCounts.get(lastCompleted.id) ?? 0,
          durationMs: Math.max(
            0,
            Date.parse(lastCompleted.completedAt) - Date.parse(lastCompleted.startedAt),
          ),
          identityMode: lastCompleted.identityMode,
          identityModeRevision: lastCompleted.identityModeRevision,
          identityEvidenceSource: lastCompleted.identityEvidenceSource,
          identityEvidenceEligible: lastCompleted.identityEvidenceEligible,
          identityEvidenceFailureReason: lastCompleted.identityEvidenceFailureReason,
        }
      : null,
  };
}

async function getPostgresDependencyReconciliationHealth(
  db: PostgresDatabase,
  connectorInstanceIds: string[],
  shouldDefer?: () => boolean,
): Promise<Map<string, DependencyReconciliationProgress>> {
  if (connectorInstanceIds.length === 0) return new Map();
  ensureHealthSnapshotCanRun(shouldDefer);
  const connectorFilter = inArray(
    dependencyReconciliationSnapshots.connectorInstanceId,
    connectorInstanceIds,
  );
  const [latestRows, completedRows] = await Promise.all([
    db.select().from(dependencyReconciliationSnapshots).where(and(
      connectorFilter,
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
    )),
    db.select().from(dependencyReconciliationSnapshots).where(and(
      connectorFilter,
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
    )),
  ]);
  ensureHealthSnapshotCanRun(shouldDefer);
  const relevantSnapshotIds = Array.from(new Set([
    ...latestRows.map((row) => row.id),
    ...completedRows.map((row) => row.id),
  ]));
  const [edgeCountRows, terminalRows] = await Promise.all([
    relevantSnapshotIds.length === 0
      ? Promise.resolve([])
      : db.select({
          snapshotId: dependencyReconciliationEdges.snapshotId,
          count: sql<number>`COUNT(*)`,
        }).from(dependencyReconciliationEdges)
          .where(inArray(dependencyReconciliationEdges.snapshotId, relevantSnapshotIds))
          .groupBy(dependencyReconciliationEdges.snapshotId),
    db.select({
      connectorInstanceId: dependencyReconciliationSnapshots.connectorInstanceId,
      status: dependencyReconciliationSnapshots.status,
      startedAt: dependencyReconciliationSnapshots.startedAt,
    }).from(dependencyReconciliationSnapshots).where(and(
      connectorFilter,
      inArray(dependencyReconciliationSnapshots.status, ['completed', 'partial', 'failed']),
    )).orderBy(
      dependencyReconciliationSnapshots.connectorInstanceId,
      desc(dependencyReconciliationSnapshots.startedAt),
    ),
  ]);
  ensureHealthSnapshotCanRun(shouldDefer);
  const lastCompleted = new Map(completedRows.map((row) => [row.connectorInstanceId, row]));
  const edgeCounts = new Map(edgeCountRows.map((row) => [row.snapshotId, Number(row.count)]));
  const consecutiveFailures = new Map<string, number>();
  const terminalResolved = new Set<string>();
  for (const row of terminalRows) {
    if (terminalResolved.has(row.connectorInstanceId)) continue;
    if (row.status === 'completed') {
      terminalResolved.add(row.connectorInstanceId);
      continue;
    }
    consecutiveFailures.set(
      row.connectorInstanceId,
      (consecutiveFailures.get(row.connectorInstanceId) ?? 0) + 1,
    );
  }

  return new Map(latestRows.map((snapshot) => [
    snapshot.connectorInstanceId,
    snapshotProgress(
      snapshot,
      lastCompleted.get(snapshot.connectorInstanceId),
      edgeCounts,
      consecutiveFailures.get(snapshot.connectorInstanceId) ?? 0,
    ),
  ]));
}

/**
 * Collects everything `buildMaterializedHealthSummary` needs from the
 * database, backend-selected for PostgreSQL. Mirrors the SQLite path's
 * connector-config read, per-connector latest/latest-successful sync log
 * reads, and dependency-reconciliation health computation, including the
 * same cooperative-deferral checkpoints (`ensureHealthSnapshotCanRun`)
 * between query phases so a pending sync job can still interrupt a
 * long-running snapshot generation exactly as it does under SQLite.
 */
export async function collectPostgresHealthSnapshotData(
  db: PostgresDatabase,
  options: CollectPostgresHealthSnapshotDataOptions,
): Promise<PostgresHealthSnapshotData> {
  const { maxConnectors, shouldDefer } = options;
  const configs = await db
    .select()
    .from(connectorConfigs)
    .where(isNull(connectorConfigs.deletedAt))
    .limit(maxConnectors + 1);
  if (configs.length > maxConnectors) {
    throw new Error(`Health snapshot connector limit of ${maxConnectors} exceeded`);
  }
  ensureHealthSnapshotCanRun(shouldDefer);

  const connectorIds = configs.map((config) => config.id);
  let latestSyncPerConnector: (typeof syncLog.$inferSelect)[] = [];
  let latestSuccessfulSyncPerConnector: Array<{ connectorId: string; syncedAt: string }> = [];
  let dependencyHealth = new Map<string, DependencyReconciliationProgress>();
  if (connectorIds.length > 0) {
    latestSyncPerConnector = await db
      .select()
      .from(syncLog)
      .where(and(
        inArray(syncLog.connectorId, connectorIds),
        eq(
          syncLog.id,
          sql`(SELECT id FROM sync_log AS sl WHERE sl.connector_id = ${syncLog.connectorId} ORDER BY sl.synced_at DESC LIMIT 1)`,
        ),
      ));
    ensureHealthSnapshotCanRun(shouldDefer);
    latestSuccessfulSyncPerConnector = await db
      .select({
        connectorId: syncLog.connectorId,
        syncedAt: sql<string>`max(${syncLog.syncedAt})`.as('synced_at'),
      })
      .from(syncLog)
      .where(and(
        inArray(syncLog.connectorId, connectorIds),
        eq(syncLog.success, true),
      ))
      .groupBy(syncLog.connectorId);
    ensureHealthSnapshotCanRun(shouldDefer);
    dependencyHealth = await getPostgresDependencyReconciliationHealth(
      db,
      connectorIds,
      shouldDefer,
    );
    ensureHealthSnapshotCanRun(shouldDefer);
  }

  return {
    configs,
    latestSyncPerConnector,
    latestSuccessfulSyncPerConnector,
    dependencyHealth,
  };
}
