import type { SyncAuditEntry } from './index';
import { syncLogger } from '@/lib/logger';
import { archiveAndDeleteTask } from './deletion-recovery';
import {
  digestExternalIdentifier,
  type GitHubStableResolvedCandidate,
  type GitHubStableIdentityRuntime,
  type GitHubIdentityResolutionDecision,
} from '@/lib/external-identities';
import type { DeletionCandidateRecord } from '@/db/persistence/connector-execution';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/** Subset of task fields needed by deletion detection */
export interface DeletionDetectionTask {
  id: string;
  sourceId: string;
  sourceListId: string | null;
  syncStatus: string | null;
  status: string;
  title: string;
  isChecklistItem?: boolean;
  parentId?: string | null;
  metadata?: string | unknown;
}

interface DeletionIdentityOptions {
  identityRuntime?: GitHubStableIdentityRuntime;
  inaccessibleSourceListIds?: ReadonlySet<string>;
}

interface LocalIdentityState {
  localId: string;
  externalEntityId: string | null;
  stableId: string | null;
  bindingState: string | null;
  backfillState: string | null;
  locatorRevision: number | null;
  repositoryEntityId: string | null;
  hostKey: string | null;
  bindingRevision: string | null;
}

const RETENTION_YIELD_INTERVAL = 10;

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Detects tasks that exist locally but no longer on the remote.
 * Applies safety rules to prevent accidental data loss.
 *
 * When `prefetchedLocalTasks` is provided, skips the redundant SELECT query
 * (the caller already loaded all tasks for this connector during upsert).
 */
export async function detectDeletions(
  connectorId: string,
  remoteSourceIds: Set<string>,
  isFullSync: boolean,
  audit: SyncAuditEntry[],
  prefetchedLocalTasks?: DeletionDetectionTask[],
  identityOptions: DeletionIdentityOptions = {},
): Promise<{ removed: number; localOnlyProtected: number }> {
  let removed = 0;

  if (remoteSourceIds.size === 0 && !identityOptions.identityRuntime) {
    return { removed: 0, localOnlyProtected: 0 };
  }
  const execution = (await getWorkerPersistenceRepositories()).execution;

  const localTasks = prefetchedLocalTasks
    ?? (await execution.pulls.listTasks(connectorId)).map((task) => ({
      id: task.id,
      sourceId: task.sourceId,
      sourceListId: task.sourceListId,
      syncStatus: task.syncStatus,
      status: task.status,
      title: task.title,
      isChecklistItem: task.isChecklistItem,
      parentId: task.parentId,
      metadata: task.metadata,
    }));
  const existingCandidates = await execution.deletions.listCandidates(connectorId);
  const candidateBySourceId = new Map(existingCandidates.map(row => [row.sourceId, row]));
  const localTaskBySourceId = new Map(localTasks.map(row => [row.sourceId, row]));
  const inaccessibleSourceListIds = identityOptions.inaccessibleSourceListIds ?? new Set<string>();
  const identityStateByLocalId = identityOptions.identityRuntime
    ? new Map(
        (await execution.deletions.listIdentityStates(connectorId))
          .map((row) => [row.localId, row]),
      )
    : new Map<string, LocalIdentityState>();
  const stableDecisionByLocalId = new Map<string, GitHubIdentityResolutionDecision>();

  if (identityOptions.identityRuntime) {
    const candidates = localTasks.map((local): GitHubStableResolvedCandidate => {
      const identityState = identityStateByLocalId.get(local.id);
      const observedAction = observedDeletionAction(local, remoteSourceIds, isFullSync);
      const sourceInaccessible = isSourceInaccessible(local, inaccessibleSourceListIds);
      let stable: GitHubStableResolvedCandidate['stable'];
      if (sourceInaccessible) {
        stable = {
          selectedLocalIds: [],
          action: 'none',
          evidence: 'inaccessible',
        };
      } else if (
        identityState?.bindingState === 'collision'
        || identityState?.backfillState === 'collision'
      ) {
        stable = {
          selectedLocalIds: identityState?.localId ? [identityState.localId] : [],
          action: 'none',
          evidence: 'collision',
          externalEntityId: identityState?.externalEntityId ?? undefined,
          stableIdDigest: identityState?.stableId
            ? digestExternalIdentifier(identityState.stableId)
            : undefined,
          locatorRevision: identityState?.locatorRevision ?? undefined,
          bindingRevision: identityState?.bindingRevision ?? undefined,
          bindingState: identityState?.bindingState as
            | 'shadow'
            | 'active'
            | 'collision'
            | 'retired'
            | undefined,
        };
      } else if (identityState?.backfillState === 'inaccessible') {
        stable = {
          selectedLocalIds: [],
          action: 'none',
          evidence: 'inaccessible',
          externalEntityId: identityState.externalEntityId ?? undefined,
          stableIdDigest: identityState.stableId
            ? digestExternalIdentifier(identityState.stableId)
            : undefined,
          locatorRevision: identityState.locatorRevision ?? undefined,
          bindingRevision: identityState.bindingRevision ?? undefined,
          bindingState: identityState.bindingState as
            | 'shadow'
            | 'active'
            | 'collision'
            | 'retired'
            | undefined,
        };
      } else if (!identityState?.externalEntityId || !identityState.localId) {
        stable = {
          selectedLocalIds: [],
          action: 'none',
          evidence: 'missing',
        };
      } else {
        const observed = identityOptions.identityRuntime!
          .hasResolvedStableLocalId(local.id);
        stable = {
          selectedLocalIds: [local.id],
          action: observed ? 'present' : observedAction,
          evidence: 'verified',
          externalEntityId: identityState.externalEntityId,
          stableIdDigest: identityState.stableId
            ? digestExternalIdentifier(identityState.stableId)
            : undefined,
          locatorRevision: identityState.locatorRevision ?? undefined,
          bindingRevision: identityState.bindingRevision ?? undefined,
          bindingState: identityState.bindingState as
            | 'shadow'
            | 'active'
            | 'collision'
            | 'retired'
            | undefined,
        };
      }
      return {
        candidateKey: `task:${local.sourceId}`,
        localTaskId: local.id,
        locatorMatchedLocalIds: [local.id],
        stable,
      };
    });
    for (let index = 0; index < candidates.length; index += 500) {
      const decisions = await identityOptions.identityRuntime.applyResolvedBatch(
        'deletion',
        candidates.slice(index, index + 500),
      );
      for (const decision of decisions) {
        if (decision.localTaskId) stableDecisionByLocalId.set(decision.localTaskId, decision);
      }
    }
    await identityOptions.identityRuntime.assertDecisionsCurrent(
      stableDecisionByLocalId.values(),
    );
  }

  for (let index = 0; index < existingCandidates.length; index++) {
    const candidate = existingCandidates[index];
    if (remoteSourceIds.has(candidate.sourceId) || !localTaskBySourceId.has(candidate.sourceId)) {
      await execution.deletions.clearCandidate(connectorId, candidate.sourceId);
      candidateBySourceId.delete(candidate.sourceId);
    }
    if ((index + 1) % RETENTION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  const orphanedLocalOnly: Array<{ id: string; title: string; sourceId: string }> = [];

  for (let index = 0; index < localTasks.length; index++) {
    if (index > 0 && index % RETENTION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
    const local = localTasks[index];
    if (remoteSourceIds.has(local.sourceId)) continue;

    const identityState = identityStateByLocalId.get(local.id);
    const stableDecision = identityOptions.identityRuntime
      ? stableDecisionByLocalId.get(local.id)
      : undefined;
    if (
      stableDecision
      && stableDecision.appliedSource === 'stable'
      && stableDecision.selectedLocalId === local.id
      && stableDecision.selectedAction === 'present'
    ) {
      await clearCandidate(connectorId, local.sourceId);
      continue;
    }
    const identityProtected = (
      isSourceInaccessible(local, inaccessibleSourceListIds)
      || (
        Boolean(identityOptions.identityRuntime)
        && (
          !identityState?.externalEntityId
          || !identityState.repositoryEntityId
          || !identityState.locatorRevision
          || !identityState.bindingRevision
        )
      )
      || identityState?.bindingState === 'collision'
      || identityState?.backfillState === 'collision'
      || identityState?.backfillState === 'inaccessible'
      || (
        Boolean(identityOptions.identityRuntime)
        && (
          !stableDecision
          || stableDecision.appliedSource !== 'stable'
          || stableDecision.selectedLocalId !== local.id
          || stableDecision.selectedAction !== 'delete_candidate'
        )
      )
    );
    if (identityProtected) {
      orphanedLocalOnly.push({ id: local.id, title: local.title, sourceId: local.sourceId });
      audit.push({
        action: 'protected',
        taskId: local.id,
        taskTitle: local.title,
        taskSourceId: local.sourceId,
        reason: 'Identity evidence is inaccessible or ambiguous; remote absence is not authoritative',
      });
      await clearCandidate(connectorId, local.sourceId);
      continue;
    }

    if (remoteSourceIds.size === 0) {
      audit.push({
        action: 'protected',
        taskId: local.id,
        taskTitle: local.title,
        taskSourceId: local.sourceId,
        reason: 'Empty remote result is not authoritative for deletion',
      });
      await clearCandidate(connectorId, local.sourceId);
      continue;
    }

    if (local.isChecklistItem && local.sourceId === local.id) {
      const parent = local.parentId
        ? localTasks.find((candidate) => candidate.id === local.parentId)
        : undefined;
      const upstreamParentWasRemoved = !parent || (
        !parent.sourceId.startsWith('local:')
        && parent.sourceId !== parent.id
        && !remoteSourceIds.has(parent.sourceId)
      );
      if (upstreamParentWasRemoved) {
        orphanedLocalOnly.push({ id: local.id, title: local.title, sourceId: local.sourceId });
        audit.push({
          action: 'protected',
          taskId: local.id,
          taskTitle: local.title,
          taskSourceId: local.sourceId,
          reason: 'Locally-created subtask retained after its upstream parent was removed',
        });
        continue;
      }

    }

    // SAFETY: Never delete local-only tasks
    if (local.sourceId.startsWith('local:')) {
      orphanedLocalOnly.push({ id: local.id, title: local.title, sourceId: local.sourceId });
      if (local.syncStatus !== 'pending_push' && local.syncStatus !== 'push_error') {
        await execution.deletions.markPendingPush(local.id);
        audit.push({ action: 'protected', taskTitle: local.title, taskSourceId: local.sourceId, taskId: local.id, reason: 'Local-only task escalated to pending_push for next cycle' });
      } else {
        audit.push({ action: 'protected', taskTitle: local.title, taskSourceId: local.sourceId, taskId: local.id, reason: 'Local-only task not yet pushed to remote' });
      }
      await clearCandidate(connectorId, local.sourceId);
      continue;
    }

    // Locally-created subtasks temporarily use their MC task ID as source ID.
    // Remote connectors may legitimately use unprefixed or numeric source IDs.
    if (local.isChecklistItem && local.sourceId === local.id) {
      orphanedLocalOnly.push({ id: local.id, title: local.title, sourceId: local.sourceId });
      if (local.syncStatus !== 'pending_push' && local.syncStatus !== 'push_error') {
        await execution.deletions.markPendingPush(local.id);
        audit.push({ action: 'protected', taskTitle: local.title, taskSourceId: local.sourceId, taskId: local.id, reason: 'Locally-created subtask escalated to pending_push for next cycle' });
      } else {
        audit.push({ action: 'protected', taskTitle: local.title, taskSourceId: local.sourceId, taskId: local.id, reason: 'Locally-created task not yet pushed to remote' });
      }
      await clearCandidate(connectorId, local.sourceId);
      continue;
    }

    // SAFETY: Never delete tasks with pending local changes
    if (local.syncStatus === 'pending_push' || local.syncStatus === 'push_error') {
      orphanedLocalOnly.push({ id: local.id, title: local.title, sourceId: local.sourceId });
      audit.push({ action: 'protected', taskTitle: local.title, taskSourceId: local.sourceId, taskId: local.id, reason: `Has pending local changes (${local.syncStatus})` });
      await clearCandidate(connectorId, local.sourceId);
      continue;
    }

    // SAFETY: Retain completed/cancelled tasks (with recurring exception)
    if (local.status === 'done' || local.status === 'cancelled') {
      if (isFullSync && local.status === 'done') {
        let meta: Record<string, unknown> = {};
        try {
          meta = typeof local.metadata === 'string'
            ? JSON.parse(local.metadata)
            : (local.metadata as Record<string, unknown>) || {};
        } catch { /* ignore */ }

        if (meta.recurrence) {
          const removal = await quarantineOrArchive(
            connectorId,
            local,
            candidateBySourceId.get(local.sourceId),
            'Completed recurring task not in remote — purged by source',
            audit,
            identityState,
            identityOptions.identityRuntime?.modeSnapshot,
            identityOptions.identityRuntime,
          );
          if (removal) removed++;
          continue;
        }
      }
      audit.push({ action: 'protected', taskTitle: local.title, taskSourceId: local.sourceId, taskId: local.id, reason: `Completed/cancelled task retained locally (status: ${local.status})` });
      await clearCandidate(connectorId, local.sourceId);
      continue;
    }

    // Only delete during full syncs
    if (isFullSync) {
      const removal = await quarantineOrArchive(
        connectorId,
        local,
        candidateBySourceId.get(local.sourceId),
        'Not found in remote during two consecutive full syncs — deleted or completed remotely',
        audit,
        identityState,
        identityOptions.identityRuntime?.modeSnapshot,
        identityOptions.identityRuntime,
      );
      if (removal) removed++;
    }
  }

  const localOnlyProtected = orphanedLocalOnly.length;
  if (orphanedLocalOnly.length > 0) {
    syncLogger.info({
      connectorId,
      protectedCount: orphanedLocalOnly.length,
      tasks: orphanedLocalOnly.slice(0, 5).map(t => t.title),
    }, 'Protected local-only/pending tasks from deletion');
  }

  return { removed, localOnlyProtected };
}

function isSourceInaccessible(
  task: Pick<DeletionDetectionTask, 'sourceId' | 'sourceListId'>,
  inaccessibleSourceIds: ReadonlySet<string>,
): boolean {
  if (task.sourceListId && inaccessibleSourceIds.has(task.sourceListId)) return true;
  const separator = task.sourceId.lastIndexOf(':');
  return separator > 0 && inaccessibleSourceIds.has(task.sourceId.slice(0, separator));
}

/**
 * Derives the deletion action implied by this sync's remote observation. It
 * describes what the stream showed, not identity: NodeID resolution decides
 * whether the action is applied.
 */
function observedDeletionAction(
  task: DeletionDetectionTask,
  remoteSourceIds: ReadonlySet<string>,
  isFullSync: boolean,
): 'present' | 'delete_candidate' | 'none' {
  if (remoteSourceIds.has(task.sourceId)) return 'present';
  if (!isFullSync || remoteSourceIds.size === 0) return 'none';
  if (
    task.sourceId.startsWith('local:')
    || (task.isChecklistItem && task.sourceId === task.id)
    || task.syncStatus === 'pending_push'
    || task.syncStatus === 'push_error'
    || task.status === 'done'
    || task.status === 'cancelled'
  ) {
    return 'none';
  }
  return 'delete_candidate';
}

async function clearCandidate(connectorId: string, sourceId: string): Promise<void> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.deletions;
  await persistence.clearCandidate(connectorId, sourceId);
}

async function quarantineOrArchive(
  connectorId: string,
  task: DeletionDetectionTask,
  candidate: DeletionCandidateRecord | undefined,
  removalReason: string,
  audit: SyncAuditEntry[],
  identityState?: LocalIdentityState,
  modeSnapshot?: { effectiveMode: 'stable'; modeRevision: number },
  identityRuntime?: GitHubStableIdentityRuntime,
): Promise<boolean> {
  const requiredMissingFullSyncs = 2;
  const now = new Date().toISOString();
  const persistence = (await getWorkerPersistenceRepositories()).execution.deletions;
  const outcome = await persistence.observeMissing({
    connectorId,
    taskId: task.id,
    sourceId: task.sourceId,
    now,
    expectedCandidateId: candidate?.id,
    expectedFence: {
      identityMode: modeSnapshot?.effectiveMode ?? null,
      identityModeRevision: modeSnapshot?.modeRevision ?? null,
      issueEntityId: identityState?.externalEntityId ?? null,
      repositoryEntityId: identityState?.repositoryEntityId ?? null,
      hostKey: identityState?.hostKey ?? null,
      locatorRevision: identityState?.locatorRevision ?? null,
      bindingState: identityState?.bindingState ?? null,
      bindingRevision: identityState?.bindingRevision ?? null,
    },
  });
  if (outcome === 'quarantined') {
    audit.push({
      action: 'protected',
      taskTitle: task.title,
      taskSourceId: task.sourceId,
      taskId: task.id,
      reason: 'Missing from source once — quarantined until confirmed by the next full sync',
    });
    return false;
  }
  if (outcome === 'fence-reset') {
    audit.push({
      action: 'protected',
      taskTitle: task.title,
      taskSourceId: task.sourceId,
      taskId: task.id,
      reason: 'Deletion fence changed; candidate reset instead of carrying across identity evidence',
    });
    return false;
  }

  const missingCount = (candidate?.missingCount ?? 0) + 1;
  if (missingCount < requiredMissingFullSyncs) {
    audit.push({
      action: 'protected',
      taskTitle: task.title,
      taskSourceId: task.sourceId,
      taskId: task.id,
      reason: `Missing from source ${missingCount} times — quarantined until ${requiredMissingFullSyncs} full syncs confirm removal`,
    });
    return false;
  }

  await identityRuntime?.assertCurrentMode();
  const archived = await archiveAndDeleteTask(
    task.id,
    removalReason,
    modeSnapshot ? {
      identityMode: modeSnapshot.effectiveMode,
      identityModeRevision: modeSnapshot.modeRevision,
      issueEntityId: identityState?.externalEntityId ?? null,
      repositoryEntityId: identityState?.repositoryEntityId ?? null,
      hostKey: identityState?.hostKey ?? null,
      locatorRevision: identityState?.locatorRevision ?? null,
      bindingState: identityState?.bindingState ?? null,
      bindingRevision: identityState?.bindingRevision ?? null,
      sourceId: task.sourceId,
    } : undefined,
  );
  if (!archived) return false;
  audit.push({
    action: 'removed',
    taskTitle: task.title,
    taskSourceId: task.sourceId,
    taskId: task.id,
    deletionSnapshotId: archived.snapshotId,
    reason: removalReason,
  });
  return true;
}
