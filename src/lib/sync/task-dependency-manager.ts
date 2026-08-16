import 'server-only';

import { randomUUID } from 'crypto';
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
import db, { runTransaction } from '@/db';
import {
  dependencyReconciliationEdges,
  dependencyReconciliationItems,
  dependencyReconciliationSnapshots,
  dependencyReconciliationCandidates,
  connectorConfigs,
  taskDependencies,
  tasks,
} from '@/db/schema';
import type { IConnector } from '@/lib/connectors';
import { getConnectorCapabilities } from '@/lib/connectors/capabilities';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import {
  getGitHubIdentityModeSnapshot,
  getGitHubIdentityModeSnapshotInTransaction,
  GitHubIdentityComparisonRuntime,
} from '@/lib/external-identities';
import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityResolutionDecision,
  ExternalIdentityTransaction,
} from '@/lib/external-identities';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import { syncLogger } from '@/lib/logger';
import { executeFencedGitHubTaskMutation } from '@/lib/external-identities';
import { isConnectorNativeTask } from './github-native-task';
import type {
  SourceTaskDependencyGenerationWriter,
  SourceTaskDependencyReadMode,
  SourceTaskDependencySnapshot,
} from '@/types';
import { fetchDependencySnapshot } from './dependency-snapshot';

interface DependencyTask {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  isChecklistItem: boolean;
  metadata: unknown;
}

interface DependencyRecord {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  type: 'blocks' | 'related';
  connectorInstanceId: string | null;
  syncStatus: 'local' | 'pending' | 'synced' | 'failed';
  syncAction: 'create' | 'delete' | null;
  syncError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

function isNativeDependencyTask(
  task: DependencyTask,
  connectorType: string,
): boolean {
  return isConnectorNativeTask(task, connectorType, task.connectorInstanceId);
}

async function writeDependency(
  connector: IConnector,
  blocker: DependencyTask,
  blocked: DependencyTask,
  action: 'create' | 'delete',
): Promise<void> {
  const write = action === 'create'
    ? () => connector.addTaskDependency!(blocker.sourceId, blocked.sourceId)
    : () => connector.removeTaskDependency!(blocker.sourceId, blocked.sourceId);
  await executeFencedGitHubTaskMutation({
    connectorInstanceId: blocked.connectorInstanceId,
    taskId: blocked.id,
    operation: 'dependency',
    connector,
    participantTaskIds: [{
      role: 'blocker_issue',
      taskId: blocker.id,
    }],
    write,
  });
}

export interface DependencyReconciliationResult {
  imported: number;
  removed: number;
  pushed: number;
  failed: number;
  snapshot?: DependencyReconciliationProgress;
  resumeSkippedReason?: 'snapshot-no-longer-active' | 'identity-context-changed';
}

export interface DependencyReconciliationProgress {
  generationId: string;
  status: 'running' | 'failed' | 'partial' | 'completed';
  phase: 'collecting' | 'ready' | 'reconciling' | 'completed';
  readMode: 'graphql-bulk' | 'rest-fallback' | 'legacy' | null;
  processed: number;
  total: number;
  batchSize: number;
  imported: number;
  removed: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  collectionCompletedAt: string | null;
  collectionPageCount: number;
  overflowFetchCount: number;
  edgeCount: number;
  identityMode: 'legacy' | 'comparison' | 'stable';
  identityModeRevision: number;
  identityEvidenceSource: 'graphql-node' | 'rest-unavailable' | 'legacy-unavailable';
  identityEvidenceEligible: boolean;
  identityComparisonRunId: string | null;
  identityEvidenceFailureReason: string | null;
  durationMs: number | null;
  failureReason: string | null;
  nextAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastResumeAttemptAt: string | null;
  lastResumeOutcome: 'advanced' | 'deferred' | 'failed' | null;
  lastResumeReason: string | null;
  collectionPhase: 'collecting' | 'complete' | 'partial';
  reconciliationPhase: 'pending' | 'reconciling' | 'complete' | 'failed';
  latestTerminalOutcome: 'completed' | 'partial' | 'failed' | null;
  consecutiveFailedGenerationCount: number;
  lastCompletedGeneration: DependencyGenerationSummary | null;
}

export interface DependencyGenerationSummary {
  generationId: string;
  readMode: 'graphql-bulk' | 'rest-fallback' | 'legacy' | null;
  completedAt: string;
  collectionCompletedAt: string | null;
  collectionPageCount: number;
  overflowFetchCount: number;
  edgeCount: number;
  durationMs: number;
  identityMode: 'legacy' | 'comparison' | 'stable';
  identityModeRevision: number;
  identityEvidenceSource: 'graphql-node' | 'rest-unavailable' | 'legacy-unavailable';
  identityEvidenceEligible: boolean;
  identityComparisonRunId: string | null;
  identityEvidenceFailureReason: string | null;
}

export interface TargetedDependencyCollection {
  writer: SourceTaskDependencyGenerationWriter;
  result(): {
    snapshot: SourceTaskDependencySnapshot;
    readMode: SourceTaskDependencyReadMode;
  };
}

export interface DependencyReconciliationResumeCandidate {
  connectorId: string;
  generationId: string;
  status: 'running' | 'failed';
  processed: number;
  total: number;
  nextAttemptAt: string | null;
}

type DependencySnapshot = typeof dependencyReconciliationSnapshots.$inferSelect;
type ReconcileOptions = {
  full?: boolean;
  resumeGenerationId?: string;
  skipPendingRetry?: boolean;
  identityComparison?: GitHubIdentityComparisonRuntime;
};

const DEFAULT_DEPENDENCY_BATCH_SIZE = 25;
// Bound the statements issued while the finalization transaction owns the
// writer lock so large snapshots cannot exhaust other processes' busy timeout.
const DEPENDENCY_FINALIZE_INSERT_CHUNK_SIZE = 100;
const DEPENDENCY_FINALIZE_DELETE_CHUNK_SIZE = 500;
const DEFAULT_STREAMED_DEPENDENCY_BATCH_SIZE = 500;
const DEFAULT_RETRY_BASE_MS = 15 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_TERMINAL_SNAPSHOT_HISTORY = 10;

const connectorLocks = new Map<string, Promise<void>>();

function dependencyIdentityEvidenceSource(
  mode: SourceTaskDependencyReadMode,
): 'graphql-node' | 'rest-unavailable' {
  return mode === 'graphql-bulk' ? 'graphql-node' : 'rest-unavailable';
}

function dependencyIdentityContextMatches(
  frozen: Pick<DependencySnapshot, 'identityMode' | 'identityModeRevision'>,
  current: GitHubIdentityModeSnapshot,
): boolean {
  return current.effectiveMode === frozen.identityMode
    && current.modeRevision === frozen.identityModeRevision
    && current.stablePrimaryEnabled === (frozen.identityMode === 'stable');
}

function validateDependencySnapshotMutationInTransaction(
    tx: ExternalIdentityTransaction,
    snapshot: Pick<
      DependencySnapshot,
      'id' | 'connectorInstanceId' | 'identityMode' | 'identityModeRevision'
    >,
    options: {
      phase?: DependencySnapshot['phase'];
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
    if (!dependencyIdentityContextMatches(snapshot, current)) {
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
        eq(
          dependencyReconciliationSnapshots.identityMode,
          snapshot.identityMode,
        ),
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

async function withConnectorDependencyLock<T>(
  connectorInstanceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = connectorLocks.get(connectorInstanceId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  connectorLocks.set(connectorInstanceId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (connectorLocks.get(connectorInstanceId) === queued) {
      connectorLocks.delete(connectorInstanceId);
    }
  }
}

function canUseNativeDependency(
  blocker: DependencyTask,
  blocked: DependencyTask,
): boolean {
  return blocker.connectorInstanceId !== 'local'
    && blocker.connectorInstanceId === blocked.connectorInstanceId
    && !blocker.isChecklistItem
    && !blocked.isChecklistItem;
}

function dependencyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markDependencyFailed(id: string, action: 'create' | 'delete', error: unknown) {
  await db.update(taskDependencies).set({
    syncStatus: 'failed',
    syncAction: action,
    syncError: dependencyError(error),
  }).where(eq(taskDependencies.id, id));
}

export async function synchronizeCreatedTaskDependency(
  dependency: DependencyRecord,
  blocker: DependencyTask,
  blocked: DependencyTask,
): Promise<DependencyRecord> {
  if (dependency.type !== 'blocks' || !canUseNativeDependency(blocker, blocked)) {
    return dependency;
  }
  return withConnectorDependencyLock(blocker.connectorInstanceId, () =>
    synchronizeCreatedTaskDependencyUnlocked(dependency, blocker, blocked));
}

async function synchronizeCreatedTaskDependencyUnlocked(
  dependency: DependencyRecord,
  blocker: DependencyTask,
  blocked: DependencyTask,
): Promise<DependencyRecord> {
  const [currentDependency] = await db.select().from(taskDependencies).where(
    eq(taskDependencies.id, dependency.id),
  ) as DependencyRecord[];
  if (!currentDependency) return dependency;

  let connector: IConnector | null;
  try {
    const capabilities = await getConnectorCapabilities(blocker.connectorInstanceId);
    if (!capabilities?.dependencyWrite) return dependency;
    connector = await getOrInitializeConnector(blocker.connectorInstanceId);
    if (!connector?.addTaskDependency) return dependency;
  } catch (error) {
    await db.update(taskDependencies).set({
      connectorInstanceId: blocker.connectorInstanceId,
      syncStatus: 'failed',
      syncAction: 'create',
      syncError: dependencyError(error),
    }).where(eq(taskDependencies.id, dependency.id));
    return {
      ...dependency,
      connectorInstanceId: blocker.connectorInstanceId,
      syncStatus: 'failed',
      syncAction: 'create',
      syncError: dependencyError(error),
    };
  }

  await db.update(taskDependencies).set({
    connectorInstanceId: blocker.connectorInstanceId,
    syncStatus: 'pending',
    syncAction: 'create',
    syncError: null,
  }).where(eq(taskDependencies.id, dependency.id));

  try {
    await writeDependency(connector, blocker, blocked, 'create');
    const lastSyncedAt = new Date().toISOString();
    const synced = {
      ...dependency,
      connectorInstanceId: blocker.connectorInstanceId,
      syncStatus: 'synced' as const,
      syncAction: null,
      syncError: null,
      lastSyncedAt,
    };
    await db.update(taskDependencies).set({
      syncStatus: synced.syncStatus,
      syncAction: synced.syncAction,
      syncError: synced.syncError,
      lastSyncedAt,
    }).where(eq(taskDependencies.id, dependency.id));
    return synced;
  } catch (error) {
    await markDependencyFailed(dependency.id, 'create', error);
    return {
      ...dependency,
      connectorInstanceId: blocker.connectorInstanceId,
      syncStatus: 'failed',
      syncAction: 'create',
      syncError: dependencyError(error),
    };
  }
}

export async function removeTaskDependencyFromSource(
  dependency: DependencyRecord,
  blocker: DependencyTask,
  blocked: DependencyTask,
): Promise<{ deleted: boolean; error?: string }> {
  const connectorInstanceId = dependency.connectorInstanceId;
  if (!connectorInstanceId || dependency.type !== 'blocks') {
    await db.delete(taskDependencies).where(eq(taskDependencies.id, dependency.id));
    return { deleted: true };
  }
  return withConnectorDependencyLock(connectorInstanceId, async () => {
    const [currentDependency] = await db.select().from(taskDependencies).where(
      eq(taskDependencies.id, dependency.id),
    ) as DependencyRecord[];
    if (!currentDependency) return { deleted: true };
    return removeTaskDependencyFromSourceUnlocked(
      { ...currentDependency, connectorInstanceId },
      blocker,
      blocked,
    );
  });
}

async function removeTaskDependencyFromSourceUnlocked(
  dependency: DependencyRecord,
  blocker: DependencyTask,
  blocked: DependencyTask,
): Promise<{ deleted: boolean; error?: string }> {
  const connectorInstanceId = dependency.connectorInstanceId;
  if (!connectorInstanceId) {
    throw new Error('Source-backed dependency is missing its connector instance');
  }
  let connector: IConnector | null = null;
  try {
    const capabilities = await getConnectorCapabilities(connectorInstanceId);
    if (capabilities?.dependencyWrite) {
      connector = await getOrInitializeConnector(connectorInstanceId);
    }
  } catch (error) {
    await markDependencyFailed(dependency.id, 'delete', error);
    return { deleted: false, error: dependencyError(error) };
  }
  if (!connector?.removeTaskDependency) {
    const error = 'The source connector is unavailable or no longer supports dependency removal';
    await markDependencyFailed(dependency.id, 'delete', error);
    return { deleted: false, error };
  }

  await db.update(taskDependencies).set({
    syncStatus: 'pending',
    syncAction: 'delete',
    syncError: null,
  }).where(eq(taskDependencies.id, dependency.id));

  try {
    await writeDependency(connector, blocker, blocked, 'delete');
    await db.delete(taskDependencies).where(eq(taskDependencies.id, dependency.id));
    return { deleted: true };
  } catch (error) {
    await markDependencyFailed(dependency.id, 'delete', error);
    return { deleted: false, error: dependencyError(error) };
  }
}

async function retryPendingActions(
  connectorInstanceId: string,
  connector: IConnector,
  dependencies: DependencyRecord[],
  taskById: Map<string, DependencyTask>,
): Promise<{ pushed: number; failed: number }> {
  let pushed = 0;
  let failed = 0;

  for (const dependency of dependencies) {
    if (
      dependency.connectorInstanceId !== connectorInstanceId
      || !dependency.syncAction
    ) continue;

    const blocker = taskById.get(dependency.dependsOnTaskId);
    const blocked = taskById.get(dependency.taskId);
    if (!blocker || !blocked) continue;

    try {
      if (dependency.syncAction === 'create') {
        if (!connector.addTaskDependency) throw new Error('Connector cannot add dependencies');
        await writeDependency(connector, blocker, blocked, 'create');
        await db.update(taskDependencies).set({
          syncStatus: 'synced',
          syncAction: null,
          syncError: null,
          lastSyncedAt: new Date().toISOString(),
        }).where(eq(taskDependencies.id, dependency.id));
      } else {
        if (!connector.removeTaskDependency) throw new Error('Connector cannot remove dependencies');
        await writeDependency(connector, blocker, blocked, 'delete');
        await db.delete(taskDependencies).where(eq(taskDependencies.id, dependency.id));
      }
      pushed++;
    } catch (error) {
      await markDependencyFailed(dependency.id, dependency.syncAction, error);
      failed++;
    }
  }

  return { pushed, failed };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : fallback;
}

function getDependencyBatchSize(): number {
  return positiveIntegerEnv(
    'MC_DEPENDENCY_RECONCILIATION_BATCH_SIZE',
    DEFAULT_DEPENDENCY_BATCH_SIZE,
  );
}

function getStreamedDependencyBatchSize(): number {
  return positiveIntegerEnv(
    'MC_DEPENDENCY_STREAM_BATCH_SIZE',
    DEFAULT_STREAMED_DEPENDENCY_BATCH_SIZE,
  );
}

function getDependencyRetryBaseMs(): number {
  return positiveIntegerEnv(
    'MC_DEPENDENCY_RECONCILIATION_RETRY_BASE_MS',
    DEFAULT_RETRY_BASE_MS,
  );
}

async function getLastCompletedSnapshot(
  connectorInstanceId: string,
): Promise<DependencySnapshot | undefined> {
  const [completed] = await db.select().from(dependencyReconciliationSnapshots).where(and(
    eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
    eq(dependencyReconciliationSnapshots.status, 'completed'),
  )).orderBy(desc(dependencyReconciliationSnapshots.completedAt)).limit(1);
  return completed;
}

async function getTerminalSnapshotIdsToRetain(
  connectorInstanceId: string,
  currentSnapshotId: string,
): Promise<string[]> {
  const [recentSnapshots, lastCompletedSnapshots] = await Promise.all([
    db.select({
      id: dependencyReconciliationSnapshots.id,
    }).from(dependencyReconciliationSnapshots).where(and(
      eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
      inArray(dependencyReconciliationSnapshots.status, ['completed', 'partial']),
      ne(dependencyReconciliationSnapshots.id, currentSnapshotId),
    )).orderBy(
      desc(dependencyReconciliationSnapshots.updatedAt),
      desc(dependencyReconciliationSnapshots.id),
    ).limit(MAX_TERMINAL_SNAPSHOT_HISTORY - 1),
    db.select({
      id: dependencyReconciliationSnapshots.id,
    }).from(dependencyReconciliationSnapshots).where(and(
      eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
      eq(dependencyReconciliationSnapshots.status, 'completed'),
      ne(dependencyReconciliationSnapshots.id, currentSnapshotId),
    )).orderBy(
      desc(dependencyReconciliationSnapshots.completedAt),
      desc(dependencyReconciliationSnapshots.id),
    ).limit(1),
  ]);
  const retainedIds = new Set([
    currentSnapshotId,
    ...lastCompletedSnapshots.map(({ id }) => id),
  ]);
  for (const { id } of recentSnapshots) {
    if (retainedIds.size >= MAX_TERMINAL_SNAPSHOT_HISTORY) break;
    retainedIds.add(id);
  }
  return [...retainedIds];
}

function snapshotProgress(
  snapshot: DependencySnapshot,
  lastCompleted: DependencySnapshot | undefined,
  edgeCounts: ReadonlyMap<string, number> = new Map(),
  consecutiveFailedGenerationCount = 0,
): DependencyReconciliationProgress {
  const completedAt = snapshot.completedAt
    ? Date.parse(snapshot.completedAt)
    : Number.NaN;
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
    identityComparisonRunId: snapshot.identityComparisonRunId,
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
          identityComparisonRunId: lastCompleted.identityComparisonRunId,
          identityEvidenceFailureReason: lastCompleted.identityEvidenceFailureReason,
        }
      : null,
  };
}

export async function getDependencyReconciliationHealth(
  connectorInstanceIds?: string[],
  shouldDefer?: () => boolean,
): Promise<
  Map<string, DependencyReconciliationProgress>
> {
  if (connectorInstanceIds?.length === 0) return new Map();
  if (shouldDefer?.()) return new Map();
  const connectorFilter = connectorInstanceIds
    ? inArray(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceIds)
    : undefined;
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
  if (shouldDefer?.()) return new Map();
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
      inArray(
        dependencyReconciliationSnapshots.status,
        ['completed', 'partial', 'failed'],
      ),
    )).orderBy(
      dependencyReconciliationSnapshots.connectorInstanceId,
      desc(dependencyReconciliationSnapshots.startedAt),
    ),
  ]);
  if (shouldDefer?.()) return new Map();
  const lastCompleted = new Map(
    completedRows.map((row) => [row.connectorInstanceId, row]),
  );
  const edgeCounts = new Map(
    edgeCountRows.map((row) => [row.snapshotId, Number(row.count)]),
  );
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

export async function getLatestCompletedDependencyGeneration(
  connectorInstanceId: string,
): Promise<DependencyReconciliationProgress | undefined> {
  const [snapshot] = await db.select().from(dependencyReconciliationSnapshots)
    .where(and(
      eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
      eq(dependencyReconciliationSnapshots.status, 'completed'),
    ))
    .orderBy(desc(dependencyReconciliationSnapshots.completedAt))
    .limit(1);
  if (!snapshot) return undefined;
  const [edgeCount] = await db.select({
    count: sql<number>`COUNT(*)`,
  }).from(dependencyReconciliationEdges).where(
    eq(dependencyReconciliationEdges.snapshotId, snapshot.id),
  );
  return snapshotProgress(
    snapshot,
    snapshot,
    new Map([[snapshot.id, Number(edgeCount?.count ?? 0)]]),
  );
}

export async function* streamCompletedDependencyGenerationEdges(
  generationId: string,
  batchSize = 500,
) {
  const [snapshot] = await db.select({
    status: dependencyReconciliationSnapshots.status,
  }).from(dependencyReconciliationSnapshots)
    .where(eq(dependencyReconciliationSnapshots.id, generationId))
    .limit(1);
  if (snapshot?.status !== 'completed') {
    throw new Error(`Dependency generation ${generationId} is not completed`);
  }

  const size = Number.isFinite(batchSize) && batchSize > 0
    ? Math.floor(batchSize)
    : 500;
  let offset = 0;
  while (true) {
    const edges = await db.select({
      blockerSourceId: dependencyReconciliationEdges.blockerSourceId,
      blockedSourceId: dependencyReconciliationEdges.blockedSourceId,
    }).from(dependencyReconciliationEdges)
      .where(eq(dependencyReconciliationEdges.snapshotId, generationId))
      .orderBy(
        asc(dependencyReconciliationEdges.blockedSourceId),
        asc(dependencyReconciliationEdges.blockerSourceId),
      )
      .limit(size)
      .offset(offset);
    if (edges.length === 0) return;
    yield edges;
    offset += edges.length;
  }
}

export async function getResumableDependencyReconciliations(): Promise<
  DependencyReconciliationResumeCandidate[]
> {
  const rows = await db.select({
    connectorId: dependencyReconciliationSnapshots.connectorInstanceId,
    generationId: dependencyReconciliationSnapshots.id,
    status: dependencyReconciliationSnapshots.status,
    processed: dependencyReconciliationSnapshots.cursor,
    total: dependencyReconciliationSnapshots.total,
    nextAttemptAt: dependencyReconciliationSnapshots.nextAttemptAt,
  }).from(dependencyReconciliationSnapshots)
    .innerJoin(
      connectorConfigs,
      eq(
        connectorConfigs.id,
        dependencyReconciliationSnapshots.connectorInstanceId,
      ),
    )
    .where(and(
      inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
      ne(dependencyReconciliationSnapshots.phase, 'collecting'),
      eq(connectorConfigs.enabled, true),
      isNull(connectorConfigs.deletedAt),
    ));
  return rows as DependencyReconciliationResumeCandidate[];
}

export async function getResumableDependencyConnectorIds(): Promise<string[]> {
  return (await getResumableDependencyReconciliations())
    .map(({ connectorId }) => connectorId);
}

export async function recordDependencyReconciliationResumeOutcome(
  generationId: string,
  outcome: 'advanced' | 'deferred' | 'failed',
  reason: string,
  attemptedAt = new Date().toISOString(),
): Promise<void> {
  runTransaction((tx) => {
    const snapshot = tx.select().from(dependencyReconciliationSnapshots)
      .where(eq(dependencyReconciliationSnapshots.id, generationId))
      .limit(1)
      .get();
    if (!snapshot || !validateDependencySnapshotMutationInTransaction(
      tx,
      snapshot,
      { now: attemptedAt },
    )) return;
    tx.update(dependencyReconciliationSnapshots).set({
      lastResumeAttemptAt: attemptedAt,
      lastResumeOutcome: outcome,
      lastResumeReason: reason.slice(0, 120),
    }).where(and(
      eq(dependencyReconciliationSnapshots.id, generationId),
      eq(
        dependencyReconciliationSnapshots.identityMode,
        snapshot.identityMode,
      ),
      eq(
        dependencyReconciliationSnapshots.identityModeRevision,
        snapshot.identityModeRevision,
      ),
    )).run();
  });
}

async function loadActiveSnapshot(
  connectorInstanceId: string,
): Promise<DependencySnapshot | undefined> {
  const [snapshot] = await db.select().from(dependencyReconciliationSnapshots)
    .where(and(
      eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
      inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
    ))
    .orderBy(desc(dependencyReconciliationSnapshots.startedAt))
    .limit(1);
  return snapshot;
}

async function getDependencyDeletionCandidates(connectorInstanceId: string) {
  return db.select({
    id: taskDependencies.id,
  }).from(taskDependencies).where(and(
    eq(taskDependencies.connectorInstanceId, connectorInstanceId),
    eq(taskDependencies.syncStatus, 'synced'),
    isNull(taskDependencies.syncAction),
  ));
}

export async function beginDependencySnapshotGeneration(
  connectorInstanceId: string,
  frozenIdentityContext: GitHubIdentityModeSnapshot = getGitHubIdentityModeSnapshot(
    connectorInstanceId,
  ),
): Promise<SourceTaskDependencyGenerationWriter | undefined> {
  if (frozenIdentityContext.connectorInstanceId !== connectorInstanceId) {
    throw new Error('Dependency identity context belongs to another connector');
  }
  if (
    frozenIdentityContext.stablePrimaryEnabled
      !== (frozenIdentityContext.effectiveMode === 'stable')
  ) {
    throw new Error('Dependency generation identity context has an inconsistent stable flag');
  }
  const active = await loadActiveSnapshot(connectorInstanceId);
  if (active?.phase !== 'collecting') {
    if (active) {
      syncLogger.info({
        connectorId: connectorInstanceId,
        dependencySnapshotId: active.id,
        phase: active.phase,
      }, 'Dependency snapshot collection deferred while a generation is reconciling');
      return undefined;
    }
  } else {
    const failedAt = new Date().toISOString();
    const interrupted = runTransaction((tx) => {
      if (!validateDependencySnapshotMutationInTransaction(
        tx,
        active,
        { phase: 'collecting', now: failedAt },
      )) return false;
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
        eq(dependencyReconciliationSnapshots.id, active.id),
        eq(dependencyReconciliationSnapshots.phase, 'collecting'),
        eq(dependencyReconciliationSnapshots.identityMode, active.identityMode),
        eq(
          dependencyReconciliationSnapshots.identityModeRevision,
          active.identityModeRevision,
        ),
      )).run();
      return true;
    });
    if (!interrupted) {
      throw new Error('Dependency identity context changed before generation restart');
    }
  }

  const deletionCandidates = await getDependencyDeletionCandidates(connectorInstanceId);
  const now = new Date().toISOString();
  const snapshot: typeof dependencyReconciliationSnapshots.$inferInsert = {
    id: randomUUID(),
    connectorInstanceId,
    status: 'running',
    phase: 'collecting',
    cursor: 0,
    total: 0,
    batchSize: getStreamedDependencyBatchSize(),
    failureCount: 0,
    importedCount: 0,
    removedCount: 0,
    identityMode: frozenIdentityContext.effectiveMode,
    identityModeRevision: frozenIdentityContext.modeRevision,
    identityEvidenceSource: 'legacy-unavailable',
    identityEvidenceEligible: false,
    startedAt: now,
    updatedAt: now,
  };

  const generationCreated = runTransaction((tx) => {
    const currentIdentityMode = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      connectorInstanceId,
    );
    const contextMatches = dependencyIdentityContextMatches(
      snapshot as DependencySnapshot,
      currentIdentityMode,
    );
    tx.insert(dependencyReconciliationSnapshots).values(contextMatches ? snapshot : {
      ...snapshot,
      status: 'partial',
      phase: 'completed',
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_identity_context_changed',
      completedAt: now,
      failedAt: now,
      failureReason: 'identity context changed before dependency generation creation',
    }).run();
    if (contextMatches && deletionCandidates.length > 0) {
      tx.insert(dependencyReconciliationCandidates).values(
        deletionCandidates.map(({ id }) => ({
          snapshotId: snapshot.id,
          dependencyId: id,
        })),
      ).run();
    }
    return contextMatches;
  });
  if (!generationCreated) {
    throw new Error('Dependency identity context changed before generation creation');
  }

  let tail = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const stagePage = (
    remote: SourceTaskDependencySnapshot,
    mode: SourceTaskDependencyReadMode,
  ) => enqueue(async () => {
    const [current] = await db.select().from(dependencyReconciliationSnapshots)
      .where(eq(dependencyReconciliationSnapshots.id, snapshot.id))
      .limit(1);
    if (!current || current.status !== 'running' || current.phase !== 'collecting') {
      throw new Error(`Dependency generation ${snapshot.id} is not collecting`);
    }
    if (current.readMode && current.readMode !== mode) {
      throw new Error(
        `Dependency generation ${snapshot.id} changed read mode from ${current.readMode} to ${mode}`,
      );
    }

    const sourceIds = [...new Set(remote.completeBlockedSourceIds)];
    const existingItems = sourceIds.length > 0
      ? await db.select({
          sourceId: dependencyReconciliationItems.sourceId,
          identityEvidence: dependencyReconciliationItems.identityEvidence,
          identityEvidenceState: dependencyReconciliationItems.identityEvidenceState,
        })
          .from(dependencyReconciliationItems)
          .where(and(
            eq(dependencyReconciliationItems.snapshotId, snapshot.id),
            inArray(dependencyReconciliationItems.sourceId, sourceIds),
          ))
      : [];
    const existingSourceIds = new Set(existingItems.map(({ sourceId }) => sourceId));
    const newSourceIds = sourceIds.filter((sourceId) => !existingSourceIds.has(sourceId));
    const pageSourceIds = new Set(sourceIds);
    const blockedEvidenceBySourceId = new Map(
      (remote.blockedIdentityEvidence ?? []).map((entry) => [entry.sourceId, entry] as const),
    );
    for (const sourceId of sourceIds) {
      const incoming = blockedEvidenceBySourceId.get(sourceId);
      const existing = existingItems.find((item) => item.sourceId === sourceId);
      if (
        existing
        && (
          existing.identityEvidenceState !== (incoming?.state ?? 'missing')
          || JSON.stringify(existing.identityEvidence ?? null)
            !== JSON.stringify(incoming?.evidence ?? null)
        )
      ) {
        throw new Error(
          `Dependency generation ${snapshot.id} received conflicting identity evidence for ${sourceId}`,
        );
      }
    }
    const edges = [...new Map(
      remote.dependencies
        .filter((edge) => pageSourceIds.has(edge.blockedSourceId))
        .map((edge) => [`${edge.blockerSourceId}\u0000${edge.blockedSourceId}`, edge]),
    ).values()];
    const updatedAt = new Date().toISOString();

    const staged = runTransaction((tx) => {
      if (!validateDependencySnapshotMutationInTransaction(
        tx,
        snapshot as DependencySnapshot,
        { phase: 'collecting', now: updatedAt },
      )) return false;
      const persisted = tx.select({ total: dependencyReconciliationSnapshots.total })
        .from(dependencyReconciliationSnapshots)
        .where(eq(dependencyReconciliationSnapshots.id, snapshot.id))
        .limit(1)
        .get();
      if (!persisted || persisted.total !== current.total) return false;
      if (newSourceIds.length > 0) {
        tx.insert(dependencyReconciliationItems).values(
          newSourceIds.map((sourceId, offset) => ({
            snapshotId: snapshot.id,
            position: current.total + offset,
            sourceId,
            verified: true,
            identityEvidence: blockedEvidenceBySourceId.get(sourceId)?.evidence,
            identityEvidenceState:
              blockedEvidenceBySourceId.get(sourceId)?.state ?? 'missing',
          })),
        ).run();
      }
      if (edges.length > 0) {
        tx.insert(dependencyReconciliationEdges).values(
          edges.map((edge) => ({
            snapshotId: snapshot.id,
            blockerSourceId: edge.blockerSourceId,
            blockedSourceId: edge.blockedSourceId,
            blockerIdentityEvidence: edge.blockerIdentityEvidence,
            blockerIdentityEvidenceState:
              edge.blockerIdentityEvidenceState ?? 'missing',
          })),
        ).onConflictDoNothing().run();
      }
      const advanced = tx.update(dependencyReconciliationSnapshots).set({
        readMode: mode,
        identityEvidenceSource: dependencyIdentityEvidenceSource(mode),
        identityEvidenceEligible: false,
        identityEvidenceFailureReason: null,
        total: current.total + newSourceIds.length,
        collectionPageCount: sql`${dependencyReconciliationSnapshots.collectionPageCount} + 1`,
        overflowFetchCount: sql`${dependencyReconciliationSnapshots.overflowFetchCount} + ${remote.overflowFetchCount ?? 0}`,
        updatedAt,
      }).where(and(
        eq(dependencyReconciliationSnapshots.id, snapshot.id),
        eq(dependencyReconciliationSnapshots.phase, 'collecting'),
        eq(dependencyReconciliationSnapshots.total, current.total),
        eq(
          dependencyReconciliationSnapshots.identityMode,
          frozenIdentityContext.effectiveMode,
        ),
        eq(
          dependencyReconciliationSnapshots.identityModeRevision,
          frozenIdentityContext.modeRevision,
        ),
      )).run();
      if (advanced.changes !== 1) {
        throw new Error('Dependency collection page CAS failed');
      }
      return true;
    });
    if (!staged) {
      throw new Error('Dependency generation was fenced before page staging');
    }
  });

  return {
    stagePage,
    complete: (mode) => enqueue(async () => {
      const completedAt = new Date().toISOString();
      const [current] = await db.select().from(dependencyReconciliationSnapshots)
        .where(eq(dependencyReconciliationSnapshots.id, snapshot.id))
        .limit(1);
      if (!current || current.status !== 'running' || current.phase !== 'collecting') return;
      if (current.readMode && current.readMode !== mode) {
        throw new Error(
          `Dependency generation ${snapshot.id} changed read mode from ${current.readMode} to ${mode}`,
        );
      }
      const evidenceSource = dependencyIdentityEvidenceSource(mode);
      const completed = runTransaction((tx) => {
        if (!validateDependencySnapshotMutationInTransaction(
          tx,
          snapshot as DependencySnapshot,
          { phase: 'collecting', now: completedAt },
        )) return false;
        const blockedEvidenceCounts = tx.select({
          incomplete: sql<number>`SUM(CASE WHEN ${dependencyReconciliationItems.identityEvidenceState} != 'verified' THEN 1 ELSE 0 END)`,
        }).from(dependencyReconciliationItems).where(
          eq(dependencyReconciliationItems.snapshotId, snapshot.id),
        ).get();
        const blockerEvidenceCounts = tx.select({
          incomplete: sql<number>`SUM(CASE WHEN ${dependencyReconciliationEdges.blockerIdentityEvidenceState} != 'verified' THEN 1 ELSE 0 END)`,
        }).from(dependencyReconciliationEdges).where(
          eq(dependencyReconciliationEdges.snapshotId, snapshot.id),
        ).get();
        const incompleteEvidence = Number(blockedEvidenceCounts?.incomplete ?? 0)
          + Number(blockerEvidenceCounts?.incomplete ?? 0);
        const evidenceEligible = evidenceSource === 'graphql-node'
          && incompleteEvidence === 0;
        const changed = tx.update(dependencyReconciliationSnapshots).set({
          phase: 'ready',
          readMode: mode,
          identityEvidenceSource: evidenceSource,
          identityEvidenceEligible: evidenceEligible,
          identityEvidenceFailureReason: evidenceEligible
            ? null
            : evidenceSource === 'rest-unavailable'
              ? 'dependency_stable_evidence_unavailable'
              : 'dependency_stable_evidence_incomplete',
          collectionCompletedAt: completedAt,
          updatedAt: completedAt,
        }).where(and(
          eq(dependencyReconciliationSnapshots.id, snapshot.id),
          eq(dependencyReconciliationSnapshots.phase, 'collecting'),
          eq(
            dependencyReconciliationSnapshots.identityMode,
            frozenIdentityContext.effectiveMode,
          ),
          eq(
            dependencyReconciliationSnapshots.identityModeRevision,
            frozenIdentityContext.modeRevision,
          ),
        )).run();
        return changed.changes === 1;
      });
      if (!completed) {
        throw new Error('Dependency generation was fenced before collection completion');
      }
      syncLogger.info({
        connectorId: connectorInstanceId,
        dependencySnapshotId: snapshot.id,
        dependencyReadMode: mode,
        total: current.total,
      }, 'Dependency snapshot collection completed');
    }),
    fail: (error) => enqueue(async () => {
      const failedAt = new Date().toISOString();
      const failureReason = dependencyError(error);
      const result = runTransaction((tx) => {
        if (!validateDependencySnapshotMutationInTransaction(
          tx,
          snapshot as DependencySnapshot,
          { phase: 'collecting', now: failedAt },
        )) return { changes: 0 };
        return tx.update(dependencyReconciliationSnapshots).set({
        status: 'partial',
        identityEvidenceEligible: false,
        identityEvidenceFailureReason: 'dependency_collection_incomplete',
        failedAt,
        updatedAt: failedAt,
        failureReason,
        }).where(and(
        eq(dependencyReconciliationSnapshots.id, snapshot.id),
        eq(dependencyReconciliationSnapshots.status, 'running'),
        eq(dependencyReconciliationSnapshots.phase, 'collecting'),
        eq(
          dependencyReconciliationSnapshots.identityMode,
          frozenIdentityContext.effectiveMode,
        ),
        eq(
          dependencyReconciliationSnapshots.identityModeRevision,
          frozenIdentityContext.modeRevision,
        ),
        )).run();
      });
      if (result.changes > 0) {
        syncLogger.warn({
          err: error,
          connectorId: connectorInstanceId,
          dependencySnapshotId: snapshot.id,
        }, 'Dependency snapshot collection failed; staged edges will not be reconciled');
      }
    }),
  };
}

export function createTargetedDependencyCollection(): TargetedDependencyCollection {
  const completeSourceIds = new Set<string>();
  const edges = new Map<string, SourceTaskDependencySnapshot['dependencies'][number]>();
  const blockedIdentityEvidence = new Map<
    string,
    NonNullable<SourceTaskDependencySnapshot['blockedIdentityEvidence']>[number]
  >();
  let readMode: SourceTaskDependencyReadMode | null = null;
  let completed = false;
  let failure: Error | null = null;
  let overflowFetchCount = 0;

  return {
    writer: {
      failureMode: 'best-effort',
      async stagePage(snapshot, mode) {
        if (completed || failure) {
          throw new Error('Targeted dependency collection is no longer accepting pages');
        }
        readMode = mode;
        for (const sourceId of snapshot.completeBlockedSourceIds) {
          completeSourceIds.add(sourceId);
        }
        for (const edge of snapshot.dependencies) {
          edges.set(`${edge.blockerSourceId}\u0000${edge.blockedSourceId}`, edge);
        }
        for (const evidence of snapshot.blockedIdentityEvidence ?? []) {
          const existing = blockedIdentityEvidence.get(evidence.sourceId);
          if (
            existing
            && JSON.stringify(existing) !== JSON.stringify(evidence)
          ) {
            throw new Error(
              `Targeted dependency collection received conflicting identity evidence for ${evidence.sourceId}`,
            );
          }
          blockedIdentityEvidence.set(evidence.sourceId, evidence);
        }
        overflowFetchCount += snapshot.overflowFetchCount ?? 0;
      },
      async complete(mode) {
        if (failure) return;
        readMode = mode;
        completed = true;
      },
      async fail(error) {
        if (!failure) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      },
    },
    result() {
      if (failure) throw failure;
      if (!completed || !readMode) {
        throw new Error('Targeted dependency collection did not complete');
      }
      return {
        readMode,
        snapshot: {
          dependencies: [...edges.values()],
          completeBlockedSourceIds: [...completeSourceIds],
          blockedIdentityEvidence: [...blockedIdentityEvidence.values()],
          overflowFetchCount,
        },
      };
    },
  };
}

interface DependencyEndpointIdentityEvidence {
  sourceId: string;
  evidence?: ExternalIdentityEvidence;
  state: 'verified' | 'missing' | 'partial';
}

interface DependencyIdentityObservation {
  decisionsBySourceId: ReadonlyMap<string, GitHubIdentityResolutionDecision>;
  evidenceEligible: boolean;
  failureReason: string | null;
  comparisonRunId: string | null;
}

function mergeDependencyEndpointEvidence(
  target: Map<string, DependencyEndpointIdentityEvidence>,
  incoming: DependencyEndpointIdentityEvidence,
): void {
  const existing = target.get(incoming.sourceId);
  if (!existing) {
    target.set(incoming.sourceId, incoming);
    return;
  }
  if (
    existing.state !== incoming.state
    || stableEvidenceKey(existing.evidence) !== stableEvidenceKey(incoming.evidence)
  ) {
    target.set(incoming.sourceId, {
      sourceId: incoming.sourceId,
      state: 'partial',
    });
  }
}

function stableEvidenceKey(evidence: ExternalIdentityEvidence | undefined): string | null {
  if (!evidence) return null;
  const { identity, locator } = evidence.entity;
  return JSON.stringify([
    identity.provider,
    identity.hostKey,
    identity.entityType,
    identity.stableId,
    locator.owner.toLowerCase(),
    locator.repository.toLowerCase(),
    locator.issueNumber ?? null,
  ]);
}

function dependencyEndpointEvidence(
  remote: SourceTaskDependencySnapshot,
): Map<string, DependencyEndpointIdentityEvidence> {
  const result = new Map<string, DependencyEndpointIdentityEvidence>();
  const blockedBySourceId = new Map(
    (remote.blockedIdentityEvidence ?? []).map((entry) => [entry.sourceId, entry] as const),
  );
  for (const sourceId of remote.completeBlockedSourceIds) {
    const evidence = blockedBySourceId.get(sourceId);
    mergeDependencyEndpointEvidence(result, {
      sourceId,
      evidence: evidence?.evidence,
      state: evidence?.state === 'verified' && !evidence.evidence
        ? 'partial'
        : evidence?.state ?? 'missing',
    });
  }
  for (const edge of remote.dependencies) {
    mergeDependencyEndpointEvidence(result, {
      sourceId: edge.blockedSourceId,
      evidence: blockedBySourceId.get(edge.blockedSourceId)?.evidence,
      state: blockedBySourceId.get(edge.blockedSourceId)?.state === 'verified'
        && !blockedBySourceId.get(edge.blockedSourceId)?.evidence
        ? 'partial'
        : blockedBySourceId.get(edge.blockedSourceId)?.state ?? 'missing',
    });
    mergeDependencyEndpointEvidence(result, {
      sourceId: edge.blockerSourceId,
      evidence: edge.blockerIdentityEvidence,
      state: edge.blockerIdentityEvidenceState === 'verified'
        && !edge.blockerIdentityEvidence
        ? 'partial'
        : edge.blockerIdentityEvidenceState ?? 'missing',
    });
  }
  return result;
}

function isDependencyDecisionEligible(
  decision: GitHubIdentityResolutionDecision | undefined,
): boolean {
  return Boolean(
    decision
    && decision.appliedSource !== 'blocked'
    && (decision.outcome === 'agreement' || decision.outcome === 'locator_change'),
  );
}

function observeDependencyIdentity(
  connectorInstanceId: string,
  modeSnapshot: GitHubIdentityModeSnapshot,
  remote: SourceTaskDependencySnapshot,
  taskBySourceId: ReadonlyMap<string, DependencyTask>,
  providedRuntime?: GitHubIdentityComparisonRuntime,
): DependencyIdentityObservation {
  if (
    modeSnapshot.effectiveMode !== 'comparison'
    && modeSnapshot.effectiveMode !== 'stable'
  ) {
    return {
      decisionsBySourceId: new Map(),
      evidenceEligible: false,
      failureReason: 'connector_not_in_comparison_mode',
      comparisonRunId: null,
    };
  }
  if (
    modeSnapshot.stablePrimaryEnabled !== (modeSnapshot.effectiveMode === 'stable')
  ) {
    throw new Error('Dependency identity runtime has an inconsistent stable-primary flag');
  }
  if (
    providedRuntime
    && (
      providedRuntime.modeSnapshot.effectiveMode !== modeSnapshot.effectiveMode
      || providedRuntime.modeSnapshot.modeRevision !== modeSnapshot.modeRevision
    )
  ) {
    throw new Error('Dependency comparison runtime does not match the frozen generation context');
  }

  const endpoints = [...dependencyEndpointEvidence(remote).values()]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const hasNoEndpointEvidence = endpoints.length === 0;
  const ownedRuntime = providedRuntime
    ? null
    : new GitHubIdentityComparisonRuntime({
        connectorInstanceId,
        modeSnapshot,
        syncKind: 'incremental',
      });
  const runtime = providedRuntime ?? ownedRuntime!;
  if (ownedRuntime) {
    const observedPages = Math.max(1, Math.ceil(endpoints.length / 50));
    for (let page = 0; page < observedPages; page++) runtime.markNetworkPage();
  }

  const decisionsBySourceId = new Map<string, GitHubIdentityResolutionDecision>();
  const applicableStableLocalIds = new Set(
    [...taskBySourceId.values()].map((task) => task.id),
  );
  let hasMissingEvidence = false;
  let hasPartialEvidence = false;
  try {
    for (let index = 0; index < endpoints.length; index += 500) {
      const chunk = endpoints.slice(index, index + 500);
      const resolvedCandidates = chunk.filter((endpoint) => endpoint.state !== 'partial');
      if (resolvedCandidates.length > 0) {
        const decisions = runtime.observeBatch(
          'dependency',
          'task',
          resolvedCandidates.map((endpoint) => {
            const local = taskBySourceId.get(endpoint.sourceId);
            if (endpoint.state === 'missing') hasMissingEvidence = true;
            return {
              candidateKey: `dependency:endpoint:${endpoint.sourceId}`,
              legacySelectedLocalIds: local ? [local.id] : [],
              legacyAction: local ? 'present' as const : 'none' as const,
              applicableStableLocalIds,
              unmatchedStableAction: 'none' as const,
              evidence: endpoint.evidence,
              localTaskId: local?.id,
            };
          }),
        );
        for (const decision of decisions) {
          decisionsBySourceId.set(
            decision.candidateKey.slice('dependency:endpoint:'.length),
            decision,
          );
        }
      }
      const partialCandidates = chunk.filter((endpoint) => endpoint.state === 'partial');
      if (partialCandidates.length > 0) {
        hasPartialEvidence = true;
        const decisions = runtime.observeResolvedBatch(
          'dependency',
          partialCandidates.map((endpoint) => {
            const local = taskBySourceId.get(endpoint.sourceId);
            return {
              candidateKey: `dependency:endpoint:${endpoint.sourceId}`,
              legacySelectedLocalIds: local ? [local.id] : [],
              legacyAction: local ? 'present' as const : 'none' as const,
              localTaskId: local?.id,
              stable: {
                selectedLocalIds: [],
                action: 'none' as const,
                evidence: 'partial' as const,
              },
            };
          }),
        );
        for (const decision of decisions) {
          decisionsBySourceId.set(
            decision.candidateKey.slice('dependency:endpoint:'.length),
            decision,
          );
        }
      }
    }
    if (hasNoEndpointEvidence) runtime.markIneligible('dependency_endpoint_evidence_empty');
    if (hasMissingEvidence) runtime.markIneligible('dependency_stable_evidence_missing');
    if (hasPartialEvidence) runtime.markIneligible('dependency_stable_evidence_partial');
    runtime.assertDecisionsCurrent(decisionsBySourceId.values());
    const blockingDecision = [...decisionsBySourceId.values()].some(
      (decision) => !isDependencyDecisionEligible(decision),
    );
    if (ownedRuntime) ownedRuntime.complete('succeeded');
    return {
      decisionsBySourceId,
      evidenceEligible:
        !hasNoEndpointEvidence
        && !hasMissingEvidence
        && !hasPartialEvidence
        && !blockingDecision,
      failureReason: hasNoEndpointEvidence
        ? 'dependency_endpoint_evidence_empty'
        : hasPartialEvidence
          ? 'dependency_stable_evidence_partial'
          : hasMissingEvidence
            ? 'dependency_stable_evidence_missing'
            : blockingDecision
              ? 'dependency_identity_comparison_blocked'
              : null,
      comparisonRunId: runtime.runId,
    };
  } catch (error) {
    ownedRuntime?.complete('failed', 'dependency_identity_observation_failed');
    throw error;
  }
}

export async function reconcileTargetedTaskDependencies(
  connectorInstanceId: string,
  remote: SourceTaskDependencySnapshot,
  observedSourceIds: ReadonlySet<string>,
  identityComparison?: GitHubIdentityComparisonRuntime,
): Promise<{ imported: number; removed: number }> {
  return withConnectorDependencyLock(connectorInstanceId, async () => {
    const verifiedSourceIds = new Set(
      remote.completeBlockedSourceIds.filter((sourceId) =>
        observedSourceIds.has(sourceId) && /^[^/:]+\/[^/:]+:\d+$/.test(sourceId)),
    );
    if (verifiedSourceIds.size === 0) return { imported: 0, removed: 0 };

    const connectorTasks = await db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorInstanceId: tasks.connectorInstanceId,
      isChecklistItem: tasks.isChecklistItem,
      metadata: tasks.metadata,
    }).from(tasks).where(eq(tasks.connectorInstanceId, connectorInstanceId));
    const nativeTasks = connectorTasks.filter((task) =>
      isNativeDependencyTask(task, 'github-issues'));
    const taskById = new Map(nativeTasks.map((task) => [task.id, task]));
    const taskBySourceId = new Map(nativeTasks.map((task) => [task.sourceId, task]));
    const identityMode = getGitHubIdentityModeSnapshot(connectorInstanceId);
    const identityObservation = observeDependencyIdentity(
      connectorInstanceId,
      identityMode,
      remote,
      taskBySourceId,
      identityComparison,
    );
    const deletionEligibleSourceIds = identityMode.effectiveMode !== 'legacy'
      ? new Set([...verifiedSourceIds].filter((sourceId) =>
          isDependencyDecisionEligible(
            identityObservation.decisionsBySourceId.get(sourceId),
          )))
      : verifiedSourceIds;
    const deletionEligibleTaskIds = identityMode.effectiveMode === 'stable'
      ? new Set([...deletionEligibleSourceIds].flatMap((sourceId) => {
          const id = identityObservation.decisionsBySourceId.get(sourceId)?.selectedLocalId;
          return id ? [id] : [];
        }))
      : new Set<string>();
    const blockedTaskIds = [...verifiedSourceIds]
      .map((sourceId) => (
        identityMode.effectiveMode === 'stable'
          ? identityObservation.decisionsBySourceId.get(sourceId)?.selectedLocalId
          : taskBySourceId.get(sourceId)?.id
      ))
      .filter((id): id is string => Boolean(id));
    if (blockedTaskIds.length === 0) return { imported: 0, removed: 0 };

    const localDependencies = await db.select().from(taskDependencies).where(and(
      inArray(taskDependencies.taskId, blockedTaskIds),
      eq(taskDependencies.type, 'blocks'),
    )) as DependencyRecord[];
    const existingByKey = new Map(localDependencies.map((dependency) => [
      `${dependency.dependsOnTaskId}\u0000${dependency.taskId}`,
      dependency,
    ]));
    const remoteKeys = new Set<string>();
    const unresolvedBlockedSourceIds = new Set<string>();
    const unresolvedBlockedTaskIds = new Set<string>();
    const usableEdges: Array<{
      blocker: DependencyTask;
      blocked: DependencyTask;
      key: string;
    }> = [];

    for (const edge of remote.dependencies) {
      if (!verifiedSourceIds.has(edge.blockedSourceId)) continue;
      const blocker = identityMode.effectiveMode === 'stable'
        ? taskById.get(
            identityObservation.decisionsBySourceId.get(edge.blockerSourceId)
              ?.selectedLocalId ?? '',
          )
        : taskBySourceId.get(edge.blockerSourceId);
      const blocked = identityMode.effectiveMode === 'stable'
        ? taskById.get(
            identityObservation.decisionsBySourceId.get(edge.blockedSourceId)
              ?.selectedLocalId ?? '',
          )
        : taskBySourceId.get(edge.blockedSourceId);
      if (!blocker || !blocked) {
        unresolvedBlockedSourceIds.add(edge.blockedSourceId);
        if (blocked) unresolvedBlockedTaskIds.add(blocked.id);
        continue;
      }
      const key = `${blocker.id}\u0000${blocked.id}`;
      remoteKeys.add(key);
      usableEdges.push({ blocker, blocked, key });
    }

    let imported = 0;
    let removed = 0;
    const syncedAt = new Date().toISOString();
    runTransaction((tx) => {
      const currentIdentityMode = getGitHubIdentityModeSnapshotInTransaction(
        tx,
        connectorInstanceId,
      );
      if (
        currentIdentityMode.effectiveMode !== identityMode.effectiveMode
        || currentIdentityMode.modeRevision !== identityMode.modeRevision
      ) {
        throw new Error('Dependency identity context changed before targeted apply');
      }
      for (const { blocker, blocked, key } of usableEdges) {
        const existing = existingByKey.get(key);
        if (existing) {
          if (!existing.syncAction) {
            tx.update(taskDependencies).set({
              connectorInstanceId,
              syncStatus: 'synced',
              syncError: null,
              lastSyncedAt: syncedAt,
            }).where(and(
              eq(taskDependencies.id, existing.id),
              isNull(taskDependencies.syncAction),
            )).run();
          }
          continue;
        }
        imported += tx.insert(taskDependencies).values({
          id: randomUUID(),
          taskId: blocked.id,
          dependsOnTaskId: blocker.id,
          type: 'blocks',
          connectorInstanceId,
          syncStatus: 'synced',
          syncAction: null,
          syncError: null,
          lastSyncedAt: syncedAt,
          createdAt: syncedAt,
        }).onConflictDoNothing().run().changes;
      }

      for (const dependency of localDependencies) {
        const blocked = taskById.get(dependency.taskId);
        if (
          !blocked
          || (
            identityMode.effectiveMode === 'stable'
              ? !deletionEligibleTaskIds.has(blocked.id)
                || unresolvedBlockedTaskIds.has(blocked.id)
              : !deletionEligibleSourceIds.has(blocked.sourceId)
                || unresolvedBlockedSourceIds.has(blocked.sourceId)
          )
          || dependency.connectorInstanceId !== connectorInstanceId
          || dependency.syncStatus !== 'synced'
          || dependency.syncAction
        ) continue;
        const key = `${dependency.dependsOnTaskId}\u0000${dependency.taskId}`;
        if (remoteKeys.has(key)) continue;
        removed += tx.delete(taskDependencies).where(and(
          eq(taskDependencies.id, dependency.id),
          eq(taskDependencies.connectorInstanceId, connectorInstanceId),
          eq(taskDependencies.syncStatus, 'synced'),
          isNull(taskDependencies.syncAction),
        )).run().changes;
      }
    });

    syncLogger.info({
      connectorId: connectorInstanceId,
      verified: verifiedSourceIds.size,
      identityEvidenceEligible: identityObservation.evidenceEligible,
      imported,
      removed,
    }, 'Targeted dependency reconciliation completed');
    return { imported, removed };
  });
}

async function createSnapshot(
  connectorInstanceId: string,
  sourceIds: string[],
  frozenIdentityContext?: GitHubIdentityModeSnapshot,
): Promise<DependencySnapshot> {
  const deletionCandidates = await getDependencyDeletionCandidates(connectorInstanceId);
  const now = new Date().toISOString();
  const snapshot: typeof dependencyReconciliationSnapshots.$inferInsert = {
    id: randomUUID(),
    connectorInstanceId,
    status: 'running',
    phase: 'reconciling',
    readMode: 'legacy',
    cursor: 0,
    total: sourceIds.length,
    batchSize: getDependencyBatchSize(),
    failureCount: 0,
    importedCount: 0,
    removedCount: 0,
    identityMode: frozenIdentityContext?.effectiveMode ?? 'legacy',
    identityModeRevision: frozenIdentityContext?.modeRevision ?? 0,
    identityEvidenceSource: 'legacy-unavailable',
    identityEvidenceEligible: false,
    startedAt: now,
    updatedAt: now,
  };

  try {
    const created = runTransaction((tx) => {
      const currentIdentityMode = getGitHubIdentityModeSnapshotInTransaction(
        tx,
        connectorInstanceId,
      );
      const contextMatches = dependencyIdentityContextMatches(
        snapshot as DependencySnapshot,
        currentIdentityMode,
      );
      tx.insert(dependencyReconciliationSnapshots).values(contextMatches ? snapshot : {
        ...snapshot,
        status: 'partial',
        phase: 'completed',
        identityEvidenceEligible: false,
        identityEvidenceFailureReason: 'dependency_identity_context_changed',
        completedAt: now,
        failedAt: now,
        failureReason: 'identity context changed before dependency snapshot creation',
      }).run();
      if (contextMatches && sourceIds.length > 0) {
        tx.insert(dependencyReconciliationItems).values(
          sourceIds.map((sourceId, position) => ({
            snapshotId: snapshot.id,
            position,
            sourceId,
            verified: false,
          })),
        ).run();
      }
      if (contextMatches && deletionCandidates.length > 0) {
        tx.insert(dependencyReconciliationCandidates).values(
          deletionCandidates.map(({ id }) => ({
            snapshotId: snapshot.id,
            dependencyId: id,
          })),
        ).run();
      }
      return contextMatches;
    });
    if (!created) {
      throw new Error('Dependency identity context changed before snapshot creation');
    }
  } catch (error) {
    const active = await loadActiveSnapshot(connectorInstanceId);
    if (active) return active;
    throw error;
  }

  syncLogger.info({
    connectorId: connectorInstanceId,
    dependencySnapshotId: snapshot.id,
    total: sourceIds.length,
    batchSize: snapshot.batchSize,
  }, 'Dependency reconciliation generation started');
  return snapshot as DependencySnapshot;
}

async function markSnapshotFailed(
  snapshot: DependencySnapshot,
  error: unknown,
): Promise<DependencySnapshot> {
  const failureCount = snapshot.failureCount + 1;
  const retryDelayMs = Math.min(
    getDependencyRetryBaseMs() * (2 ** Math.max(0, failureCount - 1)),
    MAX_RETRY_BACKOFF_MS,
  );
  const failedAt = new Date().toISOString();
  const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();
  const failureReason = dependencyError(error);

  const updated = runTransaction((tx) => {
    if (!validateDependencySnapshotMutationInTransaction(
      tx,
      snapshot,
      { cursor: snapshot.cursor, now: failedAt },
    )) return false;
    return tx.update(dependencyReconciliationSnapshots).set({
      status: 'failed',
      failureCount,
      failedAt,
      updatedAt: failedAt,
      nextAttemptAt,
      failureReason,
    }).where(and(
      eq(dependencyReconciliationSnapshots.id, snapshot.id),
      eq(dependencyReconciliationSnapshots.cursor, snapshot.cursor),
      eq(dependencyReconciliationSnapshots.identityMode, snapshot.identityMode),
      eq(
        dependencyReconciliationSnapshots.identityModeRevision,
        snapshot.identityModeRevision,
      ),
    )).run().changes === 1;
  });
  if (!updated) {
    return {
      ...snapshot,
      status: 'partial',
      phase: 'completed',
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_identity_context_changed',
      failedAt,
      updatedAt: failedAt,
      nextAttemptAt: null,
      failureReason: 'identity context changed before dependency failure update',
    };
  }

  const failed = {
    ...snapshot,
    status: 'failed' as const,
    failureCount,
    failedAt,
    updatedAt: failedAt,
    nextAttemptAt,
    failureReason,
  };
  syncLogger.warn({
    err: error,
    connectorId: snapshot.connectorInstanceId,
    dependencySnapshotId: snapshot.id,
    processed: snapshot.cursor,
    total: snapshot.total,
    failureCount,
    nextAttemptAt,
  }, 'Dependency reconciliation batch failed');
  return failed;
}

async function abandonSnapshotForIdentityContextChange(
  snapshot: DependencySnapshot,
  current: GitHubIdentityModeSnapshot,
): Promise<DependencySnapshot> {
  const failedAt = new Date().toISOString();
  const failureReason = `identity context changed from ${snapshot.identityMode}:${snapshot.identityModeRevision} to ${current.effectiveMode}:${current.modeRevision}`;
  runTransaction((tx) => {
    validateDependencySnapshotMutationInTransaction(
      tx,
      snapshot,
      { now: failedAt },
    );
  });
  syncLogger.warn({
    connectorId: snapshot.connectorInstanceId,
    dependencySnapshotId: snapshot.id,
    frozenIdentityMode: snapshot.identityMode,
    frozenIdentityModeRevision: snapshot.identityModeRevision,
    currentIdentityMode: current.effectiveMode,
    currentIdentityModeRevision: current.modeRevision,
  }, 'Dependency generation fenced after identity context change');
  return {
    ...identityContextFencedSnapshot(snapshot, failedAt),
    failureReason,
  };
}

function identityContextFencedSnapshot(
  snapshot: DependencySnapshot,
  now: string,
): DependencySnapshot {
  return {
    ...snapshot,
    status: 'partial',
    phase: 'completed',
    identityEvidenceEligible: false,
    identityEvidenceFailureReason: 'dependency_identity_context_changed',
    completedAt: now,
    failedAt: now,
    updatedAt: now,
    nextAttemptAt: null,
    failureReason: 'dependency identity context changed',
  };
}

async function applySnapshotBatch(
  connectorInstanceId: string,
  snapshot: DependencySnapshot,
  batchStart: number,
  batchEnd: number,
  batchSourceIds: string[],
  remoteSnapshot: Awaited<ReturnType<typeof fetchDependencySnapshot>>,
  taskBySourceId: Map<string, DependencyTask>,
  localDependencies: DependencyRecord[],
  stageRemoteEdges = true,
): Promise<number> {
  const requestedSourceIds = new Set(batchSourceIds);
  const verifiedSourceIds = [...new Set(
    remoteSnapshot.completeBlockedSourceIds.filter((sourceId) =>
      requestedSourceIds.has(sourceId)),
  )];
  const usableEdges = remoteSnapshot.dependencies.filter((edge) =>
    requestedSourceIds.has(edge.blockedSourceId));
  const existingByKey = new Map(
    localDependencies.map((dependency) => [
      `${dependency.dependsOnTaskId}\u0000${dependency.taskId}`,
      dependency,
    ]),
  );
  const lastSyncedAt = new Date().toISOString();
  let imported = 0;

  const applied = runTransaction((tx) => {
    if (!validateDependencySnapshotMutationInTransaction(
      tx,
      snapshot,
      { cursor: batchStart, now: lastSyncedAt },
    )) return false;
    if (stageRemoteEdges && usableEdges.length > 0) {
      tx.insert(dependencyReconciliationEdges).values(
        usableEdges.map((edge) => ({
          snapshotId: snapshot.id,
          blockerSourceId: edge.blockerSourceId,
          blockedSourceId: edge.blockedSourceId,
          blockerIdentityEvidence: edge.blockerIdentityEvidence,
          blockerIdentityEvidenceState:
            edge.blockerIdentityEvidenceState ?? 'missing',
        })),
      ).onConflictDoNothing().run();
    }
    if (verifiedSourceIds.length > 0) {
      tx.update(dependencyReconciliationItems).set({
        verified: true,
      }).where(and(
        eq(dependencyReconciliationItems.snapshotId, snapshot.id),
        inArray(dependencyReconciliationItems.sourceId, verifiedSourceIds),
      )).run();
    }

    for (const remote of usableEdges) {
      if (snapshot.identityMode === 'stable') continue;
      const blocker = taskBySourceId.get(remote.blockerSourceId);
      const blocked = taskBySourceId.get(remote.blockedSourceId);
      if (!blocker || !blocked) continue;

      const key = `${blocker.id}\u0000${blocked.id}`;
      const existing = existingByKey.get(key);
      if (existing) {
        if (existing.syncAction) continue;
        tx.update(taskDependencies).set({
          connectorInstanceId,
          syncStatus: 'synced',
          syncError: null,
          lastSyncedAt,
        }).where(and(
          eq(taskDependencies.id, existing.id),
          isNull(taskDependencies.syncAction),
        )).run();
        continue;
      }

      const insertResult = tx.insert(taskDependencies).values({
        id: randomUUID(),
        taskId: blocked.id,
        dependsOnTaskId: blocker.id,
        type: 'blocks',
        connectorInstanceId,
        syncStatus: 'synced',
        syncAction: null,
        syncError: null,
        lastSyncedAt,
        createdAt: lastSyncedAt,
      }).onConflictDoNothing().run();
      imported += insertResult.changes;
    }

    const advanced = tx.update(dependencyReconciliationSnapshots).set({
      status: 'running',
      phase: 'reconciling',
      cursor: batchEnd,
      failureCount: 0,
      failedAt: null,
      nextAttemptAt: null,
      failureReason: null,
      importedCount: sql`${dependencyReconciliationSnapshots.importedCount} + ${imported}`,
      updatedAt: lastSyncedAt,
    }).where(and(
      eq(dependencyReconciliationSnapshots.id, snapshot.id),
      eq(dependencyReconciliationSnapshots.cursor, batchStart),
      inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
      eq(dependencyReconciliationSnapshots.identityMode, snapshot.identityMode),
      eq(
        dependencyReconciliationSnapshots.identityModeRevision,
        snapshot.identityModeRevision,
      ),
    )).run();
    if (advanced.changes !== 1) {
      throw new Error('Dependency snapshot cursor CAS failed');
    }
    return true;
  });
  if (!applied) return 0;

  syncLogger.info({
    connectorId: connectorInstanceId,
    dependencySnapshotId: snapshot.id,
    batchStart,
    batchEnd,
    processed: batchEnd,
    total: snapshot.total,
    verified: verifiedSourceIds.length,
    imported,
  }, 'Dependency reconciliation batch completed');
  return imported;
}

async function finalizeSnapshot(
  connectorInstanceId: string,
  connectorType: string,
  snapshot: DependencySnapshot,
  identityComparison?: GitHubIdentityComparisonRuntime,
): Promise<{ snapshot: DependencySnapshot; removed: number }> {
  const [connectorTasks, stagedEdges, verifiedItems, candidateRows] = await Promise.all([
    db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorInstanceId: tasks.connectorInstanceId,
      isChecklistItem: tasks.isChecklistItem,
      metadata: tasks.metadata,
    }).from(tasks).where(eq(tasks.connectorInstanceId, connectorInstanceId)),
    db.select().from(dependencyReconciliationEdges).where(
      eq(dependencyReconciliationEdges.snapshotId, snapshot.id),
    ),
    db.select({
      sourceId: dependencyReconciliationItems.sourceId,
      evidence: dependencyReconciliationItems.identityEvidence,
      state: dependencyReconciliationItems.identityEvidenceState,
    })
      .from(dependencyReconciliationItems)
      .where(and(
        eq(dependencyReconciliationItems.snapshotId, snapshot.id),
        eq(dependencyReconciliationItems.verified, true),
      )),
    db.select({ dependencyId: dependencyReconciliationCandidates.dependencyId })
      .from(dependencyReconciliationCandidates)
      .where(eq(dependencyReconciliationCandidates.snapshotId, snapshot.id)),
  ]);
  const nativeTasks = connectorTasks.filter((task) =>
    isNativeDependencyTask(task, connectorType));
  const taskById = new Map(nativeTasks.map((task) => [task.id, task]));
  const taskBySourceId = new Map(nativeTasks.map((task) => [task.sourceId, task]));
  const taskIds = nativeTasks.map((task) => task.id);
  const taskIdSet = new Set(taskIds);
  const verifiedSourceIds = new Set(verifiedItems.map((item) => item.sourceId));
  const candidateIds = new Set(candidateRows.map((row) => row.dependencyId));
  const remoteKeys = new Set<string>();
  const unresolvedBlockedSourceIds = new Set<string>();
  const frozenIdentityMode: GitHubIdentityModeSnapshot = {
    connectorInstanceId,
    phase: null,
    effectiveMode: snapshot.identityMode,
    stablePrimaryEnabled: snapshot.identityMode === 'stable',
    modeRevision: snapshot.identityModeRevision,
    capturedAt: snapshot.startedAt,
  };
  const identityObservation = observeDependencyIdentity(
    connectorInstanceId,
    frozenIdentityMode,
    {
      dependencies: stagedEdges.map((edge) => ({
        blockerSourceId: edge.blockerSourceId,
        blockedSourceId: edge.blockedSourceId,
        blockerIdentityEvidence: edge.blockerIdentityEvidence ?? undefined,
        blockerIdentityEvidenceState: edge.blockerIdentityEvidenceState,
      })),
      completeBlockedSourceIds: verifiedItems.map(({ sourceId }) => sourceId),
      blockedIdentityEvidence: verifiedItems.map(({ sourceId, evidence, state }) => ({
        sourceId,
        evidence: evidence ?? undefined,
        state,
      })),
    },
    taskBySourceId,
    identityComparison,
  );
  const identityEvidenceEligible = snapshot.identityEvidenceSource === 'graphql-node'
    && identityObservation.evidenceEligible;
  const identityEvidenceFailureReason = identityEvidenceEligible
    ? null
    : snapshot.identityEvidenceFailureReason ?? identityObservation.failureReason;
  const deletionEligibleSourceIds = snapshot.identityMode !== 'legacy'
    ? new Set([...verifiedSourceIds].filter((sourceId) =>
        isDependencyDecisionEligible(
          identityObservation.decisionsBySourceId.get(sourceId),
        )))
    : verifiedSourceIds;
  const deletionEligibleTaskIds = snapshot.identityMode === 'stable'
    ? new Set([...deletionEligibleSourceIds].flatMap((sourceId) => {
        const id = identityObservation.decisionsBySourceId.get(sourceId)?.selectedLocalId;
        return id ? [id] : [];
      }))
    : new Set<string>();
  const stableEdges: Array<{ blocker: DependencyTask; blocked: DependencyTask }> = [];
  const unresolvedBlockedTaskIds = new Set<string>();

  for (const edge of stagedEdges) {
    const blocker = snapshot.identityMode === 'stable'
      ? taskById.get(
          identityObservation.decisionsBySourceId.get(edge.blockerSourceId)
            ?.selectedLocalId ?? '',
        )
      : taskBySourceId.get(edge.blockerSourceId);
    const blocked = snapshot.identityMode === 'stable'
      ? taskById.get(
          identityObservation.decisionsBySourceId.get(edge.blockedSourceId)
            ?.selectedLocalId ?? '',
        )
      : taskBySourceId.get(edge.blockedSourceId);
    if (blocker && blocked) {
      remoteKeys.add(`${blocker.id}\u0000${blocked.id}`);
      if (snapshot.identityMode === 'stable') stableEdges.push({ blocker, blocked });
    } else {
      unresolvedBlockedSourceIds.add(edge.blockedSourceId);
      if (blocked) unresolvedBlockedTaskIds.add(blocked.id);
    }
  }

  let localDependencies: DependencyRecord[] = [];
  if (taskIds.length > 0) {
    localDependencies = await db.select().from(taskDependencies).where(and(
      inArray(taskDependencies.taskId, taskIds),
      eq(taskDependencies.type, 'blocks'),
    )) as DependencyRecord[];
    localDependencies = localDependencies.filter((dependency) =>
      taskIdSet.has(dependency.dependsOnTaskId));
  }

  const completedAt = new Date().toISOString();
  const retainedSnapshotIds = await getTerminalSnapshotIdsToRetain(
    connectorInstanceId,
    snapshot.id,
  );
  if (verifiedSourceIds.size !== snapshot.total) {
    const failureReason = `${snapshot.total - verifiedSourceIds.size} source task(s) could not be verified; dependency removals skipped`;
    let prunedSnapshots = 0;
    const partialApplied = runTransaction((tx) => {
      if (!validateDependencySnapshotMutationInTransaction(
        tx,
        snapshot,
        { cursor: snapshot.cursor, now: completedAt },
      )) return false;
      const changed = tx.update(dependencyReconciliationSnapshots).set({
        status: 'partial',
        phase: 'completed',
        updatedAt: completedAt,
        failedAt: completedAt,
        nextAttemptAt: null,
        failureReason,
        identityEvidenceEligible: false,
        identityComparisonRunId: identityObservation.comparisonRunId,
        identityEvidenceFailureReason:
          identityEvidenceFailureReason ?? 'dependency_remote_verification_incomplete',
      }).where(and(
        eq(dependencyReconciliationSnapshots.id, snapshot.id),
        inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
        gte(dependencyReconciliationSnapshots.cursor, snapshot.total),
        eq(dependencyReconciliationSnapshots.identityMode, snapshot.identityMode),
        eq(
          dependencyReconciliationSnapshots.identityModeRevision,
          snapshot.identityModeRevision,
        ),
      )).run();
      if (changed.changes !== 1) {
        throw new Error('Dependency partial completion CAS failed');
      }
      prunedSnapshots = tx.delete(dependencyReconciliationSnapshots).where(and(
        eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
        inArray(dependencyReconciliationSnapshots.status, ['completed', 'partial']),
        notInArray(dependencyReconciliationSnapshots.id, retainedSnapshotIds),
      )).run().changes;
      return true;
    });
    if (!partialApplied) {
      return {
        snapshot: identityContextFencedSnapshot(snapshot, completedAt),
        removed: 0,
      };
    }
    const partial: DependencySnapshot = {
      ...snapshot,
      status: 'partial',
      phase: 'completed',
      updatedAt: completedAt,
      failedAt: completedAt,
      nextAttemptAt: null,
      failureReason,
      identityEvidenceEligible: false,
      identityComparisonRunId: identityObservation.comparisonRunId,
      identityEvidenceFailureReason:
        identityEvidenceFailureReason ?? 'dependency_remote_verification_incomplete',
    };
    syncLogger.warn({
      connectorId: connectorInstanceId,
      dependencySnapshotId: snapshot.id,
      total: snapshot.total,
      verified: verifiedSourceIds.size,
      imported: partial.importedCount,
      prunedSnapshots,
    }, 'Partial dependency reconciliation generation completed without removals');
    return { snapshot: partial, removed: 0 };
  }

  // Decide the finalization mutations before acquiring the writer lock so the
  // transaction only executes a bounded number of set-based statements.
  const insertableEdges = snapshot.identityMode === 'stable'
    ? stableEdges.map(({ blocker, blocked }) => ({
      id: randomUUID(),
      taskId: blocked.id,
      dependsOnTaskId: blocker.id,
      type: 'blocks' as const,
      connectorInstanceId,
      syncStatus: 'synced' as const,
      syncAction: null,
      syncError: null,
      lastSyncedAt: completedAt,
      createdAt: completedAt,
    }))
    : [];
  const removableDependencyIds = localDependencies.filter((dependency) => {
    if (
      dependency.connectorInstanceId !== connectorInstanceId
      || dependency.syncAction
      || dependency.syncStatus !== 'synced'
      || !candidateIds.has(dependency.id)
    ) return false;
    const blocked = taskById.get(dependency.taskId);
    if (!blocked) return false;
    if (
      snapshot.identityMode === 'stable'
        ? !deletionEligibleTaskIds.has(blocked.id)
          || unresolvedBlockedTaskIds.has(blocked.id)
        : !deletionEligibleSourceIds.has(blocked.sourceId)
          || unresolvedBlockedSourceIds.has(blocked.sourceId)
    ) return false;
    return !remoteKeys.has(`${dependency.dependsOnTaskId}\u0000${dependency.taskId}`);
  }).map((dependency) => dependency.id);

  let removed = 0;
  let imported = 0;
  let prunedSnapshots = 0;
  const finalized = runTransaction((tx) => {
    if (!validateDependencySnapshotMutationInTransaction(
      tx,
      snapshot,
      { cursor: snapshot.cursor, now: completedAt },
    )) return false;
    for (
      let index = 0;
      index < insertableEdges.length;
      index += DEPENDENCY_FINALIZE_INSERT_CHUNK_SIZE
    ) {
      imported += tx.insert(taskDependencies).values(
        insertableEdges.slice(index, index + DEPENDENCY_FINALIZE_INSERT_CHUNK_SIZE),
      ).onConflictDoNothing().run().changes;
    }
    for (
      let index = 0;
      index < removableDependencyIds.length;
      index += DEPENDENCY_FINALIZE_DELETE_CHUNK_SIZE
    ) {
      removed += tx.delete(taskDependencies).where(and(
        inArray(
          taskDependencies.id,
          removableDependencyIds.slice(index, index + DEPENDENCY_FINALIZE_DELETE_CHUNK_SIZE),
        ),
        eq(taskDependencies.connectorInstanceId, connectorInstanceId),
        eq(taskDependencies.syncStatus, 'synced'),
        isNull(taskDependencies.syncAction),
      )).run().changes;
    }

    const completed = tx.update(dependencyReconciliationSnapshots).set({
      status: 'completed',
      phase: 'completed',
      identityEvidenceEligible,
      identityComparisonRunId: identityObservation.comparisonRunId,
      identityEvidenceFailureReason,
      importedCount: sql`${dependencyReconciliationSnapshots.importedCount} + ${imported}`,
      removedCount: sql`${dependencyReconciliationSnapshots.removedCount} + ${removed}`,
      completedAt,
      updatedAt: completedAt,
      failedAt: null,
      nextAttemptAt: null,
      failureReason: null,
    }).where(and(
      eq(dependencyReconciliationSnapshots.id, snapshot.id),
      inArray(dependencyReconciliationSnapshots.status, ['running', 'failed']),
      gte(dependencyReconciliationSnapshots.cursor, snapshot.total),
      eq(dependencyReconciliationSnapshots.identityMode, snapshot.identityMode),
      eq(
        dependencyReconciliationSnapshots.identityModeRevision,
        snapshot.identityModeRevision,
      ),
    )).run();
    if (completed.changes !== 1) {
      throw new Error('Dependency finalization CAS failed');
    }
    prunedSnapshots = tx.delete(dependencyReconciliationSnapshots).where(and(
      eq(dependencyReconciliationSnapshots.connectorInstanceId, connectorInstanceId),
      inArray(dependencyReconciliationSnapshots.status, ['completed', 'partial']),
      notInArray(dependencyReconciliationSnapshots.id, retainedSnapshotIds),
    )).run().changes;
    return true;
  });
  if (!finalized) {
    return {
      snapshot: identityContextFencedSnapshot(snapshot, completedAt),
      removed: 0,
    };
  }

  const completed: DependencySnapshot = {
    ...snapshot,
    status: 'completed',
    phase: 'completed',
    removedCount: snapshot.removedCount + removed,
    importedCount: snapshot.importedCount + imported,
    completedAt,
    updatedAt: completedAt,
    failedAt: null,
    nextAttemptAt: null,
    failureReason: null,
    identityEvidenceEligible,
    identityComparisonRunId: identityObservation.comparisonRunId,
    identityEvidenceFailureReason,
  };
  syncLogger.info({
    connectorId: connectorInstanceId,
    dependencySnapshotId: snapshot.id,
    total: snapshot.total,
    imported: completed.importedCount,
    removed,
    prunedSnapshots,
    completedAt,
  }, 'Dependency reconciliation generation completed');
  return { snapshot: completed, removed };
}

export async function reconcileTaskDependencies(
  connectorInstanceId: string,
  connector: IConnector,
  options: ReconcileOptions = {},
): Promise<DependencyReconciliationResult> {
  return withConnectorDependencyLock(connectorInstanceId, () =>
    reconcileTaskDependenciesUnlocked(connectorInstanceId, connector, options));
}

async function reconcileTaskDependenciesUnlocked(
  connectorInstanceId: string,
  connector: IConnector,
  options: ReconcileOptions,
): Promise<DependencyReconciliationResult> {
  const capabilities = await getConnectorCapabilities(connectorInstanceId);
  const resumeSnapshot = options.resumeGenerationId
    ? await loadActiveSnapshot(connectorInstanceId)
    : undefined;
  if (
    options.resumeGenerationId
    && resumeSnapshot?.id !== options.resumeGenerationId
  ) {
    return {
      imported: 0,
      removed: 0,
      pushed: 0,
      failed: 0,
      resumeSkippedReason: 'snapshot-no-longer-active',
    };
  }
  const connectorTasks = await db.select({
    id: tasks.id,
    sourceId: tasks.sourceId,
    connectorInstanceId: tasks.connectorInstanceId,
    isChecklistItem: tasks.isChecklistItem,
    metadata: tasks.metadata,
  }).from(tasks).where(eq(tasks.connectorInstanceId, connectorInstanceId));
  const nativeTasks = connectorTasks
    .filter((task) => isNativeDependencyTask(task, connector.type))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (nativeTasks.length === 0) {
    const emptySnapshot = connector.dependencySnapshotStrategy === 'task-stream'
      ? resumeSnapshot ?? await loadActiveSnapshot(connectorInstanceId)
      : undefined;
    if (
      options.full === true
      && emptySnapshot
      && emptySnapshot.phase !== 'collecting'
      && emptySnapshot.total === 0
    ) {
      if (connector.type === 'github-issues') {
        const currentIdentityContext = getGitHubIdentityModeSnapshot(connectorInstanceId);
        if (!dependencyIdentityContextMatches(emptySnapshot, currentIdentityContext)) {
          const fenced = await abandonSnapshotForIdentityContextChange(
            emptySnapshot,
            currentIdentityContext,
          );
          return {
            imported: 0,
            removed: 0,
            pushed: 0,
            failed: 0,
            resumeSkippedReason: 'identity-context-changed',
            snapshot: snapshotProgress(fenced, undefined),
          };
        }
      }
      const finalized = await finalizeSnapshot(
        connectorInstanceId,
        connector.type,
        emptySnapshot,
        options.identityComparison,
      );
      return {
        imported: 0,
        removed: finalized.removed,
        pushed: 0,
        failed: 0,
        snapshot: snapshotProgress(
          finalized.snapshot,
          finalized.snapshot,
        ),
      };
    }
    return { imported: 0, removed: 0, pushed: 0, failed: 0 };
  }

  const taskById = new Map(nativeTasks.map((task) => [task.id, task]));
  const taskBySourceId = new Map(nativeTasks.map((task) => [task.sourceId, task]));
  const taskIds = nativeTasks.map((task) => task.id);
  const taskIdSet = new Set(taskIds);
  let localDependencies = await db.select().from(taskDependencies).where(and(
    inArray(taskDependencies.taskId, taskIds),
    eq(taskDependencies.type, 'blocks'),
  )) as DependencyRecord[];
  localDependencies = localDependencies.filter((dependency) =>
    taskIdSet.has(dependency.dependsOnTaskId));

  const retryResult = capabilities?.dependencyWrite && !options.skipPendingRetry
    ? await retryPendingActions(
        connectorInstanceId,
        connector,
        localDependencies,
        taskById,
      )
    : { pushed: 0, failed: 0 };
  if (
    options.full !== true
    || !capabilities?.dependencyRead
    || (
      connector.dependencySnapshotStrategy !== 'task-stream'
      && !connector.fetchTaskDependencies
    )
  ) {
    return {
      imported: 0,
      removed: 0,
      pushed: retryResult.pushed,
      failed: retryResult.failed,
    };
  }

  let snapshot = resumeSnapshot ?? await loadActiveSnapshot(connectorInstanceId);
  if (!snapshot) {
    if (connector.dependencySnapshotStrategy === 'task-stream') {
      return {
        imported: 0,
        removed: 0,
        pushed: retryResult.pushed,
        failed: retryResult.failed,
      };
    }
    snapshot = await createSnapshot(
      connectorInstanceId,
      nativeTasks.map((task) => task.sourceId),
      connector.type === 'github-issues'
        ? getGitHubIdentityModeSnapshot(connectorInstanceId)
        : undefined,
    );
  }
  const lastCompletedSnapshot = await getLastCompletedSnapshot(connectorInstanceId);
  if (connector.type === 'github-issues') {
    const currentIdentityContext = getGitHubIdentityModeSnapshot(connectorInstanceId);
    if (!dependencyIdentityContextMatches(snapshot, currentIdentityContext)) {
      const fenced = await abandonSnapshotForIdentityContextChange(
        snapshot,
        currentIdentityContext,
      );
      return {
        imported: 0,
        removed: 0,
        pushed: retryResult.pushed,
        failed: retryResult.failed,
        resumeSkippedReason: 'identity-context-changed',
        snapshot: snapshotProgress(fenced, lastCompletedSnapshot),
      };
    }
  }

  if (snapshot.phase === 'collecting') {
    return {
      imported: 0,
      removed: 0,
      pushed: retryResult.pushed,
      failed: retryResult.failed,
      snapshot: snapshotProgress(snapshot, lastCompletedSnapshot),
    };
  }

  if (
    snapshot.status === 'failed'
    && snapshot.nextAttemptAt
    && snapshot.nextAttemptAt > new Date().toISOString()
  ) {
    syncLogger.info({
      connectorId: connectorInstanceId,
      dependencySnapshotId: snapshot.id,
      processed: snapshot.cursor,
      total: snapshot.total,
      nextAttemptAt: snapshot.nextAttemptAt,
    }, 'Dependency reconciliation retry deferred by backoff');
    return {
      imported: 0,
      removed: 0,
      pushed: retryResult.pushed,
      failed: retryResult.failed,
      snapshot: snapshotProgress(snapshot, lastCompletedSnapshot),
    };
  }

  if (snapshot.cursor >= snapshot.total) {
    const finalized = await finalizeSnapshot(
      connectorInstanceId,
      connector.type,
      snapshot,
      options.identityComparison,
    );
    return {
      imported: 0,
      removed: finalized.removed,
      pushed: retryResult.pushed,
      failed: retryResult.failed,
      snapshot: snapshotProgress(finalized.snapshot, finalized.snapshot),
    };
  }

  const batchEnd = Math.min(snapshot.cursor + snapshot.batchSize, snapshot.total);
  const batchItems = await db.select().from(dependencyReconciliationItems)
    .where(and(
      eq(dependencyReconciliationItems.snapshotId, snapshot.id),
      gte(dependencyReconciliationItems.position, snapshot.cursor),
      lt(dependencyReconciliationItems.position, batchEnd),
    ))
    .orderBy(asc(dependencyReconciliationItems.position));
  const batchSourceIds = batchItems.map((item) => item.sourceId);
  if (batchSourceIds.length !== batchEnd - snapshot.cursor) {
    const error = new Error(
      `Dependency snapshot ${snapshot.id} is missing persisted source items`,
    );
    snapshot = await markSnapshotFailed(snapshot, error);
    throw error;
  }

  const usesStagedGeneration = snapshot.readMode === 'graphql-bulk'
    || snapshot.readMode === 'rest-fallback';
  let remoteSnapshot: Awaited<ReturnType<typeof fetchDependencySnapshot>>;
  if (usesStagedGeneration) {
    const [stagedEdges, verifiedItems] = await Promise.all([
      db.select({
        blockerSourceId: dependencyReconciliationEdges.blockerSourceId,
        blockedSourceId: dependencyReconciliationEdges.blockedSourceId,
        blockerIdentityEvidence: dependencyReconciliationEdges.blockerIdentityEvidence,
        blockerIdentityEvidenceState:
          dependencyReconciliationEdges.blockerIdentityEvidenceState,
      }).from(dependencyReconciliationEdges).where(and(
        eq(dependencyReconciliationEdges.snapshotId, snapshot.id),
        inArray(dependencyReconciliationEdges.blockedSourceId, batchSourceIds),
      )),
      db.select({
        sourceId: dependencyReconciliationItems.sourceId,
        evidence: dependencyReconciliationItems.identityEvidence,
        state: dependencyReconciliationItems.identityEvidenceState,
      }).from(dependencyReconciliationItems).where(and(
        eq(dependencyReconciliationItems.snapshotId, snapshot.id),
        inArray(dependencyReconciliationItems.sourceId, batchSourceIds),
        eq(dependencyReconciliationItems.verified, true),
      )),
    ]);
    remoteSnapshot = {
      dependencies: stagedEdges.map((edge) => ({
        ...edge,
        blockerIdentityEvidence: edge.blockerIdentityEvidence ?? undefined,
      })),
      completeBlockedSourceIds: verifiedItems.map(({ sourceId }) => sourceId),
      blockedIdentityEvidence: verifiedItems.map(({ sourceId, evidence, state }) => ({
        sourceId,
        evidence: evidence ?? undefined,
        state,
      })),
    };
  } else {
    try {
      remoteSnapshot = await fetchDependencySnapshot(connector, batchSourceIds);
    } catch (error) {
      await markSnapshotFailed(snapshot, error);
      throw error;
    }
  }

  localDependencies = await db.select().from(taskDependencies).where(and(
    inArray(taskDependencies.taskId, taskIds),
    eq(taskDependencies.type, 'blocks'),
  )) as DependencyRecord[];
  localDependencies = localDependencies.filter((dependency) =>
    taskIdSet.has(dependency.dependsOnTaskId));
  const imported = await applySnapshotBatch(
    connectorInstanceId,
    snapshot,
    snapshot.cursor,
    batchEnd,
    batchSourceIds,
    remoteSnapshot,
    taskBySourceId,
    localDependencies,
    !usesStagedGeneration,
  );

  const refreshed = await db.select().from(dependencyReconciliationSnapshots)
    .where(eq(dependencyReconciliationSnapshots.id, snapshot.id))
    .limit(1);
  snapshot = refreshed[0] ?? {
    ...snapshot,
    cursor: batchEnd,
    importedCount: snapshot.importedCount + imported,
  };
  let removed = 0;
  if (snapshot.cursor >= snapshot.total && snapshot.status !== 'completed') {
    const finalized = await finalizeSnapshot(
      connectorInstanceId,
      connector.type,
      snapshot,
      options.identityComparison,
    );
    snapshot = finalized.snapshot;
    removed = finalized.removed;
  }

  if (
    usesStagedGeneration
    && snapshot.status === 'running'
    && snapshot.cursor < snapshot.total
  ) {
    const continued = await reconcileTaskDependenciesUnlocked(
      connectorInstanceId,
      connector,
      { ...options, skipPendingRetry: true },
    );
    return {
      imported: imported + continued.imported,
      removed: removed + continued.removed,
      pushed: retryResult.pushed + continued.pushed,
      failed: retryResult.failed + continued.failed,
      snapshot: continued.snapshot,
      resumeSkippedReason: continued.resumeSkippedReason,
    };
  }

  return {
    imported,
    removed,
    pushed: retryResult.pushed,
    failed: retryResult.failed,
    snapshot: snapshotProgress(
      snapshot,
      snapshot.status === 'completed' ? snapshot : lastCompletedSnapshot,
    ),
  };
}
