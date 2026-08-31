import type { IConnector } from '@/lib/connectors';
import type { TaskItem, ConnectorCapabilities } from '@/types';
import type { SyncAuditEntry } from './index';
import type {
  ConnectorTaskRecord,
  ConnectorTaskUpdate,
  PullTag,
} from '@/db/persistence/connector-execution';
import { resolvePersistedConnectorCapabilities } from '@/lib/connectors/resolved-capabilities';
import { randomUUID } from 'crypto';
import { syncLogger } from '@/lib/logger';

import { syncEventBus } from './events';
import { indexTasksForSearchBatch } from './search-indexer';
import type { SearchableTask } from './search-indexer';
import { detectDeletions } from './deletion-detector';
import { archiveAndDeleteTask } from './deletion-recovery';
import {
  findOpenRecurringTaskDuplicates,
  getRecurringSeriesKey,
  getRecurringTitleKey,
  hasRecurrenceEvidence,
  inferRecurringTitleKeys,
  shouldSuppressNonRecurringDuplicate,
} from './recurring-task-reconciliation';
import { getLocalToday } from '@/lib/utils/date';
import {
  persistGitHubLinkedSourceIdentityBatch,
} from '@/lib/external-identities/linked-source-identity';
import {
  persistGitHubPrimaryIdentityBatch,
} from '@/lib/external-identities/primary-identity';
import { getTimezone } from '@/lib/mode';
import {
  isReminderRelativeRule,
  resolveRelativeReminderMutation,
} from '@/lib/tasks/relative-reminder';
import type { ExternalIdentityWrite } from '@/lib/external-identities/types';
import type {
  GitHubStableIdentityRuntime,
} from '@/lib/external-identities/stable-identity-runtime';
import type {
  GitHubIdentityOutcome,
  GitHubIdentityResolutionDecision,
} from '@/lib/external-identities/stable-identity-types';
import {
  mergeGitHubHierarchyObservation,
  readGitHubHierarchyObservation,
  reconcileGitHubTaskHierarchy,
} from './github-hierarchy-reconciliation';
import type { GitHubHierarchyObservation } from './github-hierarchy-reconciliation';
import { needsMicrosoftTodoLinkedResourceHydration } from './task-metadata-hydration';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/** How many tasks to process per batch before yielding to the event loop.
 *  Balances throughput (fewer yields = fewer context switches) against
 *  responsiveness (shorter blocking windows for HTTP/cron/SSE). */
const BATCH_SIZE = 25;
const MAX_BLOCKED_IDENTITY_AUDIT_ENTRIES = 20;

/** Minimum milliseconds to yield between batches. Must be long enough for
 *  queued macrotasks (healthcheck HTTP, cron, SSE) to run.  2 ms was too
 *  brief — healthcheck requests arriving during sync never got a window. */
const YIELD_DELAY_MS = 25;

/**
 * Yield to the event loop so cron jobs, health checks, and other callbacks
 * can run between batches of synchronous DB work.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, YIELD_DELAY_MS));
}

interface RemoteTaskVersion {
  hasParent: boolean;
  updatedAt?: string;
  status: TaskItem['status'];
  isChecklistItem: boolean;
}

export interface GitHubTaskIdentityBlockSummary {
  count: number;
  outcomes: Partial<Record<GitHubIdentityOutcome, number>>;
}

export function recordBlockedTaskIdentityDecision(
  decision: GitHubIdentityResolutionDecision,
  audit: SyncAuditEntry[],
  summary: GitHubTaskIdentityBlockSummary,
): void {
  if (decision.appliedSource !== 'blocked') return;
  summary.count++;
  summary.outcomes[decision.outcome] = (summary.outcomes[decision.outcome] ?? 0) + 1;
  if (summary.count <= MAX_BLOCKED_IDENTITY_AUDIT_ENTRIES) {
    audit.push({
      action: 'protected',
      taskTitle: 'GitHub task identity blocked',
      taskSourceId: decision.candidateKey,
      reason: `Stable identity decision blocked: ${decision.outcome}`,
    });
  }
}

function toRemoteTaskVersion(task: TaskItem): RemoteTaskVersion {
  return {
    hasParent: !!task.parentId,
    updatedAt: task.updatedAt,
    status: task.status,
    isChecklistItem: !!task.isChecklistItem,
  };
}

function isPreferredRemoteTask(task: TaskItem, existing: RemoteTaskVersion): boolean {
  const hasParent = !!task.parentId;
  if (hasParent !== existing.hasParent) return hasParent;
  return !!task.updatedAt && !!existing.updatedAt && task.updatedAt > existing.updatedAt;
}

async function* toTaskPageStream(
  pages: AsyncIterable<TaskItem[]> | TaskItem[],
): AsyncGenerator<TaskItem[], void, unknown> {
  if (Array.isArray(pages)) {
    yield pages;
    return;
  }
  yield* pages;
}

/**
 * Upserts remote tasks into local DB with conflict resolution and per-list progress reporting.
 * Uses batched DB operations to avoid the N+1 query problem.
 */
export async function upsertTasks(
  connectorId: string,
  connector: IConnector,
  remoteTaskPages: AsyncIterable<TaskItem[]> | TaskItem[],
  isFullSync?: boolean,
  discoveredLists?: Array<{ id: string; name: string }>,
  auditLog?: SyncAuditEntry[],
  identityRuntime?: GitHubStableIdentityRuntime,
  inaccessibleSourceListIds: ReadonlySet<string> = new Set(),
): Promise<{
  added: number;
  updated: number;
  removed: number;
  localOnlyProtected: number;
  parentTasksAdded: number;
  subtasksAdded: number;
  remoteSourceIds: Set<string>;
  identityBlocked: number;
  identityBlockedOutcomes: Partial<Record<GitHubIdentityOutcome, number>>;
}> {
  let added = 0;
  let updated = 0;
  let removed = 0;
  let localOnlyProtected = 0;
  let parentTasksAdded = 0;
  let subtasksAdded = 0;
  let skippedPendingPush = 0;
  const identityBlocks: GitHubTaskIdentityBlockSummary = { count: 0, outcomes: {} };
  const audit = auditLog || [];
  const now = new Date().toISOString();
  const repositories = await getWorkerPersistenceRepositories();
  const execution = repositories.execution;
  execution.support.assertConnectorSupported(connector);
  const pullPersistence = execution.pulls;
  const persistedConnector = await repositories.connectors.get(connectorId);
  const caps = persistedConnector
    ? resolvePersistedConnectorCapabilities({
        type: persistedConnector.type,
        capabilities: persistedConnector.capabilities,
        settings: persistedConnector.settings,
      })
    : connector.capabilities ?? null;
  const canSyncTags = !caps || caps.tags !== false;
  const remoteSourceIds = new Set<string>();
  const tempIdToDbId = new Map<string, string>();
  const seenRemoteVersions = new Map<string, RemoteTaskVersion>();
  const countedSourceIds = new Set<string>();
  const comparisonObservedSourceIds = new Set<string>();
  const comparisonObservedLinkedSourceIds = new Set<string>();
  const identityDecisionBySourceId = new Map<string, GitHubIdentityResolutionDecision>();
  const addedClassification = new Map<string, 'parent' | 'subtask'>();
  const githubHierarchyObservations = new Map<string, GitHubHierarchyObservation>();
  let githubHierarchyGenerationComplete = true;

  // ─── PRE-FETCH: Load all existing tasks for this connector in one query ───
  const snapshot = await pullPersistence.loadSnapshot(connectorId, {
    includeArchivedRecurringDuplicates: connector.type === 'microsoft-todo',
    includeLinkedSources: connector.type === 'github-issues' && Boolean(identityRuntime),
  });
  const existingTaskRows = snapshot.tasks;
  const archivedRecurringDuplicateSourceIds = new Set(
    snapshot.archivedRecurringDuplicateSourceIds,
  );

  const existingBySourceId = new Map<string, ConnectorTaskRecord>();
  const existingById = new Map<string, ConnectorTaskRecord>();
  const openRecurringTitleKeys = connector.type === 'microsoft-todo'
    ? inferRecurringTitleKeys(existingTaskRows.filter(row => row.depth === 0))
    : new Set<string>();
  for (const row of existingTaskRows) {
    existingBySourceId.set(row.sourceId, row);
    existingById.set(row.id, row);
    if (
      row.depth === 0
      && (row.status === 'todo' || row.status === 'in_progress')
      && hasRecurrenceEvidence(row)
    ) {
      openRecurringTitleKeys.add(getRecurringTitleKey(row));
    }
  }
  const githubLinkedSourceRows = snapshot.linkedSources;
  const githubLinkedSourceBySourceId = new Map(
    githubLinkedSourceRows.map((row) => [row.sourceId, row]),
  );
  const githubLinkedSourceByStableIdentity = new Map(
    githubLinkedSourceRows.flatMap((row) => (
      row.entityProvider === 'github'
        && row.entityType === 'issue'
        && row.entityHostKey
        && row.entityStableId
        ? [[linkedSourceStableIdentityKey(row.entityHostKey, row.entityStableId), row] as const]
        : []
    )),
  );

  // Detect initial sync: if this connector has no existing tasks in the DB,
  // all incoming tasks are pre-existing in the source system (bulk import).
  const isInitialSync = existingBySourceId.size === 0;

  // Detect per-source-list first sync: track which source lists already have
  // tasks in the DB. When a new repo/list is added to an existing connector,
  // all its pre-existing tasks should be flagged as bulk imports too.
  const existingSourceListIds = new Set<string>();
  for (const row of existingTaskRows) {
    if (row.sourceListId) existingSourceListIds.add(row.sourceListId);
  }

  // Build list name lookup
  const listNameMap = new Map<string, string>();
  if (discoveredLists) {
    for (const l of discoveredLists) {
      listNameMap.set(l.id, l.name);
    }
  }

  const totalLists = discoveredLists?.length || 0;
  const progressLists = new Set<string | null>();
  let totalProcessed = 0;
  let totalParentTasks = 0;
  let totalSubtasks = 0;
  let totalTodo = 0;
  let totalDone = 0;

  // Collect tasks needing search indexing for the current network page.
  const tasksToIndex: SearchableTask[] = [];

  const pageIterator = toTaskPageStream(remoteTaskPages)[Symbol.asyncIterator]();
  let nextPage = pageIterator.next();
  void nextPage.catch(() => undefined);
  try {
    while (true) {
    const pageResult = await nextPage;
    if (pageResult.done) break;
    // Start the next network request before processing this page.
    nextPage = pageIterator.next();
    void nextPage.catch(() => undefined);

    const dedupedPage = new Map<string, TaskItem>();
    for (const task of pageResult.value) {
      const hierarchyObservation = readGitHubHierarchyObservation(task, connectorId);
      if (hierarchyObservation.kind === 'incomplete') {
        githubHierarchyGenerationComplete = false;
        identityRuntime?.markBlocked(hierarchyObservation.reasonCode);
      } else if (hierarchyObservation.kind === 'complete') {
        if (!mergeGitHubHierarchyObservation(
          githubHierarchyObservations,
          hierarchyObservation.observation,
        )) {
          githubHierarchyGenerationComplete = false;
          identityRuntime?.markBlocked('sub_issue_observation_conflict');
        }
      }
      remoteSourceIds.add(task.sourceId);
      const pageVersion = dedupedPage.get(task.sourceId);
      if (!pageVersion || isPreferredRemoteTask(task, toRemoteTaskVersion(pageVersion))) {
        dedupedPage.set(task.sourceId, task);
      }
    }

    const replacementIds = new Set<string>();
    const pageTasks: TaskItem[] = [];
    for (const task of dedupedPage.values()) {
      const previous = seenRemoteVersions.get(task.sourceId);
      if (previous && !isPreferredRemoteTask(task, previous)) continue;

      if (previous) {
        replacementIds.add(task.sourceId);
        const classification = addedClassification.get(task.sourceId);
        const nextClassification = task.isChecklistItem || task.parentId ? 'subtask' : 'parent';
        if (classification && classification !== nextClassification) {
          if (classification === 'subtask') subtasksAdded--;
          else parentTasksAdded--;
          if (nextClassification === 'subtask') subtasksAdded++;
          else parentTasksAdded++;
          addedClassification.set(task.sourceId, nextClassification);
        }
        if (previous.status === 'done') totalDone--;
        else totalTodo--;
        if (previous.isChecklistItem) totalSubtasks--;
        else totalParentTasks--;
      } else {
        totalProcessed++;
      }

      const version = toRemoteTaskVersion(task);
      seenRemoteVersions.set(task.sourceId, version);
      if (version.status === 'done') totalDone++;
      else totalTodo++;
      if (version.isChecklistItem) totalSubtasks++;
      else totalParentTasks++;
      pageTasks.push(task);
    }

    const tasksByList = new Map<string | null, TaskItem[]>();
    if (identityRuntime) {
      identityRuntime.markNetworkPage();
      const comparisonTasks = pageTasks.filter((task) => {
        if (comparisonObservedSourceIds.has(task.sourceId)) return false;
        comparisonObservedSourceIds.add(task.sourceId);
        return true;
      });
      for (let index = 0; index < comparisonTasks.length; index += 500) {
        const chunk = comparisonTasks.slice(index, index + 500);
        const decisions = await identityRuntime.resolveBatch(
          'task',
          'task',
          chunk.map((remoteTask) => {
            const direct = existingBySourceId.get(remoteTask.sourceId);
            const missionControlTaskId = remoteTask.metadata?.missionControlTaskId;
            const adopted = !direct && typeof missionControlTaskId === 'string'
              ? existingById.get(missionControlTaskId)
              : undefined;
            const existing = direct ?? (
              adopted?.sourceId.startsWith('local:') ? adopted : undefined
            );
            return {
              candidateKey: remoteTask.sourceId,
              locatorMatchedLocalIds: existing ? [existing.id] : [],
              boundAction: 'update' as const,
              unboundAction: 'create' as const,
              evidence: remoteTask.externalIdentity,
              localTaskId: existing?.id,
            };
          }),
        );
        for (const decision of decisions) {
          identityDecisionBySourceId.set(decision.candidateKey, decision);
          if (decision.appliedSource === 'blocked') {
            identityRuntime.markBlocked('task_identity_blocked');
          }
          recordBlockedTaskIdentityDecision(decision, audit, identityBlocks);
        }
      }
      const linkedCandidates = comparisonTasks.flatMap((remoteTask) => (
        linkedSourcesForRemoteTask(
          remoteTask,
          githubLinkedSourceBySourceId,
          githubLinkedSourceByStableIdentity,
        ).flatMap((linked) => {
          if (comparisonObservedLinkedSourceIds.has(linked.id)) return [];
          comparisonObservedLinkedSourceIds.add(linked.id);
          return [{
            candidateKey: `linked:${linked.id}`,
            linkedSourceId: linked.id,
            taskId: linked.taskId,
            sourceId: linked.sourceId,
            evidence: remoteTask.externalIdentity,
          }];
        })
      ));
      for (let index = 0; index < linkedCandidates.length; index += 500) {
        const decisions = await identityRuntime.resolveLinkedSourceBatch(
          linkedCandidates.slice(index, index + 500),
        );
        {
          const linkedByCandidate = new Map(
            linkedCandidates.slice(index, index + 500)
              .map((candidate) => [candidate.candidateKey, candidate] as const),
          );
          for (const decision of decisions) {
            const linked = linkedByCandidate.get(decision.candidateKey);
            if (
              linked
              && decision.appliedSource === 'stable'
              && decision.selectedLocalId === linked.taskId
              && decision.selectedAction === 'present'
            ) {
              const locator = linked.evidence?.entity.locator;
              const currentSourceId = locator?.issueNumber
                ? `${locator.owner}/${locator.repository}:${locator.issueNumber}`
                : null;
              if (currentSourceId && linked.sourceId !== currentSourceId) {
                await pullPersistence.updateLinkedSourceLocator(
                  linked.linkedSourceId,
                  currentSourceId,
                );
                linked.sourceId = currentSourceId;
              }
            }
          }
        }
      }
    }
    const applicablePageTasks = identityRuntime
      ? pageTasks.filter((task) => (
          identityDecisionBySourceId.get(task.sourceId)?.appliedSource === 'stable'
        ))
      : pageTasks;
    if (connector.type === 'microsoft-todo') {
      for (const task of applicablePageTasks) {
        if (
          !task.isChecklistItem
          && !task.parentId
          && task.status !== 'done'
          && task.status !== 'cancelled'
          && hasRecurrenceEvidence(task)
        ) {
          openRecurringTitleKeys.add(getRecurringTitleKey(task));
        }
      }
    }
    for (const task of applicablePageTasks) {
      const listId = task.sourceListId || null;
      const existing = tasksByList.get(listId);
      if (existing) existing.push(task);
      else tasksByList.set(listId, [task]);
    }

    for (const [listId, listTasks] of tasksByList) {
    const listName = (listId && listNameMap.get(listId)) || listTasks[0]?.sourceListName || listId || 'Unknown';
    progressLists.add(listId);

    syncEventBus.emitSyncEvent({
      type: 'sync:list-progress',
      connectorId,
      listName,
      listIndex: progressLists.size,
      totalLists: Math.max(totalLists, progressLists.size),
      tasksInList: listTasks.length,
    });

    // Process this list's tasks in batches
    for (let batchStart = 0; batchStart < listTasks.length; batchStart += BATCH_SIZE) {
      const batch = listTasks.slice(batchStart, batchStart + BATCH_SIZE);

      // Collect new task rows for bulk insert
      const pendingInserts: Array<{ row: ConnectorTaskRecord; remoteTask: TaskItem }> = [];
      // Track tasks that need individual updates (conflict resolution / remote-newer)
      const pendingUpdates: Array<{ existing: ConnectorTaskRecord; remoteTask: TaskItem }> = [];
      const pendingAdoptions: Array<{ existing: ConnectorTaskRecord; remoteTask: TaskItem }> = [];

      for (const remoteTask of batch) {
        remoteSourceIds.add(remoteTask.sourceId);
        const stableDecision = identityRuntime
          ? identityDecisionBySourceId.get(remoteTask.sourceId)
          : undefined;
        const existing = stableDecision?.selectedLocalId
          ? existingById.get(stableDecision.selectedLocalId)
          : existingBySourceId.get(remoteTask.sourceId);
        if (
          connector.type === 'microsoft-todo'
          && !existing
          && !remoteTask.isChecklistItem
          && !remoteTask.parentId
          && remoteTask.status !== 'done'
          && remoteTask.status !== 'cancelled'
          && archivedRecurringDuplicateSourceIds.has(remoteTask.sourceId)
          && shouldSuppressNonRecurringDuplicate(remoteTask, openRecurringTitleKeys)
        ) {
          audit.push({
            action: 'skipped',
            taskTitle: remoteTask.title,
            taskSourceId: remoteTask.sourceId,
            reason: 'Suppressed exact-title Microsoft To Do copy without recurrence metadata',
          });
          continue;
        }
        const missionControlTaskId = remoteTask.metadata?.missionControlTaskId;
        if (!existing && typeof missionControlTaskId === 'string') {
          const localTask = existingById.get(missionControlTaskId);
          if (localTask?.sourceId.startsWith('local:')) {
            pendingAdoptions.push({ existing: localTask, remoteTask });
            existingBySourceId.set(remoteTask.sourceId, localTask);
            continue;
          }
        }

        await identityRuntime?.assertDecisionsCurrent(
          batch.flatMap((task) => {
            const decision = identityDecisionBySourceId.get(task.sourceId);
            return decision ? [decision] : [];
          }),
        );

        if (!existing) {
          const dbId = randomUUID();
          const insertedTask = {
            id: dbId,
            sourceId: remoteTask.sourceId,
            connectorType: remoteTask.connectorType || connector.type,
            connectorInstanceId: connectorId,
            title: remoteTask.title,
            description: remoteTask.description || null,
            status: remoteTask.status,
            localDisposition: 'active',
            microStatus: remoteTask.microStatus || null,
            statusReason: remoteTask.statusReason || null,
            priority: remoteTask.priority || 'none',
            planningHorizon: null,
            dueDate: remoteTask.dueDate || null,
            pushCount: 0,
            createdAt: remoteTask.createdAt || now,
            updatedAt: remoteTask.updatedAt || now,
            completedAt: remoteTask.completedAt || null,
            recurrenceGeneratedFromTaskId: null,
            snoozedUntil: remoteTask.snoozedUntil || null,
            parentId: remoteTask.parentId || null,
            depth: remoteTask.depth || 0,
            isChecklistItem: remoteTask.isChecklistItem || false,
            sourceListId: remoteTask.sourceListId || null,
            sourceListName: (remoteTask.sourceListId && listNameMap.get(remoteTask.sourceListId)) || remoteTask.sourceListName || null,
            assignee: remoteTask.assignee || null,
            metadata: remoteTask.metadata || {},
            syncStatus: 'synced' as const,
            lastSyncedAt: now,
            pushRetryCount: 0,
            kanbanColumn: null,
            kanbanOrder: null,
            reminderAt: null,
            reminderRelative: null,
            reminderDueTime: null,
            effort: remoteTask.effort ?? null,
            isBulkImport: isInitialSync || (!!remoteTask.sourceListId && !existingSourceListIds.has(remoteTask.sourceListId)),
          } satisfies ConnectorTaskRecord;

          pendingInserts.push({ row: insertedTask, remoteTask });
        } else {
          if (remoteTask.id) tempIdToDbId.set(remoteTask.id, existing.id);

          // Terminal status transitions (done/cancelled) from the remote should
          // always propagate regardless of timestamp comparisons. This prevents a
          // race where the push-manager advances lastSyncedAt past the remote's
          // closure timestamp, causing the pull to skip the update.
          const remoteIsTerminal = remoteTask.status === 'done' || remoteTask.status === 'cancelled';
          const statusDiffers = remoteTask.status !== existing.status;
          const forceTerminalSync = remoteIsTerminal && statusDiffers;

          if (existing.syncStatus === 'pending_push' || existing.syncStatus === 'push_error') {
            // The task has unpushed local edits (or a failed push attempt).
            // Only allow the remote to overwrite when it's a terminal status
            // (issue closed/cancelled on the source). Otherwise, skip — the
            // write-through / push-manager will push local changes and the
            // next sync cycle will reconcile.
            // Refs: #1692
            if (stableDecision?.outcome === 'locator_change') {
              await identityRuntime?.assertDecisionsCurrent([stableDecision]);
              await pullPersistence.updateTaskSourceId(existing.id, remoteTask.sourceId);
              existingBySourceId.delete(existing.sourceId);
              const refreshed = { ...existing, sourceId: remoteTask.sourceId };
              existingBySourceId.set(remoteTask.sourceId, refreshed);
              existingById.set(existing.id, refreshed);
            }
            if (forceTerminalSync) {
              pendingUpdates.push({ existing, remoteTask });
              audit.push({ action: 'conflict_resolved', taskTitle: remoteTask.title, taskSourceId: remoteTask.sourceId, taskId: existing.id, reason: 'Remote terminal status — forced sync (local pending edits cleared)' });
            } else {
              skippedPendingPush++;
            }
          } else {
            // Compare against lastSyncedAt (when remote data was last applied) rather
            // than updatedAt. Local-only changes (kanban moves, tags, effort, etc.)
            // bump updatedAt without syncing, which would incorrectly block remote
            // status changes (e.g. an issue closed on GitHub) from being applied.
            const baseline = existing.lastSyncedAt || existing.updatedAt;
            const remoteNewer = remoteTask.updatedAt > baseline;
            const existingMetadata = parseTaskMetadata(existing.metadata);
            const needsRemoteHydration = existing.connectorType === 'microsoft-todo'
              && Object.keys(existingMetadata).length === 0
              && !!remoteTask.metadata
              && Object.keys(remoteTask.metadata).length > 0;
            const needsLinkedResourceHydration = needsMicrosoftTodoLinkedResourceHydration(
              existing.connectorType,
              existingMetadata,
              remoteTask.metadata,
            );
            const needsGitHubCanonicalHydration = existing.connectorType === 'github-issues'
              && typeof existingMetadata.nodeId === 'string'
              && typeof existingMetadata.url !== 'string'
              && typeof remoteTask.metadata?.url === 'string';
            const stableLocatorChanged = stableDecision?.outcome === 'locator_change';
            if (
              remoteNewer
              || forceTerminalSync
              || needsRemoteHydration
              || needsLinkedResourceHydration
              || needsGitHubCanonicalHydration
              || stableLocatorChanged
              || replacementIds.has(remoteTask.sourceId)
            ) {
              pendingUpdates.push({ existing, remoteTask });
              if (!countedSourceIds.has(remoteTask.sourceId)) {
                audit.push({ action: 'updated', taskTitle: remoteTask.title, taskSourceId: remoteTask.sourceId, taskId: existing.id, listName: remoteTask.sourceListName || undefined });
              }
            }
          }
        }
      }

      for (const { existing, remoteTask } of pendingAdoptions) {
        const hasLocalEdits = existing.updatedAt > existing.createdAt;
        const persisted = await pullPersistence.adoptLocalTask({
          taskId: existing.id,
          connectorId,
          remoteSourceId: remoteTask.sourceId,
          hasLocalEdits,
          now,
        });
        if (!persisted) {
          throw new Error(`Failed to adopt pushed task ${remoteTask.sourceId}`);
        }
        existingBySourceId.delete(existing.sourceId);
        existingBySourceId.set(remoteTask.sourceId, persisted);
        if (remoteTask.id) tempIdToDbId.set(remoteTask.id, persisted.id);
        if (hasLocalEdits) {
          tasksToIndex.push(persisted as SearchableTask);
        } else {
          const resolvedName = (remoteTask.sourceListId && listNameMap.get(remoteTask.sourceListId)) || undefined;
          const indexedTask = await applyRemoteUpdate(persisted, remoteTask, now, canSyncTags, resolvedName, caps);
          if (!indexedTask) continue;
          tasksToIndex.push(indexedTask);
        }
        if (!countedSourceIds.has(remoteTask.sourceId)) {
          countedSourceIds.add(remoteTask.sourceId);
          updated++;
          audit.push({
            action: 'conflict_resolved',
            taskTitle: remoteTask.title,
            taskSourceId: remoteTask.sourceId,
            reason: hasLocalEdits
              ? 'Adopted remote identity while preserving newer local edits'
              : 'Adopted remote identity from Mission Control creation marker',
          });
        }
      }

      // ─── Execute bulk insert (single SQL statement for all new tasks) ───
      if (pendingInserts.length > 0) {
        await identityRuntime?.assertDecisionsCurrent(
          pendingInserts.flatMap(({ remoteTask }) => {
            const decision = identityDecisionBySourceId.get(remoteTask.sourceId);
            return decision ? [decision] : [];
          }),
        );
        const persistedBatch = await pullPersistence.insertBatch(
          pendingInserts.map(({ row, remoteTask }) => ({
            task: row,
            tags: canSyncTags ? remoteTask.tags ?? [] : [],
          })),
        );
        const persistedBySourceId = new Map(
          persistedBatch.records.map(row => [row.sourceId, row]),
        );

        for (const { row, remoteTask } of pendingInserts) {
          const persisted = persistedBySourceId.get(row.sourceId);
          if (!persisted) {
            throw new Error(`Task upsert failed to persist source ${row.sourceId}`);
          }
          const inserted = persistedBatch.insertedIds.has(row.id);

          existingBySourceId.set(row.sourceId, persisted);
          existingById.set(persisted.id, persisted);
          if (remoteTask.id) tempIdToDbId.set(remoteTask.id, persisted.id);

          if (inserted) {
            tasksToIndex.push(row as SearchableTask);
            if (!countedSourceIds.has(remoteTask.sourceId)) {
              countedSourceIds.add(remoteTask.sourceId);
              added++;
              const classification = remoteTask.isChecklistItem || remoteTask.parentId ? 'subtask' : 'parent';
              addedClassification.set(remoteTask.sourceId, classification);
              if (classification === 'subtask') subtasksAdded++;
              else parentTasksAdded++;
              audit.push({ action: 'added', taskTitle: remoteTask.title, taskSourceId: remoteTask.sourceId, taskId: persisted.id, listName: remoteTask.sourceListName || undefined });
            }
          } else {
            const resolvedName = (remoteTask.sourceListId && listNameMap.get(remoteTask.sourceListId)) || undefined;
            const indexedTask = await applyRemoteUpdate(persisted, remoteTask, now, canSyncTags, resolvedName, caps);
            if (indexedTask) tasksToIndex.push(indexedTask);
            if (!countedSourceIds.has(remoteTask.sourceId)) {
              countedSourceIds.add(remoteTask.sourceId);
              updated++;
              audit.push({ action: 'conflict_resolved', taskTitle: remoteTask.title, taskSourceId: remoteTask.sourceId, taskId: persisted.id, reason: 'Concurrent task insert reconciled by source identity' });
            }
          }
        }
      }

      // ─── Execute updates (each needs different SET values per row) ──────
      for (let ui = 0; ui < pendingUpdates.length; ui++) {
        const { existing, remoteTask } = pendingUpdates[ui];
        const decision = identityDecisionBySourceId.get(remoteTask.sourceId);
        if (decision) await identityRuntime?.assertDecisionsCurrent([decision]);
        const resolvedName = (remoteTask.sourceListId && listNameMap.get(remoteTask.sourceListId)) || undefined;
        const indexedTask = await applyRemoteUpdate(existing, remoteTask, now, canSyncTags, resolvedName, caps);
        if (!indexedTask) continue;
        tasksToIndex.push(indexedTask);
        if (existing.sourceId !== remoteTask.sourceId) {
          const refreshed = { ...existing, sourceId: remoteTask.sourceId };
          existingBySourceId.delete(existing.sourceId);
          existingBySourceId.set(remoteTask.sourceId, refreshed);
          existingById.set(existing.id, refreshed);
        }
        if (!countedSourceIds.has(remoteTask.sourceId)) {
          countedSourceIds.add(remoteTask.sourceId);
          updated++;
        }
        if ((ui + 1) % 10 === 0) await yieldToEventLoop();
      }

      if (identityRuntime) {
        const identityWrites: ExternalIdentityWrite[] = [];
        for (const remoteTask of batch) {
          if (!remoteTask.externalIdentity) continue;
          const decision = identityDecisionBySourceId.get(remoteTask.sourceId);
          const persisted = decision?.selectedLocalId
            ? existingById.get(decision.selectedLocalId)
            : existingBySourceId.get(remoteTask.sourceId);
          if (!persisted) {
            throw new Error(`Identity shadow write could not resolve task ${remoteTask.sourceId}`);
          }
          identityWrites.push({
            target: {
              connectorInstanceId: connectorId,
              bindingType: 'task',
              localId: persisted.id,
              legacyIdentity: remoteTask.sourceId,
            },
            evidence: remoteTask.externalIdentity,
          });
        }
        const identityResults = await persistGitHubPrimaryIdentityBatch(
          identityWrites,
          identityRuntime.modeSnapshot,
        );
        const failedIdentity = identityResults.find((result) => result.state !== 'bound');
        if (failedIdentity) {
          throw new Error(
            `GitHub task identity persistence failed: ${
              failedIdentity.collisionCategory ?? failedIdentity.state
            }`,
          );
        }
        const linkedIdentityWrites = new Map<string, {
          linkedSourceId: string;
          sourceId: string;
          evidence: TaskItem['externalIdentity'];
        }>();
        for (const remoteTask of batch) {
          for (const linked of linkedSourcesForRemoteTask(
            remoteTask,
            githubLinkedSourceBySourceId,
            githubLinkedSourceByStableIdentity,
          )) {
            linkedIdentityWrites.set(linked.id, {
            linkedSourceId: linked.id,
            sourceId: linked.sourceId,
            evidence: remoteTask.externalIdentity,
            });
          }
        }
        await persistGitHubLinkedSourceIdentityBatch(
          connectorId,
          [...linkedIdentityWrites.values()],
          identityRuntime.modeSnapshot,
        );
      }

      // Yield to event loop between batches to keep UI responsive
      await yieldToEventLoop();
    }

    syncEventBus.emitSyncEvent({
      type: 'sync:tasks-batch',
      connectorId,
      batchSize: listTasks.length,
      totalSoFar: totalProcessed,
      byStatus: { todo: totalTodo, done: totalDone },
      parentTasks: totalParentTasks,
      subtasks: totalSubtasks,
    });

    // Yield between lists
    await yieldToEventLoop();
  }

    // Keep indexing memory bounded to the current network page.
    for (let i = 0; i < tasksToIndex.length; i += BATCH_SIZE) {
      const chunk = tasksToIndex.slice(i, i + BATCH_SIZE);
      await indexTasksForSearchBatch(chunk);
      if (i + BATCH_SIZE < tasksToIndex.length) {
        await yieldToEventLoop();
      }
    }
    tasksToIndex.length = 0;
    }
  } catch (error) {
    // A prefetched page can still be in flight when processing fails. Settle it
    // before closing the generator so its rejection cannot escape unhandled.
    try {
      await nextPage;
    } catch {
      // Preserve the original processing/fetch error.
    }
    try {
      await pageIterator.return();
    } catch {
      // Preserve the original processing/fetch error.
    }
    throw error;
  }

  // ─── DELETION DETECTION ─────────────────────────────────────────
  // Only run deletion detection during full syncs. During incremental syncs,
  // remoteSourceIds only contains recently-changed tasks, so comparing against
  // all local tasks would incorrectly flag thousands of items as "protected".
  if (isFullSync) {
    // Pass pre-fetched local tasks to avoid a redundant full-table SELECT
    const prefetchedForDeletion = Array.from(existingBySourceId.values()).map(row => ({
      id: row.id,
      sourceId: row.sourceId,
      sourceListId: row.sourceListId,
      syncStatus: row.syncStatus,
      status: row.status,
      title: row.title,
      isChecklistItem: row.isChecklistItem,
      parentId: row.parentId,
      metadata: row.metadata,
    }));
    const currentInaccessibleSourceListIds = new Set(inaccessibleSourceListIds);
    const observationState = (
      connector as IConnector & {
        getIdentityObservationState?: () => Array<{
          sourceId: string;
          state: 'complete' | 'partial' | 'inaccessible';
        }>;
      }
    ).getIdentityObservationState?.() ?? [];
    if (identityRuntime) {
      const observationByRepository = new Map(
        observationState.map((state) => [state.sourceId.toLowerCase(), state.state]),
      );
      const unobservedLinkedSources = githubLinkedSourceRows.filter(
        (linked) => !comparisonObservedLinkedSourceIds.has(linked.id),
      );
      for (let index = 0; index < unobservedLinkedSources.length; index += 500) {
        await identityRuntime.resolveLinkedSourceBatch(
          unobservedLinkedSources.slice(index, index + 500).map((linked) => {
            const repository = githubRepositoryFromLegacySourceId(linked.sourceId);
            const repositoryState = repository
              ? observationByRepository.get(repository.toLowerCase())
              : undefined;
            return {
              candidateKey: `linked:${linked.id}`,
              linkedSourceId: linked.id,
              taskId: linked.taskId,
              sourceId: linked.sourceId,
              evidenceState: repositoryState === 'partial'
                ? 'partial' as const
                : repositoryState === 'inaccessible'
                  ? 'inaccessible' as const
                  : 'missing' as const,
            };
          }),
        );
      }
    }
    for (const state of observationState) {
      if (state.state !== 'complete') currentInaccessibleSourceListIds.add(state.sourceId);
    }

    if (caps?.taskAbsenceMeansDeleted !== false) {
      const deletionResult = await detectDeletions(
        connectorId,
        remoteSourceIds,
        true,
        audit,
        prefetchedForDeletion,
        {
          identityRuntime,
          inaccessibleSourceListIds: currentInaccessibleSourceListIds,
        },
      );
      removed += deletionResult.removed;
      localOnlyProtected = deletionResult.localOnlyProtected;
    }
  }

  if (connector.type === 'github-issues') {
    const observationState = (
      connector as IConnector & {
        getIdentityObservationState?: () => Array<{
          sourceId: string;
          state: 'complete' | 'partial' | 'inaccessible';
        }>;
      }
    ).getIdentityObservationState?.() ?? [];
    const generationComplete = githubHierarchyGenerationComplete
      && observationState.length > 0
      && observationState.every((state) => state.state === 'complete');
    const repositoryAliases = (
      connector as IConnector & {
        getHierarchyRepositoryAliases?: () => Array<{
          sourceId: string;
          canonicalSourceId: string;
        }>;
      }
    ).getHierarchyRepositoryAliases?.() ?? [];
    await reconcileGitHubTaskHierarchy(
      connectorId,
      githubHierarchyObservations,
      new Set(observationState.map((state) => state.sourceId)),
      generationComplete,
      new Map(repositoryAliases.map((alias) => [
        alias.sourceId,
        alias.canonicalSourceId,
      ])),
      {
        identityRuntime,
        requireCompletePopulation: isFullSync === true,
      },
    );
  }

  // ─── PARENT ID RESOLUTION ─────────────────────────────────────
  // Use the pre-fetched map instead of individual queries
  const orphanedItems = await pullPersistence.listChecklistItems(connectorId);

  // Build sourceId → dbId lookup from pre-fetched data
  const sourceIdToDbId = new Map<string, string>();
  for (const row of existingBySourceId.values()) {
    sourceIdToDbId.set(row.sourceId, row.id);
  }

  let resolveCount = 0;
  const parentCorrections: Array<{ taskId: string; parentId: string }> = [];
  for (const item of orphanedItems) {
    if (!item.parentId) continue;
    if (tempIdToDbId.has(item.parentId)) {
      const resolvedId = tempIdToDbId.get(item.parentId)!;
      if (resolvedId !== item.parentId) {
        parentCorrections.push({ taskId: item.id, parentId: resolvedId });
      }
    } else {
      const parts = item.sourceId.split(':');
      if (parts.length >= 3) {
        const parentSourceId = parts.slice(0, -1).join(':');
        const parentDbId = sourceIdToDbId.get(parentSourceId);
        if (parentDbId && parentDbId !== item.parentId) {
          parentCorrections.push({ taskId: item.id, parentId: parentDbId });
        }
      }
    }
    // Yield periodically to keep the event loop responsive
    if (++resolveCount % BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }
  if (parentCorrections.length > 0) {
    await pullPersistence.correctParents(parentCorrections);
  }

  // ─── RECURRING TASK CLEANUP ──────────────────────────────────────
  if (isFullSync) {
    removed += await cleanupCompletedRecurringTasks(connectorId, audit);
  }
  if (connector.type === 'microsoft-todo') {
    removed += await cleanupOpenRecurringTasks(connectorId, audit);
  }

  // Single summary audit entry for skipped pending-push tasks (avoids per-task bloat)
  if (skippedPendingPush > 0) {
    audit.push({ action: 'skipped', taskTitle: `${skippedPendingPush} task(s)`, taskSourceId: connectorId, reason: 'Preserved pending local edits — deferring to write-through' });
  }

  return {
    added,
    updated,
    removed,
    localOnlyProtected,
    parentTasksAdded,
    subtasksAdded,
    remoteSourceIds,
    identityBlocked: identityBlocks.count,
    identityBlockedOutcomes: identityBlocks.outcomes,
  };
}

function githubRepositoryFromLegacySourceId(sourceId: string): string | null {
  const match = /^([^/:]+\/[^/:]+):[1-9]\d*$/.exec(sourceId);
  return match?.[1] ?? null;
}

interface GitHubLinkedSourcePrefetchRow {
  id: string;
  taskId: string;
  sourceId: string;
  entityProvider: string | null;
  entityHostKey: string | null;
  entityType: string | null;
  entityStableId: string | null;
}

function linkedSourcesForRemoteTask(
  remoteTask: TaskItem,
  bySourceId: ReadonlyMap<string, GitHubLinkedSourcePrefetchRow>,
  byStableIdentity: ReadonlyMap<string, GitHubLinkedSourcePrefetchRow>,
): GitHubLinkedSourcePrefetchRow[] {
  const matches = new Map<string, GitHubLinkedSourcePrefetchRow>();
  const legacy = bySourceId.get(remoteTask.sourceId);
  if (legacy) matches.set(legacy.id, legacy);
  const identity = remoteTask.externalIdentity?.entity.identity;
  if (identity?.provider === 'github' && identity.entityType === 'issue') {
    const stable = byStableIdentity.get(
      linkedSourceStableIdentityKey(identity.hostKey, identity.stableId),
    );
    if (stable) matches.set(stable.id, stable);
  }
  return [...matches.values()];
}

function linkedSourceStableIdentityKey(hostKey: string, stableId: string): string {
  return `${hostKey.length}:${hostKey}${stableId}`;
}

async function applyRemoteUpdate(
  existingTask: ConnectorTaskRecord,
  remote: TaskItem,
  now: string,
  canSyncTags = true,
  resolvedListName?: string | null,
  caps?: ConnectorCapabilities | null,
): Promise<SearchableTask | null> {
  // When the connector doesn't support a field, preserve the MC-local value
  // instead of overwriting it with the remote's null/empty value.
  const connectorHasDueDate = caps?.dueDate === true;
  const connectorOwnsSnooze =
    caps?.taskFieldProfile?.snoozedUntil?.authority === 'source';
  const connectorOwnsMicroStatus =
    caps?.taskFieldProfile?.microStatus?.authority === 'source';
  const connectorOwnsStatusReason =
    caps?.taskFieldProfile?.statusReason?.authority === 'source';

  // A remote priority of 'none' means "no priority set" — it should never
  // overwrite a locally-set value. Only an explicit non-none priority from
  // the source wins. This prevents round-trip loss (e.g. MC medium → MS Todo
  // normal → 'none' wiping the user's value).
  const remotePriorityIsExplicit = remote.priority && remote.priority !== 'none';
  const resolvedPriority = remotePriorityIsExplicit
    ? remote.priority
    : (existingTask.priority || 'none');

  // Status protection: GitHub Issues only has open/closed (todo/done), so a
  // remote 'todo' should never overwrite a richer local status like 'in_progress'.
  // Only explicit state transitions (done, cancelled) should overwrite — those
  // represent a real closure event on the source. A remote 'todo' just means
  // "the issue is still open" which is compatible with 'in_progress'.
  const remoteStatusIsDowngrade = (
    remote.connectorType === 'github-issues'
    || existingTask.connectorType === 'github-issues'
  ) && remote.status === 'todo' &&
    existingTask.status === 'in_progress';
  const resolvedStatus = remoteStatusIsDowngrade
    ? existingTask.status
    : remote.status;

  const resolvedDueDate = connectorHasDueDate
    ? (remote.dueDate || null)
    : (remote.dueDate || existingTask.dueDate || null);
  const existingMetadata = parseTaskMetadata(existingTask.metadata);
  const remoteMetadata = remote.metadata && typeof remote.metadata === 'object'
    ? remote.metadata
    : {};
  const githubHierarchyManaged = (
    remote.connectorType === 'github-issues'
    || existingTask.connectorType === 'github-issues'
  );

  const indexedTask = {
    id: existingTask.id,
    title: remote.title,
    description: remote.description || null,
    sourceListName: resolvedListName || remote.sourceListName || existingTask.sourceListName || null,
    connectorType: remote.connectorType || existingTask.connectorType,
    status: resolvedStatus,
    priority: resolvedPriority,
    updatedAt: remote.updatedAt || now,
  };

  const taskUpdate: ConnectorTaskUpdate = {
    sourceId: remote.sourceId,
    title: indexedTask.title,
    description: indexedTask.description,
    status: indexedTask.status,
    microStatus: connectorOwnsMicroStatus
      ? (remote.microStatus || null)
      : existingTask.microStatus,
    statusReason: connectorOwnsStatusReason
      ? (remote.statusReason || null)
      : existingTask.statusReason,
    priority: indexedTask.priority,
    dueDate: resolvedDueDate,
    updatedAt: indexedTask.updatedAt,
    // Prefer the remote completedAt when provided. If the remote doesn't return one
    // (many connectors omit it) but the task is still done, keep the locally-recorded
    // timestamp so the "completed today" counter survives syncs and server restarts.
    completedAt: remote.completedAt || (resolvedStatus === 'done' ? existingTask.completedAt : null),
    snoozedUntil: connectorOwnsSnooze
      ? (remote.snoozedUntil || null)
      : existingTask.snoozedUntil,
    isChecklistItem: remote.isChecklistItem ?? existingTask.isChecklistItem,
    sourceListId: remote.sourceListId || existingTask.sourceListId || null,
    sourceListName: indexedTask.sourceListName,
    connectorType: indexedTask.connectorType,
    assignee: remote.assignee || null,
    metadata: { ...existingMetadata, ...remoteMetadata },
    syncStatus: 'synced',
    lastSyncedAt: now,
  };
  if (
    resolvedDueDate !== existingTask.dueDate
    && isReminderRelativeRule(existingTask.reminderRelative ?? '')
  ) {
    const reminderMutation = resolveRelativeReminderMutation({
      current: existingTask,
      input: { dueDate: resolvedDueDate },
      timezone: getTimezone(),
      now: new Date(now),
    });
    Object.assign(
      taskUpdate,
      reminderMutation.success ? reminderMutation.updates : { reminderAt: null },
    );
  }
  if (!githubHierarchyManaged) {
    taskUpdate.parentId = remote.parentId || existingTask.parentId || null;
    taskUpdate.depth = remote.depth ?? existingTask.depth;
  }

  const persistence = (await getWorkerPersistenceRepositories()).execution.pulls;
  const applied = await persistence.applyRemoteUpdate({
    taskId: existingTask.id,
    expectedSyncStatus: existingTask.syncStatus,
    values: taskUpdate,
    sourceTags: canSyncTags ? remote.tags || [] : undefined,
  });

  return applied ? indexedTask : null;
}

function parseTaskMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }

  if (typeof metadata !== 'string') return {};

  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

interface ArchivedTreeTask {
  taskId: string;
  taskTitle: string;
  taskSourceId: string;
  deletionSnapshotId: string;
  reason: string;
}

async function deleteSyncedTask(taskId: string, reason: string): Promise<ArchivedTreeTask[]> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.pulls;
  const childTasks = await persistence.listChildren(taskId);
  const archivedTasks: ArchivedTreeTask[] = [];
  for (const childTaskId of childTasks) {
    archivedTasks.push(...await deleteSyncedTask(childTaskId, `${reason} (child task)`));
  }
  const archived = await archiveAndDeleteTask(taskId, reason);
  if (archived) {
    archivedTasks.push({
      taskId,
      taskTitle: archived.taskTitle,
      taskSourceId: archived.sourceId,
      deletionSnapshotId: archived.snapshotId,
      reason,
    });
  }
  return archivedTasks;
}

// ─── Tag upsert ────────────────────────────────────────────────────────

export async function upsertTaskTags(
  taskId: string,
  remoteTags: PullTag[],
  tagsBySlug?: Map<string, { id: string; type: string }>,
  /** When true, skip querying for existing tag links (used for newly-inserted tasks). */
  isNewTask?: boolean,
): Promise<void> {
  void tagsBySlug;
  void isNewTask;
  const persistence = (await getWorkerPersistenceRepositories()).execution.pulls;
  await persistence.replaceSourceTags(taskId, remoteTags);
}

/**
 * Deduplicate completed recurring task instances.
 */
async function cleanupCompletedRecurringTasks(
  connectorId: string,
  audit: SyncAuditEntry[],
): Promise<number> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.pulls;
  const completedTasks = (await persistence.listTasks(connectorId))
    .filter((task) => task.status === 'done');

  const groups = new Map<string, Array<{ id: string; sourceId: string; title: string; completedAt: string | null; updatedAt: string }>>();

  for (const task of completedTasks) {
    const key = getRecurringSeriesKey(task);
    if (!key) continue;
    const group = groups.get(key);
    const entry = { id: task.id, sourceId: task.sourceId, title: task.title, completedAt: task.completedAt, updatedAt: task.updatedAt };
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  let removed = 0;
  for (const [, group] of groups) {
    if (group.length <= 1) continue;

    group.sort((a, b) => {
      const aDate = a.completedAt || a.updatedAt;
      const bDate = b.completedAt || b.updatedAt;
      return bDate.localeCompare(aDate);
    });

    for (let i = 1; i < group.length; i++) {
      const toDelete = group[i];
      const reason = 'Older completed recurring instance — deduplicated';
      const archivedTasks = await deleteSyncedTask(toDelete.id, reason);
      removed++;
      for (const archived of archivedTasks) {
        audit.push({ action: 'removed', ...archived });
      }
    }
  }

  if (removed > 0) {
    syncLogger.info({ connectorId, removedCount: removed }, 'Cleaned up old completed recurring task instances');
  }

  return removed;
}

async function cleanupOpenRecurringTasks(
  connectorId: string,
  audit: SyncAuditEntry[],
): Promise<number> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.pulls;
  const historyTasks = (await persistence.listTasks(connectorId))
    .filter((task) => task.depth === 0);
  const openTasks = historyTasks.filter(
    (task) => task.status === 'todo' || task.status === 'in_progress',
  );
  const knownRecurringTitleKeys = inferRecurringTitleKeys(historyTasks);
  const duplicateGroups = findOpenRecurringTaskDuplicates(
    openTasks,
    getLocalToday(),
    knownRecurringTitleKeys,
  );
  let removed = 0;

  for (const group of duplicateGroups) {
    for (const duplicate of group.duplicates) {
      const reason = `Duplicate open Microsoft To Do recurrence — kept ${group.keeper.id}`;
      const archivedTasks = await deleteSyncedTask(duplicate.id, reason);
      removed++;
      for (const archived of archivedTasks) {
        audit.push({ action: 'removed', ...archived });
      }
    }
  }

  if (removed > 0) {
    syncLogger.info({ connectorId, removedCount: removed }, 'Cleaned up duplicate open recurring task instances');
  }

  return removed;
}
