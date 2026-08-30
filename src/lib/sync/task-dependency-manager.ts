import 'server-only';

import { randomUUID } from 'crypto';
import type { IConnector } from '@/lib/connectors';
import { getConnectorCapabilities } from '@/lib/connectors/capabilities';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { GitHubStableIdentityRuntime } from '@/lib/external-identities/stable-identity-runtime';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityResolutionDecision,
} from '@/lib/external-identities/stable-identity-types';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import { getGitHubIdentityRepository } from '@/lib/external-identities/worker-persistence';
import { syncLogger } from '@/lib/logger';
import {
  runResumableReconciliation,
  type ReconciliationFailure,
} from '@/lib/reconciliation';
import { executeFencedGitHubTaskMutation } from '@/lib/external-identities/github-write-fence';
import { isConnectorNativeTask } from './github-native-task';
import type {
  SourceTaskDependencyGenerationWriter,
  SourceTaskDependencyReadMode,
  SourceTaskDependencySnapshot,
} from '@/types';
import { fetchDependencySnapshot } from './dependency-snapshot';
import type {

  DependencySnapshotEdgeRecord,
  DependencySnapshotFence,
  DependencySnapshotInsert,
  DependencySnapshotItemInsert,
  DependencySnapshotRecord,
  TaskDependencyInsert,
} from '@/db/persistence/github-dependencies';
import { getGitHubDependencyRepository } from './github-worker-persistence';

/**
 * Resolves the frozen GitHub identity epoch for a connector through the
 * backend-neutral identity port. Mirrors the legacy synchronous
 * `getGitHubIdentityModeSnapshot(connectorInstanceId)`.
 */
async function getModeSnapshot(
  connectorInstanceId: string,
): Promise<GitHubIdentityModeSnapshot> {
  const identity = await getGitHubIdentityRepository();
  return identity.getModeSnapshot(connectorInstanceId, new Date().toISOString());
}

function snapshotFence(snapshot: DependencySnapshotRecord): DependencySnapshotFence {
  return {
    id: snapshot.id,
    connectorInstanceId: snapshot.connectorInstanceId,
    identityMode: snapshot.identityMode,
    identityModeRevision: snapshot.identityModeRevision,
  };
}

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
  identityMode: string;
  identityModeRevision: number;
  identityEvidenceSource: 'graphql-node' | 'rest-unavailable' | 'legacy-unavailable';
  identityEvidenceEligible: boolean;
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
  identityMode: string;
  identityModeRevision: number;
  identityEvidenceSource: 'graphql-node' | 'rest-unavailable' | 'legacy-unavailable';
  identityEvidenceEligible: boolean;
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

type DependencySnapshot = DependencySnapshotRecord;
interface DependencyReconciliationBatch {
  sourceIds: string[];
  usesStagedGeneration: boolean;
}

interface DependencyReconciliationBatchResult extends DependencyReconciliationBatch {
  remoteSnapshot: Awaited<ReturnType<typeof fetchDependencySnapshot>>;
  imported: number;
}

type ReconcileOptions = {
  full?: boolean;
  resumeGenerationId?: string;
  skipPendingRetry?: boolean;
  identityRuntime?: GitHubStableIdentityRuntime;
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
  frozen: Pick<DependencySnapshot, 'identityModeRevision'>,
  current: GitHubIdentityModeSnapshot,
): boolean {
  return current.modeRevision === frozen.identityModeRevision;
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
  const dependencies = await getGitHubDependencyRepository();
  await dependencies.updateDependencySync({
    id,
    syncStatus: 'failed',
    syncAction: action,
    syncError: dependencyError(error),
  });
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
  const dependencies = await getGitHubDependencyRepository();
  const currentDependency = await dependencies.getDependencyById(dependency.id);
  if (!currentDependency) return dependency;

  let connector: IConnector | null;
  try {
    const capabilities = await getConnectorCapabilities(blocker.connectorInstanceId);
    if (!capabilities?.dependencyWrite) return dependency;
    connector = await getOrInitializeConnector(blocker.connectorInstanceId);
    if (!connector?.addTaskDependency) return dependency;
  } catch (error) {
    await dependencies.updateDependencySync({
      id: dependency.id,
      connectorInstanceId: blocker.connectorInstanceId,
      syncStatus: 'failed',
      syncAction: 'create',
      syncError: dependencyError(error),
    });
    return {
      ...dependency,
      connectorInstanceId: blocker.connectorInstanceId,
      syncStatus: 'failed',
      syncAction: 'create',
      syncError: dependencyError(error),
    };
  }

  await dependencies.updateDependencySync({
    id: dependency.id,
    connectorInstanceId: blocker.connectorInstanceId,
    syncStatus: 'pending',
    syncAction: 'create',
    syncError: null,
  });

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
    await dependencies.updateDependencySync({
      id: dependency.id,
      syncStatus: synced.syncStatus,
      syncAction: synced.syncAction,
      syncError: synced.syncError,
      lastSyncedAt,
    });
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
  const dependencies = await getGitHubDependencyRepository();
  if (!connectorInstanceId || dependency.type !== 'blocks') {
    await dependencies.deleteDependencyById(dependency.id);
    return { deleted: true };
  }
  return withConnectorDependencyLock(connectorInstanceId, async () => {
    const currentDependency = await dependencies.getDependencyById(dependency.id);
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
  const dependencies = await getGitHubDependencyRepository();
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

  await dependencies.updateDependencySync({
    id: dependency.id,
    syncStatus: 'pending',
    syncAction: 'delete',
    syncError: null,
  });

  try {
    await writeDependency(connector, blocker, blocked, 'delete');
    await dependencies.deleteDependencyById(dependency.id);
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
  const repository = await getGitHubDependencyRepository();
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
        await repository.updateDependencySync({
          id: dependency.id,
          syncStatus: 'synced',
          syncAction: null,
          syncError: null,
          lastSyncedAt: new Date().toISOString(),
        });
      } else {
        if (!connector.removeTaskDependency) throw new Error('Connector cannot remove dependencies');
        await writeDependency(connector, blocker, blocked, 'delete');
        await repository.deleteDependencyById(dependency.id);
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
  const repository = await getGitHubDependencyRepository();
  return (await repository.getLastCompletedSnapshot(connectorInstanceId)) ?? undefined;
}

async function getTerminalSnapshotIdsToRetain(
  connectorInstanceId: string,
  currentSnapshotId: string,
): Promise<string[]> {
  const repository = await getGitHubDependencyRepository();
  return repository.getTerminalSnapshotIdsToRetain({
    connectorInstanceId,
    currentSnapshotId,
    maxHistory: MAX_TERMINAL_SNAPSHOT_HISTORY,
  });
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

export async function getDependencyReconciliationHealth(
  connectorInstanceIds?: string[],
  shouldDefer?: () => boolean,
): Promise<
  Map<string, DependencyReconciliationProgress>
> {
  if (connectorInstanceIds?.length === 0) return new Map();
  if (shouldDefer?.()) return new Map();
  const repository = await getGitHubDependencyRepository();
  const [latestRows, completedRows] = await Promise.all([
    repository.getHealthLatestSnapshots(connectorInstanceIds),
    repository.getHealthCompletedSnapshots(connectorInstanceIds),
  ]);
  if (shouldDefer?.()) return new Map();
  const relevantSnapshotIds = Array.from(new Set([
    ...latestRows.map((row) => row.id),
    ...completedRows.map((row) => row.id),
  ]));
  const [edgeCountRows, terminalRows] = await Promise.all([
    relevantSnapshotIds.length === 0
      ? Promise.resolve([])
      : repository.countEdgesBySnapshotIds(relevantSnapshotIds),
    repository.getHealthTerminalStatuses(connectorInstanceIds),
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
  const repository = await getGitHubDependencyRepository();
  const snapshot = await repository.getLastCompletedSnapshot(connectorInstanceId);
  if (!snapshot) return undefined;
  const edgeCount = await repository.countSnapshotEdges(snapshot.id);
  return snapshotProgress(
    snapshot,
    snapshot,
    new Map([[snapshot.id, Number(edgeCount ?? 0)]]),
  );
}

export async function* streamCompletedDependencyGenerationEdges(
  generationId: string,
  batchSize = 500,
) {
  const repository = await getGitHubDependencyRepository();
  const status = await repository.getSnapshotStatus(generationId);
  if (status !== 'completed') {
    throw new Error(`Dependency generation ${generationId} is not completed`);
  }

  const size = Number.isFinite(batchSize) && batchSize > 0
    ? Math.floor(batchSize)
    : 500;
  let offset = 0;
  while (true) {
    const edges = await repository.listGenerationEdgePage({
      snapshotId: generationId,
      offset,
      limit: size,
    });
    if (edges.length === 0) return;
    yield edges;
    offset += edges.length;
  }
}

export async function getResumableDependencyReconciliations(): Promise<
  DependencyReconciliationResumeCandidate[]
> {
  const repository = await getGitHubDependencyRepository();
  const rows = await repository.getResumableReconciliations();
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
  const repository = await getGitHubDependencyRepository();
  await repository.recordResumeOutcome({
    generationId,
    outcome,
    reason,
    attemptedAt,
  });
}

async function loadActiveSnapshot(
  connectorInstanceId: string,
): Promise<DependencySnapshot | undefined> {
  const repository = await getGitHubDependencyRepository();
  return (await repository.loadActiveSnapshot(connectorInstanceId)) ?? undefined;
}

async function getDependencyDeletionCandidates(
  connectorInstanceId: string,
): Promise<string[]> {
  const repository = await getGitHubDependencyRepository();
  return repository.getDeletionCandidateDependencyIds(connectorInstanceId);
}

export async function beginDependencySnapshotGeneration(
  connectorInstanceId: string,
  frozenIdentityContext?: GitHubIdentityModeSnapshot,
): Promise<SourceTaskDependencyGenerationWriter | undefined> {
  const frozen = frozenIdentityContext
    ?? await getModeSnapshot(connectorInstanceId);
  if (frozen.connectorInstanceId !== connectorInstanceId) {
    throw new Error('Dependency identity context belongs to another connector');
  }
  const deps = await getGitHubDependencyRepository();
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
    const interrupted = await deps.abandonInterruptedCollection({
      fence: snapshotFence(active),
      failedAt,
    });
    if (!interrupted) {
      throw new Error('Dependency identity context changed before generation restart');
    }
  }

  const deletionCandidates = await getDependencyDeletionCandidates(connectorInstanceId);
  const now = new Date().toISOString();
  const snapshotId = randomUUID();
  const matchInsert: DependencySnapshotInsert = {
    id: snapshotId,
    connectorInstanceId,
    status: 'running',
    phase: 'collecting',
    cursor: 0,
    total: 0,
    batchSize: getStreamedDependencyBatchSize(),
    failureCount: 0,
    importedCount: 0,
    removedCount: 0,
    identityMode: frozen.effectiveMode,
    identityModeRevision: frozen.modeRevision,
    identityEvidenceSource: 'legacy-unavailable',
    identityEvidenceEligible: false,
    startedAt: now,
    updatedAt: now,
  };
  const mismatchInsert: DependencySnapshotInsert = {
    ...matchInsert,
    status: 'partial',
    phase: 'completed',
    identityEvidenceEligible: false,
    identityEvidenceFailureReason: 'dependency_identity_context_changed',
    completedAt: now,
    failedAt: now,
    failureReason: 'identity context changed before dependency generation creation',
  };

  const generationCreated = await deps.createGeneration({
    connectorInstanceId,
    frozenModeRevision: frozen.modeRevision,
    matchInsert,
    mismatchInsert,
    deletionCandidateIds: deletionCandidates,
  });
  if (!generationCreated) {
    throw new Error('Dependency identity context changed before generation creation');
  }

  const fence: DependencySnapshotFence = {
    id: snapshotId,
    connectorInstanceId,
    identityMode: frozen.effectiveMode,
    identityModeRevision: frozen.modeRevision,
  };

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
    const current = await deps.getSnapshotById(fence.id);
    if (!current || current.status !== 'running' || current.phase !== 'collecting') {
      throw new Error(`Dependency generation ${fence.id} is not collecting`);
    }
    if (current.readMode && current.readMode !== mode) {
      throw new Error(
        `Dependency generation ${fence.id} changed read mode from ${current.readMode} to ${mode}`,
      );
    }

    const sourceIds = [...new Set(remote.completeBlockedSourceIds)];
    const existingItems = sourceIds.length > 0
      ? await deps.listSnapshotItemsForSourceIds({ snapshotId: fence.id, sourceIds })
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
          `Dependency generation ${fence.id} received conflicting identity evidence for ${sourceId}`,
        );
      }
    }
    const edges = [...new Map(
      remote.dependencies
        .filter((edge) => pageSourceIds.has(edge.blockedSourceId))
        .map((edge) => [`${edge.blockerSourceId}\u0000${edge.blockedSourceId}`, edge]),
    ).values()];
    const updatedAt = new Date().toISOString();

    const newItems: DependencySnapshotItemInsert[] = newSourceIds.map((sourceId, offset) => ({
      position: current.total + offset,
      sourceId,
      verified: true,
      identityEvidence: blockedEvidenceBySourceId.get(sourceId)?.evidence ?? null,
      identityEvidenceState:
        blockedEvidenceBySourceId.get(sourceId)?.state ?? 'missing',
    }));
    const edgeRecords: DependencySnapshotEdgeRecord[] = edges.map((edge) => ({
      blockerSourceId: edge.blockerSourceId,
      blockedSourceId: edge.blockedSourceId,
      blockerIdentityEvidence: edge.blockerIdentityEvidence ?? null,
      blockerIdentityEvidenceState: edge.blockerIdentityEvidenceState ?? 'missing',
    }));

    const staged = await deps.stageCollectionPage({
      fence,
      expectedTotal: current.total,
      readMode: mode,
      identityEvidenceSource: dependencyIdentityEvidenceSource(mode),
      newItems,
      edges: edgeRecords,
      newSourceIdCount: newSourceIds.length,
      overflowFetchCount: remote.overflowFetchCount ?? 0,
      updatedAt,
    });
    if (!staged) {
      throw new Error('Dependency generation was fenced before page staging');
    }
  });

  return {
    stagePage,
    complete: (mode) => enqueue(async () => {
      const completedAt = new Date().toISOString();
      const current = await deps.getSnapshotById(fence.id);
      if (!current || current.status !== 'running' || current.phase !== 'collecting') return;
      if (current.readMode && current.readMode !== mode) {
        throw new Error(
          `Dependency generation ${fence.id} changed read mode from ${current.readMode} to ${mode}`,
        );
      }
      const evidenceSource = dependencyIdentityEvidenceSource(mode);
      const completed = await deps.completeCollection({
        fence,
        readMode: mode,
        identityEvidenceSource: evidenceSource,
        completedAt,
        deriveEvidence: (incompleteEvidenceCount) => {
          const evidenceEligible = evidenceSource === 'graphql-node'
            && incompleteEvidenceCount === 0;
          return {
            identityEvidenceEligible: evidenceEligible,
            identityEvidenceFailureReason: evidenceEligible
              ? null
              : evidenceSource === 'rest-unavailable'
                ? 'dependency_stable_evidence_unavailable'
                : 'dependency_stable_evidence_incomplete',
          };
        },
      });
      if (!completed) {
        throw new Error('Dependency generation was fenced before collection completion');
      }
      syncLogger.info({
        connectorId: connectorInstanceId,
        dependencySnapshotId: fence.id,
        dependencyReadMode: mode,
        total: current.total,
      }, 'Dependency snapshot collection completed');
    }),
    fail: (error) => enqueue(async () => {
      const failedAt = new Date().toISOString();
      const failureReason = dependencyError(error);
      const failed = await deps.failCollection({
        fence,
        failedAt,
        failureReason,
      });
      if (failed) {
        syncLogger.warn({
          err: error,
          connectorId: connectorInstanceId,
          dependencySnapshotId: fence.id,
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
  return decision?.appliedSource === 'stable';
}

async function resolveDependencyIdentity(
  connectorInstanceId: string,
  modeSnapshot: GitHubIdentityModeSnapshot,
  remote: SourceTaskDependencySnapshot,
  taskBySourceId: ReadonlyMap<string, DependencyTask>,
  providedRuntime?: GitHubStableIdentityRuntime,
): Promise<DependencyIdentityObservation> {
  if (
    providedRuntime
    && providedRuntime.modeSnapshot.modeRevision !== modeSnapshot.modeRevision
  ) {
    throw new Error('Dependency identity runtime does not match the frozen generation context');
  }

  const endpoints = [...dependencyEndpointEvidence(remote).values()]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const hasNoEndpointEvidence = endpoints.length === 0;
  const ownedRuntime = providedRuntime
    ? null
    : new GitHubStableIdentityRuntime({
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
        const decisions = await runtime.resolveBatch(
          'dependency',
          'task',
          resolvedCandidates.map((endpoint) => {
            const local = taskBySourceId.get(endpoint.sourceId);
            if (endpoint.state === 'missing') hasMissingEvidence = true;
            return {
              candidateKey: `dependency:endpoint:${endpoint.sourceId}`,
              locatorMatchedLocalIds: local ? [local.id] : [],
              boundAction: 'present' as const,
              unboundAction: 'none' as const,
              applicableStableLocalIds,
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
        const decisions = await runtime.applyResolvedBatch(
          'dependency',
          partialCandidates.map((endpoint) => {
            const local = taskBySourceId.get(endpoint.sourceId);
            return {
              candidateKey: `dependency:endpoint:${endpoint.sourceId}`,
              locatorMatchedLocalIds: local ? [local.id] : [],
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
    if (hasNoEndpointEvidence) runtime.markBlocked('dependency_endpoint_evidence_empty');
    if (hasMissingEvidence) runtime.markBlocked('dependency_stable_evidence_missing');
    if (hasPartialEvidence) runtime.markBlocked('dependency_stable_evidence_partial');
    await runtime.assertDecisionsCurrent(decisionsBySourceId.values());
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
              ? 'dependency_identity_resolution_blocked'
              : null,
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
  identityRuntime?: GitHubStableIdentityRuntime,
): Promise<{ imported: number; removed: number }> {
  return withConnectorDependencyLock(connectorInstanceId, async () => {
    const verifiedSourceIds = new Set(
      remote.completeBlockedSourceIds.filter((sourceId) =>
        observedSourceIds.has(sourceId) && /^[^/:]+\/[^/:]+:\d+$/.test(sourceId)),
    );
    if (verifiedSourceIds.size === 0) return { imported: 0, removed: 0 };

    const deps = await getGitHubDependencyRepository();
    const connectorTasks = await deps.listConnectorTasks(connectorInstanceId);
    const nativeTasks = connectorTasks.filter((task) =>
      isNativeDependencyTask(task, 'github-issues'));
    const taskById = new Map(nativeTasks.map((task) => [task.id, task]));
    const taskBySourceId = new Map(nativeTasks.map((task) => [task.sourceId, task]));
    const identityMode = await getModeSnapshot(connectorInstanceId);
    const identityObservation = await resolveDependencyIdentity(
      connectorInstanceId,
      identityMode,
      remote,
      taskBySourceId,
      identityRuntime,
    );
    const deletionEligibleSourceIds = new Set(
      [...verifiedSourceIds].filter((sourceId) =>
        isDependencyDecisionEligible(
          identityObservation.decisionsBySourceId.get(sourceId),
        )),
    );
    const deletionEligibleTaskIds = new Set(
      [...deletionEligibleSourceIds].flatMap((sourceId) => {
        const id = identityObservation.decisionsBySourceId.get(sourceId)?.selectedLocalId;
        return id ? [id] : [];
      }),
    );
    const blockedTaskIds = [...verifiedSourceIds]
      .map((sourceId) =>
        identityObservation.decisionsBySourceId.get(sourceId)?.selectedLocalId)
      .filter((id): id is string => Boolean(id));
    if (blockedTaskIds.length === 0) return { imported: 0, removed: 0 };

    const localDependencies = await deps.listBlocksDependenciesForTasks(blockedTaskIds);
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
      const blocker = taskById.get(
        identityObservation.decisionsBySourceId.get(edge.blockerSourceId)?.selectedLocalId ?? '',
      );
      const blocked = taskById.get(
        identityObservation.decisionsBySourceId.get(edge.blockedSourceId)?.selectedLocalId ?? '',
      );
      if (!blocker || !blocked) {
        unresolvedBlockedSourceIds.add(edge.blockedSourceId);
        if (blocked) unresolvedBlockedTaskIds.add(blocked.id);
        continue;
      }
      const key = `${blocker.id}\u0000${blocked.id}`;
      remoteKeys.add(key);
      usableEdges.push({ blocker, blocked, key });
    }

    const syncedAt = new Date().toISOString();
    const syncedUpdateIds: string[] = [];
    const inserts: TaskDependencyInsert[] = [];
    for (const { blocker, blocked, key } of usableEdges) {
      const existing = existingByKey.get(key);
      if (existing) {
        if (!existing.syncAction) syncedUpdateIds.push(existing.id);
        continue;
      }
      inserts.push({
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
      });
    }

    const deletionIds: string[] = [];
    for (const dependency of localDependencies) {
      const blocked = taskById.get(dependency.taskId);
      if (
        !blocked
        || !deletionEligibleTaskIds.has(blocked.id)
        || unresolvedBlockedTaskIds.has(blocked.id)
        || dependency.connectorInstanceId !== connectorInstanceId
        || dependency.syncStatus !== 'synced'
        || dependency.syncAction
      ) continue;
      const key = `${dependency.dependsOnTaskId}\u0000${dependency.taskId}`;
      if (remoteKeys.has(key)) continue;
      deletionIds.push(dependency.id);
    }

    const result = await deps.applyTargetedReconciliation({
      connectorInstanceId,
      expectedModeRevision: identityMode.modeRevision,
      syncedAt,
      syncedUpdateIds,
      inserts,
      deletionIds,
    });
    if (result.status === 'identity-context-changed') {
      throw new Error('Dependency identity context changed before targeted apply');
    }
    const { imported, removed } = result;

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
  const deps = await getGitHubDependencyRepository();
  const deletionCandidates = await getDependencyDeletionCandidates(connectorInstanceId);
  const now = new Date().toISOString();
  const record: DependencySnapshotRecord = {
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
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    collectionCompletedAt: null,
    collectionPageCount: 0,
    overflowFetchCount: 0,
    identityMode: frozenIdentityContext?.effectiveMode ?? 'legacy',
    identityModeRevision: frozenIdentityContext?.modeRevision ?? 0,
    identityEvidenceSource: 'legacy-unavailable',
    identityEvidenceEligible: false,
    identityEvidenceFailureReason: null,
    failedAt: null,
    nextAttemptAt: null,
    failureReason: null,
    lastResumeAttemptAt: null,
    lastResumeOutcome: null,
    lastResumeReason: null,
  };

  const items: DependencySnapshotItemInsert[] = sourceIds.map((sourceId, position) => ({
    position,
    sourceId,
    verified: false,
    identityEvidenceState: 'missing',
  }));
  const mismatchInsert: DependencySnapshotInsert = {
    ...record,
    status: 'partial',
    phase: 'completed',
    identityEvidenceEligible: false,
    identityEvidenceFailureReason: 'dependency_identity_context_changed',
    completedAt: now,
    failedAt: now,
    failureReason: 'identity context changed before dependency snapshot creation',
  };

  try {
    const created = await deps.createGeneration({
      connectorInstanceId,
      frozenModeRevision: record.identityModeRevision,
      matchInsert: record,
      mismatchInsert,
      items,
      deletionCandidateIds: deletionCandidates,
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
    dependencySnapshotId: record.id,
    total: sourceIds.length,
    batchSize: record.batchSize,
  }, 'Dependency reconciliation generation started');
  return record;
}

async function markSnapshotFailed(
  snapshot: DependencySnapshot,
  error: unknown,
  failure: ReconciliationFailure,
): Promise<DependencySnapshot> {
  const failureCount = failure.failureCount;
  const failedAt = failure.failedAt;
  const nextAttemptAt = failure.nextAttemptAt;
  const failureReason = dependencyError(error);

  const deps = await getGitHubDependencyRepository();
  const updated = await deps.markSnapshotFailed({
    fence: snapshotFence(snapshot),
    cursor: snapshot.cursor,
    failureCount,
    failedAt,
    nextAttemptAt,
    failureReason,
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
  const deps = await getGitHubDependencyRepository();
  await deps.abandonSnapshotForIdentityContextChange(
    snapshotFence(snapshot),
    failedAt,
  );
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
  const lastSyncedAt = new Date().toISOString();
  // Edges are only applied once the whole generation resolves through NodeID
  // bindings, so a batch stages evidence and imports nothing.
  const imported = 0;

  const deps = await getGitHubDependencyRepository();
  const stagedEdges: DependencySnapshotEdgeRecord[] = stageRemoteEdges
    ? usableEdges.map((edge) => ({
        blockerSourceId: edge.blockerSourceId,
        blockedSourceId: edge.blockedSourceId,
        blockerIdentityEvidence: edge.blockerIdentityEvidence ?? null,
        blockerIdentityEvidenceState: edge.blockerIdentityEvidenceState ?? 'missing',
      }))
    : [];
  // Blocked endpoints are only usable once their NodeID evidence is staged,
  // so record it alongside verification.
  const blockedEvidenceBySourceId = new Map(
    (remoteSnapshot.blockedIdentityEvidence ?? [])
      .map((entry) => [entry.sourceId, entry] as const),
  );
  const verifiedUpdates = verifiedSourceIds.map((sourceId) => {
    const evidence = blockedEvidenceBySourceId.get(sourceId);
    return evidence
      ? {
          sourceId,
          identityEvidence: evidence.evidence ?? null,
          identityEvidenceState: evidence.state ?? 'missing' as const,
        }
      : { sourceId };
  });

  const applied = await deps.applyReconciliationBatch({
    fence: snapshotFence(snapshot),
    batchStart,
    batchEnd,
    lastSyncedAt,
    stagedEdges,
    verifiedUpdates,
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
  identityRuntime?: GitHubStableIdentityRuntime,
): Promise<{ snapshot: DependencySnapshot; removed: number; imported: number }> {
  const deps = await getGitHubDependencyRepository();
  const [connectorTasks, stagedEdges, verifiedItems, candidateDependencyIds] = await Promise.all([
    deps.listConnectorTasks(connectorInstanceId),
    deps.listSnapshotEdges(snapshot.id),
    deps.listVerifiedSnapshotItems(snapshot.id),
    deps.listSnapshotCandidateDependencyIds(snapshot.id),
  ]);
  const nativeTasks = connectorTasks.filter((task) =>
    isNativeDependencyTask(task, connectorType));
  const taskById = new Map(nativeTasks.map((task) => [task.id, task]));
  const taskBySourceId = new Map(nativeTasks.map((task) => [task.sourceId, task]));
  const taskIds = nativeTasks.map((task) => task.id);
  const taskIdSet = new Set(taskIds);
  const verifiedSourceIds = new Set(verifiedItems.map((item) => item.sourceId));
  const candidateIds = new Set(candidateDependencyIds);
  const remoteKeys = new Set<string>();
  const unresolvedBlockedSourceIds = new Set<string>();
  const frozenIdentityMode: GitHubIdentityModeSnapshot = {
    connectorInstanceId,
    effectiveMode: GITHUB_IDENTITY_MODE,
    modeRevision: snapshot.identityModeRevision,
    capturedAt: snapshot.startedAt,
  };
  const identityObservation = await resolveDependencyIdentity(
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
      blockedIdentityEvidence: verifiedItems.map(
        ({ sourceId, identityEvidence, identityEvidenceState }) => ({
          sourceId,
          evidence: identityEvidence ?? undefined,
          state: identityEvidenceState,
        }),
      ),
    },
    taskBySourceId,
    identityRuntime,
  );
  const identityEvidenceEligible = snapshot.identityEvidenceSource === 'graphql-node'
    && identityObservation.evidenceEligible;
  const identityEvidenceFailureReason = identityEvidenceEligible
    ? null
    : snapshot.identityEvidenceFailureReason ?? identityObservation.failureReason;
  const deletionEligibleSourceIds = new Set(
    [...verifiedSourceIds].filter((sourceId) =>
      isDependencyDecisionEligible(
        identityObservation.decisionsBySourceId.get(sourceId),
      )),
  );
  const deletionEligibleTaskIds = new Set(
    [...deletionEligibleSourceIds].flatMap((sourceId) => {
      const id = identityObservation.decisionsBySourceId.get(sourceId)?.selectedLocalId;
      return id ? [id] : [];
    }),
  );
  const stableEdges: Array<{ blocker: DependencyTask; blocked: DependencyTask }> = [];
  const unresolvedBlockedTaskIds = new Set<string>();

  for (const edge of stagedEdges) {
    const blocker = taskById.get(
      identityObservation.decisionsBySourceId.get(edge.blockerSourceId)?.selectedLocalId ?? '',
    );
    const blocked = taskById.get(
      identityObservation.decisionsBySourceId.get(edge.blockedSourceId)?.selectedLocalId ?? '',
    );
    if (blocker && blocked) {
      remoteKeys.add(`${blocker.id}\u0000${blocked.id}`);
      stableEdges.push({ blocker, blocked });
    } else {
      unresolvedBlockedSourceIds.add(edge.blockedSourceId);
      if (blocked) unresolvedBlockedTaskIds.add(blocked.id);
    }
  }

  let localDependencies: DependencyRecord[] = [];
  if (taskIds.length > 0) {
    localDependencies = await deps.listBlocksDependenciesForTasks(taskIds);
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
    const partialResult = await deps.completeSnapshotPartial({
      fence: snapshotFence(snapshot),
      cursor: snapshot.cursor,
      total: snapshot.total,
      connectorInstanceId,
      completedAt,
      failureReason,
      identityEvidenceFailureReason:
        identityEvidenceFailureReason ?? 'dependency_remote_verification_incomplete',
      retainedSnapshotIds,
    });
    if (partialResult.status === 'fenced') {
      return {
        snapshot: identityContextFencedSnapshot(snapshot, completedAt),
        removed: 0,
        imported: 0,
      };
    }
    const prunedSnapshots = partialResult.prunedSnapshots;
    const partial: DependencySnapshot = {
      ...snapshot,
      status: 'partial',
      phase: 'completed',
      updatedAt: completedAt,
      failedAt: completedAt,
      nextAttemptAt: null,
      failureReason,
      identityEvidenceEligible: false,
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
    return { snapshot: partial, removed: 0, imported: 0 };
  }

  // Decide the finalization mutations before acquiring the writer lock so the
  // transaction only executes a bounded number of set-based statements.
  const insertableEdges: TaskDependencyInsert[] = stableEdges.map(({ blocker, blocked }) => ({
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
  }));
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
      !deletionEligibleTaskIds.has(blocked.id)
      || unresolvedBlockedTaskIds.has(blocked.id)
    ) return false;
    return !remoteKeys.has(`${dependency.dependsOnTaskId}\u0000${dependency.taskId}`);
  }).map((dependency) => dependency.id);

  const finalizeResult = await deps.finalizeSnapshotGeneration({
    fence: snapshotFence(snapshot),
    cursor: snapshot.cursor,
    total: snapshot.total,
    connectorInstanceId,
    completedAt,
    identityEvidenceEligible,
    identityEvidenceFailureReason,
    insertableEdges,
    removableDependencyIds,
    retainedSnapshotIds,
    insertChunkSize: DEPENDENCY_FINALIZE_INSERT_CHUNK_SIZE,
    deleteChunkSize: DEPENDENCY_FINALIZE_DELETE_CHUNK_SIZE,
  });
  if (finalizeResult.status === 'fenced') {
    return {
      snapshot: identityContextFencedSnapshot(snapshot, completedAt),
      removed: 0,
      imported: 0,
    };
  }
  const { imported, removed, prunedSnapshots } = finalizeResult;
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
  return { snapshot: completed, removed, imported };
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
  const capabilities = connector.capabilities;
  const deps = await getGitHubDependencyRepository();
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
  const connectorTasks = await deps.listConnectorTasks(connectorInstanceId);
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
        const currentIdentityContext = await getModeSnapshot(connectorInstanceId);
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
        options.identityRuntime,
      );
      return {
        imported: finalized.imported,
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
  let localDependencies = await deps.listBlocksDependenciesForTasks(taskIds);
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
        ? await getModeSnapshot(connectorInstanceId)
        : undefined,
    );
  }
  const lastCompletedSnapshot = await getLastCompletedSnapshot(connectorInstanceId);
  if (connector.type === 'github-issues') {
    const currentIdentityContext = await getModeSnapshot(connectorInstanceId);
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

  const activeSnapshot = snapshot;
  const engineResult = await runResumableReconciliation({
    createSnapshot: async () => activeSnapshot,
    loadBatch: async (current, window): Promise<DependencyReconciliationBatch> => {
      const batchItems = await deps.listSnapshotItemsInWindow({
        snapshotId: current.id,
        start: window.start,
        end: window.end,
      });
      const sourceIds = batchItems.map((item) => item.sourceId);
      if (sourceIds.length !== window.end - window.start) {
        throw new Error(
          `Dependency snapshot ${current.id} is missing persisted source items`,
        );
      }
      return {
        sourceIds,
        usesStagedGeneration: current.readMode === 'graphql-bulk'
          || current.readMode === 'rest-fallback',
      };
    },
    executeBatch: async (
      current,
      batch,
    ): Promise<DependencyReconciliationBatchResult> => {
      if (!batch.usesStagedGeneration) {
        return {
          ...batch,
          remoteSnapshot: await fetchDependencySnapshot(connector, batch.sourceIds),
          imported: 0,
        };
      }

      const [stagedEdges, verifiedItems] = await Promise.all([
        deps.listStagedEdgesForSourceIds({
          snapshotId: current.id,
          blockedSourceIds: batch.sourceIds,
        }),
        deps.listVerifiedItemsForSourceIds({
          snapshotId: current.id,
          sourceIds: batch.sourceIds,
        }),
      ]);
      return {
        ...batch,
        remoteSnapshot: {
          dependencies: stagedEdges.map((edge) => ({
            blockerSourceId: edge.blockerSourceId,
            blockedSourceId: edge.blockedSourceId,
            blockerIdentityEvidence: edge.blockerIdentityEvidence ?? undefined,
            blockerIdentityEvidenceState: edge.blockerIdentityEvidenceState,
          })),
          completeBlockedSourceIds: verifiedItems.map(({ sourceId }) => sourceId),
          blockedIdentityEvidence: verifiedItems.map(
            ({ sourceId, identityEvidence, identityEvidenceState }) => ({
              sourceId,
              evidence: identityEvidence ?? undefined,
              state: identityEvidenceState,
            }),
          ),
        },
        imported: 0,
      };
    },
    advanceCursor: async (current, batchResult, window) => {
      let currentDependencies = await deps.listBlocksDependenciesForTasks(taskIds);
      currentDependencies = currentDependencies.filter((dependency) =>
        taskIdSet.has(dependency.dependsOnTaskId));
      batchResult.imported = await applySnapshotBatch(
        connectorInstanceId,
        current,
        window.start,
        window.end,
        batchResult.sourceIds,
        batchResult.remoteSnapshot,
        taskBySourceId,
        currentDependencies,
        !batchResult.usesStagedGeneration,
      );
      const refreshed = await deps.getSnapshotById(current.id);
      return refreshed ?? {
        ...current,
        cursor: window.end,
        importedCount: current.importedCount + batchResult.imported,
      };
    },
    classifyRetry: () => ({ retryable: true }),
    recordFailure: (current, failure) =>
      markSnapshotFailed(current, failure.error, failure),
    reportProgress: (current) => snapshotProgress(
      current,
      current.status === 'completed' ? current : lastCompletedSnapshot,
    ),
    complete: async (current) => {
      const finalized = await finalizeSnapshot(
        connectorInstanceId,
        connector.type,
        current,
        options.identityRuntime,
      );
      return {
        snapshot: finalized.snapshot,
        result: {
          imported: finalized.imported,
          removed: finalized.removed,
        },
      };
    },
    shouldContinue: (current) => (
      (current.readMode === 'graphql-bulk' || current.readMode === 'rest-fallback')
      && current.status === 'running'
      && current.cursor < current.total
    ),
  }, {
    snapshot: activeSnapshot,
    retryBaseMs: getDependencyRetryBaseMs(),
    retryMaxMs: MAX_RETRY_BACKOFF_MS,
  });

  if (engineResult.outcome === 'deferred') {
    syncLogger.info({
      connectorId: connectorInstanceId,
      dependencySnapshotId: engineResult.snapshot.id,
      processed: engineResult.snapshot.cursor,
      total: engineResult.snapshot.total,
      nextAttemptAt: engineResult.snapshot.nextAttemptAt,
    }, 'Dependency reconciliation retry deferred by backoff');
  }

  const imported = engineResult.batchResults.reduce(
    (total, batch) => total + batch.imported,
    0,
  ) + (engineResult.completion?.imported ?? 0);
  return {
    imported,
    removed: engineResult.completion?.removed ?? 0,
    pushed: retryResult.pushed,
    failed: retryResult.failed,
    snapshot: engineResult.progress,
  };
}
