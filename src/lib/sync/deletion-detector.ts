import type { SyncAuditEntry } from './index';
import db, { sqlite } from '@/db';
import { syncDeletionCandidates, tasks } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { syncLogger } from '@/lib/logger';
import { archiveAndDeleteTask } from './deletion-recovery';
import {
  digestExternalIdentifier,
  type GitHubComparisonResolvedCandidate,
  type GitHubIdentityComparisonRuntime,
  type GitHubIdentityResolutionDecision,
} from '@/lib/external-identities';

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
  identityComparison?: GitHubIdentityComparisonRuntime;
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

  if (remoteSourceIds.size === 0 && !identityOptions.identityComparison) {
    return { removed: 0, localOnlyProtected: 0 };
  }

  const localTasks = prefetchedLocalTasks ?? await db.select({
    id: tasks.id,
    sourceId: tasks.sourceId,
    sourceListId: tasks.sourceListId,
    syncStatus: tasks.syncStatus,
    status: tasks.status,
    title: tasks.title,
    isChecklistItem: tasks.isChecklistItem,
    parentId: tasks.parentId,
  })
    .from(tasks)
    .where(eq(tasks.connectorInstanceId, connectorId))
    .all();
  const existingCandidates = db.select()
    .from(syncDeletionCandidates)
    .where(eq(syncDeletionCandidates.connectorId, connectorId))
    .all();
  const candidateBySourceId = new Map(existingCandidates.map(row => [row.sourceId, row]));
  const localTaskBySourceId = new Map(localTasks.map(row => [row.sourceId, row]));
  const inaccessibleSourceListIds = identityOptions.inaccessibleSourceListIds ?? new Set<string>();
  const identityStateByLocalId = identityOptions.identityComparison
    ? loadLocalIdentityStates(connectorId)
    : new Map<string, LocalIdentityState>();
  const stableDecisionByLocalId = new Map<string, GitHubIdentityResolutionDecision>();

  if (identityOptions.identityComparison) {
    const candidates = localTasks.map((local): GitHubComparisonResolvedCandidate => {
      const identityState = identityStateByLocalId.get(local.id);
      const legacyAction = legacyDeletionAction(local, remoteSourceIds, isFullSync);
      const sourceInaccessible = isSourceInaccessible(local, inaccessibleSourceListIds);
      let stable: GitHubComparisonResolvedCandidate['stable'];
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
        const observed = identityOptions.identityComparison!
          .hasObservedStableLocalId(local.id);
        stable = {
          selectedLocalIds: [local.id],
          action: observed ? 'present' : legacyAction,
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
        legacySelectedLocalIds: [local.id],
        legacyAction,
        stable,
      };
    });
    for (let index = 0; index < candidates.length; index += 500) {
      const decisions = identityOptions.identityComparison.observeResolvedBatch(
        'deletion',
        candidates.slice(index, index + 500),
      );
      for (const decision of decisions) {
        if (decision.localTaskId) stableDecisionByLocalId.set(decision.localTaskId, decision);
      }
    }
    identityOptions.identityComparison.assertDecisionsCurrent(
      stableDecisionByLocalId.values(),
    );
  }

  for (let index = 0; index < existingCandidates.length; index++) {
    const candidate = existingCandidates[index];
    if (remoteSourceIds.has(candidate.sourceId) || !localTaskBySourceId.has(candidate.sourceId)) {
      await db.delete(syncDeletionCandidates)
        .where(eq(syncDeletionCandidates.id, candidate.id));
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
    const stableDecision = identityOptions.identityComparison?.modeSnapshot.effectiveMode === 'stable'
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
        Boolean(identityOptions.identityComparison)
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
        identityOptions.identityComparison?.modeSnapshot.effectiveMode === 'stable'
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
        await db.update(tasks).set({ syncStatus: 'pending_push' }).where(eq(tasks.id, local.id));
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
        await db.update(tasks).set({ syncStatus: 'pending_push' }).where(eq(tasks.id, local.id));
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
        const [taskRow] = await db.select({ metadata: tasks.metadata })
          .from(tasks).where(eq(tasks.id, local.id));
        let meta: Record<string, unknown> = {};
        try {
          meta = typeof taskRow?.metadata === 'string' ? JSON.parse(taskRow.metadata) : (taskRow?.metadata as Record<string, unknown>) || {};
        } catch { /* ignore */ }

        if (meta.recurrence) {
          const removal = await quarantineOrArchive(
            connectorId,
            local,
            candidateBySourceId.get(local.sourceId),
            'Completed recurring task not in remote — purged by source',
            audit,
            identityState,
            identityOptions.identityComparison?.modeSnapshot,
            identityOptions.identityComparison,
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
        identityOptions.identityComparison?.modeSnapshot,
        identityOptions.identityComparison,
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

function legacyDeletionAction(
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

function loadLocalIdentityStates(connectorId: string): Map<string, LocalIdentityState> {
  const rows = sqlite.prepare(`
    SELECT
      task.id AS localId,
      binding.external_entity_id AS externalEntityId,
      entity.stable_id AS stableId,
      binding.state AS bindingState,
      backfill.state AS backfillState,
      locator.locator_revision AS locatorRevision,
      locator.repository_entity_id AS repositoryEntityId,
      entity.host_key AS hostKey,
      binding.verified_at AS bindingRevision
    FROM tasks AS task
    LEFT JOIN external_entity_bindings AS binding
      ON binding.connector_instance_id = task.connector_instance_id
      AND binding.binding_type = 'task'
      AND binding.local_id = task.id
      AND binding.state != 'retired'
    LEFT JOIN external_entities AS entity
      ON entity.id = binding.external_entity_id
    LEFT JOIN external_entity_locators AS locator
      ON locator.external_entity_id = entity.id
      AND locator.valid_to IS NULL
    LEFT JOIN github_identity_backfill_items AS backfill
      ON backfill.connector_instance_id = task.connector_instance_id
      AND backfill.binding_type = 'task'
      AND backfill.local_id = task.id
    WHERE task.connector_instance_id = ?
  `).all(connectorId) as LocalIdentityState[];
  return new Map(rows.map((row) => [row.localId, row]));
}

async function clearCandidate(connectorId: string, sourceId: string): Promise<void> {
  await db.delete(syncDeletionCandidates).where(and(
    eq(syncDeletionCandidates.connectorId, connectorId),
    eq(syncDeletionCandidates.sourceId, sourceId),
  ));
}

async function quarantineOrArchive(
  connectorId: string,
  task: DeletionDetectionTask,
  candidate: typeof syncDeletionCandidates.$inferSelect | undefined,
  removalReason: string,
  audit: SyncAuditEntry[],
  identityState?: LocalIdentityState,
  modeSnapshot?: { effectiveMode: 'legacy' | 'comparison' | 'stable'; modeRevision: number },
  identityRuntime?: GitHubIdentityComparisonRuntime,
): Promise<boolean> {
  const requiredMissingFullSyncs = 2;
  const now = new Date().toISOString();
  if (!candidate) {
    await db.insert(syncDeletionCandidates).values({
      id: randomUUID(),
      connectorId,
      taskId: task.id,
      sourceId: task.sourceId,
      firstMissingAt: now,
      lastMissingAt: now,
      missingCount: 1,
      identityMode: modeSnapshot?.effectiveMode,
      identityModeRevision: modeSnapshot?.modeRevision,
      issueEntityId: identityState?.externalEntityId,
      repositoryEntityId: identityState?.repositoryEntityId,
      hostKey: identityState?.hostKey,
      locatorRevision: identityState?.locatorRevision,
      bindingState: identityState?.bindingState,
      bindingRevision: identityState?.bindingRevision,
    }).onConflictDoUpdate({
      target: [syncDeletionCandidates.connectorId, syncDeletionCandidates.sourceId],
      set: {
        taskId: task.id,
        lastMissingAt: now,
        missingCount: 1,
        identityMode: modeSnapshot?.effectiveMode,
        identityModeRevision: modeSnapshot?.modeRevision,
        issueEntityId: identityState?.externalEntityId,
        repositoryEntityId: identityState?.repositoryEntityId,
        hostKey: identityState?.hostKey,
        locatorRevision: identityState?.locatorRevision,
        bindingState: identityState?.bindingState,
        bindingRevision: identityState?.bindingRevision,
      },
    });
    audit.push({
      action: 'protected',
      taskTitle: task.title,
      taskSourceId: task.sourceId,
      taskId: task.id,
      reason: 'Missing from source once — quarantined until confirmed by the next full sync',
    });
    return false;
  }

  if (
    candidate.identityMode !== (modeSnapshot?.effectiveMode ?? null)
    || candidate.identityModeRevision !== (modeSnapshot?.modeRevision ?? null)
    || candidate.issueEntityId !== (identityState?.externalEntityId ?? null)
    || candidate.repositoryEntityId !== (identityState?.repositoryEntityId ?? null)
    || candidate.locatorRevision !== (identityState?.locatorRevision ?? null)
    || candidate.bindingState !== (identityState?.bindingState ?? null)
    || candidate.bindingRevision !== (identityState?.bindingRevision ?? null)
  ) {
    await db.delete(syncDeletionCandidates).where(eq(syncDeletionCandidates.id, candidate.id));
    audit.push({
      action: 'protected',
      taskTitle: task.title,
      taskSourceId: task.sourceId,
      taskId: task.id,
      reason: 'Deletion fence changed; candidate reset instead of carrying across identity evidence',
    });
    return false;
  }

  const missingCount = candidate.missingCount + 1;
  if (missingCount < requiredMissingFullSyncs) {
    await db.update(syncDeletionCandidates).set({
      lastMissingAt: now,
      missingCount,
    }).where(eq(syncDeletionCandidates.id, candidate.id));
    audit.push({
      action: 'protected',
      taskTitle: task.title,
      taskSourceId: task.sourceId,
      taskId: task.id,
      reason: `Missing from source ${missingCount} times — quarantined until ${requiredMissingFullSyncs} full syncs confirm removal`,
    });
    return false;
  }

  identityRuntime?.assertCurrentMode();
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
