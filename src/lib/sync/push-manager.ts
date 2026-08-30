import type { IConnector } from '@/lib/connectors';
import type { TaskItem } from '@/types';
import type { SyncAuditEntry } from './index';
import type { ConnectorTaskRecord } from '@/db/persistence/connector-execution';
import { resolvePersistedConnectorCapabilities } from '@/lib/connectors/resolved-capabilities';
import { syncLogger } from '@/lib/logger';
import { isDemoMode } from '@/lib/mode';
import {
  claimTaskForPush,
  completeTaskPush,
  failTaskPush,
  heartbeatTaskPush,
  loadClaimedTaskForPush,
  releaseTaskPush,
} from './push-lease';
import {
  ConnectorOperationBusyError,
  runWithConnectorOperationLease,
} from './connector-lock';
import { archiveAndDeleteTask } from './deletion-recovery';
import {
  authorizeGitHubWrite,
  assertGitHubWriteCycleCurrent,
  beginGitHubWriteCycle,
  blockGitHubWrite,
  confirmGitHubWriteDispatch,
  hasSucceededGitHubWrite,
  verifyGitHubWritePreflight,
  finalizeGitHubWrite,
  quarantineUnknownGitHubWrite,
  finishGitHubWriteCycle,
  GitHubWriteFenceError,
  GitHubUnknownWriteOutcomeError,
  type GitHubWriteAuthorization,
} from '@/lib/external-identities/github-write-fence';
import type {
  GitHubStableIdentityRuntime,
} from '@/lib/external-identities/stable-identity-runtime';
import {
  persistGitHubPrimaryIdentityBatch,
} from '@/lib/external-identities/primary-identity';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/** Maximum number of push retries before marking a task as permanently failed */
const MAX_PUSH_RETRIES = 5;

type PushPendingOptions = {
  deleteGhostsOnNotFound?: boolean;
  identityRuntime?: GitHubStableIdentityRuntime;
  identityMode?: { modeRevision: number };
  jobId?: string;
  connectorOperationLeaseHeld?: boolean;
};

/** Yield to the event loop so healthchecks and other callbacks can run */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 25));
}

/**
 * Handles pushing pending local changes (creates, updates, completions, deletions) to remote connectors.
 */
export async function pushPendingChanges(
  connectorId: string,
  connector: IConnector,
  auditLog?: SyncAuditEntry[],
  taskIds?: string[],
  options?: PushPendingOptions,
): Promise<{ pushed: number; errors: string[] }> {
  const fencedGitHubPush = connector.type === 'github-issues'
    && options?.identityMode !== undefined;
  if (!fencedGitHubPush || options?.connectorOperationLeaseHeld) {
    return pushPendingChangesWithLease(connectorId, connector, auditLog, taskIds, options);
  }
  try {
    return await runWithConnectorOperationLease(
      connectorId,
      'sync',
      () => pushPendingChangesWithLease(
        connectorId,
        connector,
        auditLog,
        taskIds,
        { ...options, connectorOperationLeaseHeld: true },
      ),
    );
  } catch (error) {
    if (error instanceof ConnectorOperationBusyError) {
      return { pushed: 0, errors: [] };
    }
    throw error;
  }
}

async function pushPendingChangesWithLease(
  connectorId: string,
  connector: IConnector,
  auditLog?: SyncAuditEntry[],
  taskIds?: string[],
  options?: PushPendingOptions,
): Promise<{ pushed: number; errors: string[] }> {
  const repositories = await getWorkerPersistenceRepositories();
  const execution = repositories.execution;
  execution.support.assertConnectorSupported(connector);
  if (isDemoMode()) {
    return { pushed: 0, errors: [] };
  }

  const errors: string[] = [];
  const pushFailures: unknown[] = [];
  const audit = auditLog || [];
  let pushed = 0;
  const persistence = execution.pushes;

  const persistedConnector = await repositories.connectors.get(connectorId);
  const caps = persistedConnector
    ? resolvePersistedConnectorCapabilities({
        type: persistedConnector.type,
        capabilities: persistedConnector.capabilities,
        settings: persistedConnector.settings,
      })
    : connector.capabilities ?? null;
  const canWrite = !caps || caps.write !== false;
  const canCreate = !caps || (
    caps.notificationOnly !== true
    && (caps.taskCreate ?? caps.write) !== false
  );
  const canDelete = !caps || caps.delete !== false;
  const fencedGitHubPush = connector.type === 'github-issues'
    && options?.identityMode !== undefined;

  if (taskIds && taskIds.length === 0) {
    return { pushed: 0, errors: [] };
  }

  const pendingTasks = await persistence.listCandidates({
    connectorId,
    taskIds,
    includePushing: true,
  });
  await Promise.all(pendingTasks
    .filter((task) => task.sourceId.startsWith('checklist:'))
    .map((task) => persistence.markSynced(task.id, new Date().toISOString())));
  const parentIds = [...new Set(pendingTasks
    .filter((task) => task.isChecklistItem && task.parentId)
    .map((task) => task.parentId!))];
  const parentTasks = parentIds.length === 0
    ? []
    : await persistence.listSourceIds(parentIds);
  const parentSourceIds = new Map(parentTasks.map((task) => [task.id, task.sourceId]));
  const pushLeaseTokens = new Map<string, string>();
  const claimedTasksById = new Map<string, ConnectorTaskRecord>();
  if (fencedGitHubPush) {
    for (const task of pendingTasks) {
      const operation = remoteDispatchOperation(
        task,
        connector,
        { canWrite, canCreate, canDelete },
        parentSourceIds,
      );
      if (!operation) continue;
      const token = await claimTaskForPush(task.id);
      if (!token) continue;
      const claimedTask = await loadClaimedTaskForPush(task.id, token);
      if (!claimedTask) continue;
      if (await hasSucceededGitHubWrite({
        connectorInstanceId: connectorId,
        taskId: claimedTask.id,
        operation,
        expectedTaskVersion: claimedTask.updatedAt,
        taskPushLeaseToken: token,
      })) {
        const identityPending = operation === 'create'
          || (
            operation === 'sub_issue'
            && claimedTask.isChecklistItem
            && claimedTask.sourceId === claimedTask.id
          );
        if (identityPending || operation === 'update') {
          await failTaskPush(
            claimedTask.id,
            token,
            'push_failed',
            MAX_PUSH_RETRIES,
            claimedTask.updatedAt,
          );
          audit.push({
            action: 'protected',
            taskTitle: claimedTask.title,
            taskSourceId: claimedTask.sourceId,
            taskId: claimedTask.id,
            reason: identityPending
              ? 'GitHub create already succeeded but its returned identity was not persisted; reconciliation is required'
              : 'GitHub update already succeeded but its returned terminal projection was not persisted; readback is required',
          });
        } else {
          await completeTaskPush(
            claimedTask.id,
            token,
            claimedTask.sourceId,
            undefined,
            undefined,
            claimedTask.updatedAt,
          );
          audit.push({
            action: 'pushed',
            taskTitle: claimedTask.title,
            taskSourceId: claimedTask.sourceId,
            taskId: claimedTask.id,
            reason: 'Identical GitHub write was already durably finalized',
          });
        }
        continue;
      }
      pushLeaseTokens.set(task.id, token);
    }
    const claimedTasks = (await Promise.all([...pushLeaseTokens].map(
      async ([taskId, token]) => loadClaimedTaskForPush(taskId, token),
    ))).filter((task): task is ConnectorTaskRecord => task !== null);
    const claimedParentIds = [...new Set(claimedTasks
      .filter((task) => task.isChecklistItem && task.parentId)
      .map((task) => task.parentId!))];
    const claimedParents = claimedParentIds.length === 0
      ? []
      : await persistence.listSourceIds(claimedParentIds);
    const claimedParentSourceIds = new Map(
      claimedParents.map((task) => [task.id, task.sourceId]),
    );
    for (const task of claimedTasks) claimedTasksById.set(task.id, task);
    await Promise.all([...pushLeaseTokens].map(async ([taskId, token]) => {
      const task = claimedTasksById.get(taskId);
      if (
        task
        && remoteDispatchOperation(
          task,
          connector,
          { canWrite, canCreate, canDelete },
          claimedParentSourceIds,
        )
      ) return;
      pushLeaseTokens.delete(taskId);
      const original = pendingTasks.find((candidate) => candidate.id === taskId);
      await releaseTaskPush(
        taskId,
        token,
        releaseStatusFor(original?.syncStatus),
        task?.updatedAt,
      );
    }));
    if (pushLeaseTokens.size === 0) return { pushed: 0, errors: [] };
  } else if (pendingTasks.length === 0) {
    return { pushed: 0, errors: [] };
  }
  let writeCycleId: string | null = null;
  if (fencedGitHubPush) {
    try {
      writeCycleId = await beginGitHubWriteCycle({
        connectorInstanceId: connectorId,
        modeSnapshot: options!.identityMode!,
        jobId: options?.jobId,
        pendingCandidateCount: pushLeaseTokens.size,
      });
    } catch (error) {
      await Promise.all([...pushLeaseTokens].map(([taskId, token]) => {
        const task = claimedTasksById.get(taskId);
        return releaseTaskPush(
          taskId,
          token,
          releaseStatusFor(task?.syncStatus),
          task?.updatedAt,
        );
      }));
      if (
        error instanceof GitHubWriteFenceError
        && ['active_write_cycle', 'write_cycle_busy'].includes(error.code)
      ) {
        return { pushed: 0, errors: [] };
      }
      throw error;
    }
  }
  const cycleOutcome = {
    writeCycleId,
    observed: 0,
    applied: 0,
    blocked: 0,
    failed: 0,
    unknown: 0,
  };

  const resilienceCatches = pendingTasks.filter(t =>
    t.syncStatus !== 'pending_push' && t.syncStatus !== 'push_error'
  );
  if (resilienceCatches.length > 0) {
    syncLogger.info({
      connectorId,
      count: resilienceCatches.length,
      tasks: resilienceCatches.slice(0, 5).map(t => ({
        title: t.title,
        sourceId: t.sourceId,
        syncStatus: t.syncStatus,
      })),
    }, 'Resilience: found locally-created tasks that need pushing (missed by write-through)');
  }

  for (let pi = 0; pi < pendingTasks.length; pi++) {
    let task = pendingTasks[pi];
    if (fencedGitHubPush && !pushLeaseTokens.has(task.id)) continue;
    let pushLeaseToken: string | null = pushLeaseTokens.get(task.id) ?? null;
    if (fencedGitHubPush && pushLeaseToken) {
      const claimedTask = await loadClaimedTaskForPush(task.id, pushLeaseToken);
      if (!claimedTask) {
        pushLeaseTokens.delete(task.id);
        continue;
      }
      task = claimedTask;
    }
    if (
      !pushLeaseToken
      && remoteDispatchOperation(
        task,
        connector,
        { canWrite, canCreate, canDelete },
        parentSourceIds,
      )
    ) {
      pushLeaseToken = await claimTaskForPush(task.id);
      if (!pushLeaseToken) continue;
      const claimedTask = await loadClaimedTaskForPush(task.id, pushLeaseToken);
      if (!claimedTask) continue;
      task = claimedTask;
    }
    const isPendingCreate = task.sourceId.startsWith('local:')
      || (task.isChecklistItem && task.sourceId === task.id);
    // Yield every 5 tasks to keep healthchecks responsive
    if (pi > 0 && pi % 5 === 0) await yieldToEventLoop();

    try {
      const isLocallyCreatedSubtask = task.isChecklistItem && task.sourceId === task.id;
      if (task.syncStatus === 'synced' && !task.sourceId.startsWith('local:') && !isLocallyCreatedSubtask) {
        continue;
      }

      // Legacy checklist items (body checkboxes) can't be pushed individually —
      // they're synced as part of the parent issue's description.
      if (task.sourceId.startsWith('checklist:')) {
        await persistence.markSynced(task.id, new Date().toISOString());
        continue;
      }

      if (task.sourceId.startsWith('local:')) {
        if (!canCreate) {
          audit.push({ action: 'protected', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Task creation disabled for connector' });
          continue;
        }
        if (connector.createTask) {
          pushLeaseToken ??= await claimTaskForPush(task.id);
          if (!pushLeaseToken) {
            continue;
          }
          const heartbeat = async () => {
            const renewed = await heartbeatTaskPush(task.id, pushLeaseToken!);
            if (!renewed) throw new Error('Task push lease was lost');
            pushLeaseToken = renewed;
          };
          await heartbeat();
          const created = await dispatchGitHubWrite(
            connectorId, connector, task, pushLeaseToken, 'create', options, cycleOutcome, [],
            () => connector.createTask!({
            title: task.title,
            description: task.description ?? '',
            status: task.status as TaskItem['status'],
            priority: task.priority as TaskItem['priority'],
            dueDate: task.dueDate || undefined,
            sourceListId: task.sourceListId || undefined,
            metadata: connector.type === 'microsoft-todo'
              ? {
                  ...(task.metadata as Record<string, unknown>),
                  missionControlPushHeartbeat: heartbeat,
                }
              : task.metadata as Record<string, unknown>,
            }),
          );

          await persistCreatedGitHubIdentity(
            connectorId,
            task.id,
            created,
            options?.identityRuntime,
          );
          const finalized = await completeTaskPush(
            task.id,
            pushLeaseToken,
            created.sourceId,
            created.metadata,
            undefined,
            task.updatedAt,
            task.sourceId,
          );
          if (!finalized) continue;

          pushed++;
          audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Created on remote' });
        }
      } else if (isLocallyCreatedSubtask && !task.parentId) {
        audit.push({
          action: 'protected',
          taskId: task.id,
          taskTitle: task.title,
          taskSourceId: task.sourceId,
          reason: 'Locally-created subtask retained after its upstream parent was removed',
        });
      } else if (isLocallyCreatedSubtask && task.parentId) {
        if (!canWrite) {
          audit.push({ action: 'protected', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Write disabled for connector' });
          continue;
        }
        if (connector.createSubTask) {
          const [parentTask] = await persistence.listSourceIds([task.parentId]);
          if (parentTask && !parentTask.sourceId.startsWith('local:') && parentTask.sourceId !== task.parentId) {
            pushLeaseToken ??= await claimTaskForPush(task.id);
            if (!pushLeaseToken) {
              continue;
            }
            const created = await dispatchGitHubWrite(
              connectorId, connector, task, pushLeaseToken, 'sub_issue', options, cycleOutcome,
              [{ role: 'parent_issue', taskId: parentTask.id }],
              () => connector.createSubTask!(parentTask.sourceId, {
              title: task.title,
              status: task.status as TaskItem['status'],
              }),
            );

            await persistCreatedGitHubIdentity(
              connectorId,
              task.id,
              created,
              options?.identityRuntime,
            );
            const finalized = await completeTaskPush(
              task.id,
              pushLeaseToken,
              created.sourceId,
              created.metadata,
              undefined,
              task.updatedAt,
              task.sourceId,
            );
            if (!finalized) continue;

            pushed++;
            audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Created checklist item on remote' });
          } else {
            audit.push({ action: 'push_failed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Parent task not yet synced' });
          }
        } else {
          if (pushLeaseToken) {
            if (!await completeTaskPush(
              task.id, pushLeaseToken, task.sourceId, undefined, undefined, task.updatedAt,
            )) continue;
          } else {
            await persistence.markSynced(task.id, new Date().toISOString());
          }
        }
      } else if (task.status === 'done' && task.isChecklistItem && task.parentId && connector.completeSubTask) {
        if (!canWrite) {
          audit.push({ action: 'protected', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Write disabled for connector' });
          continue;
        }
        const [parentTask] = await persistence.listSourceIds([task.parentId]);
        if (parentTask && !parentTask.sourceId.startsWith('local:') && parentTask.sourceId !== task.parentId) {
          await dispatchGitHubWrite(
            connectorId, connector, task, pushLeaseToken, 'sub_issue', options, cycleOutcome,
            [{ role: 'parent_issue', taskId: parentTask.id }],
            () => connector.completeSubTask!(parentTask.sourceId, task.sourceId),
          );
          if (pushLeaseToken) {
            if (!await completeTaskPush(
              task.id, pushLeaseToken, task.sourceId, undefined, undefined, task.updatedAt,
            )) continue;
          } else {
            await persistence.markSynced(task.id, new Date().toISOString());
          }
          pushed++;
          audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Marked checklist item complete on remote' });
        } else {
          audit.push({ action: 'push_failed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Parent task not found or not synced' });
        }
      } else if (task.status === 'done' && connector.completeTask) {
        if (!canWrite) {
          audit.push({ action: 'protected', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Write disabled for connector' });
          continue;
        }
        await dispatchGitHubWrite(
          connectorId, connector, task, pushLeaseToken, 'complete', options, cycleOutcome, [],
          () => connector.completeTask!(task.sourceId),
        );
        if (pushLeaseToken) {
          if (!await completeTaskPush(
            task.id, pushLeaseToken, task.sourceId, undefined, undefined, task.updatedAt,
          )) continue;
        } else {
          await persistence.markSynced(task.id, new Date().toISOString());
        }
        pushed++;
        audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Marked complete on remote' });
      } else if (task.status === 'cancelled' && connector.deleteTask) {
        if (!canDelete) {
          audit.push({ action: 'protected', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Delete disabled for connector' });
          continue;
        }
        await dispatchGitHubWrite(
          connectorId, connector, task, pushLeaseToken, 'delete', options, cycleOutcome, [],
          () => connector.deleteTask!(task.sourceId),
        );
        if (pushLeaseToken) {
          if (!await completeTaskPush(
            task.id, pushLeaseToken, task.sourceId, undefined, undefined, task.updatedAt,
          )) continue;
        } else {
          await persistence.markSynced(task.id, new Date().toISOString());
        }
        pushed++;
        audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Deleted on remote' });
      } else if (task.isChecklistItem && task.parentId && connector.updateSubTask) {
        if (!canWrite) {
          audit.push({ action: 'protected', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Write disabled for connector' });
          continue;
        }
        const [parentTask] = await persistence.listSourceIds([task.parentId]);
        if (parentTask && !parentTask.sourceId.startsWith('local:') && parentTask.sourceId !== task.parentId) {
          await dispatchGitHubWrite(
            connectorId, connector, task, pushLeaseToken, 'sub_issue', options, cycleOutcome,
            [{ role: 'parent_issue', taskId: parentTask.id }],
            () => connector.updateSubTask!(parentTask.sourceId, task.sourceId, {
            title: task.title,
            status: task.status as TaskItem['status'],
            }),
          );
          if (pushLeaseToken) {
            if (!await completeTaskPush(
              task.id, pushLeaseToken, task.sourceId, undefined, undefined, task.updatedAt,
            )) continue;
          } else {
            await persistence.markSynced(task.id, new Date().toISOString());
          }
          pushed++;
          audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Updated checklist item on remote' });
        } else {
          audit.push({ action: 'push_failed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Parent task not found or not synced' });
        }
      } else if (connector.updateTask) {
        if (!canWrite) {
          audit.push({ action: 'protected', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Write disabled for connector' });
          continue;
        }
        const remoteResult = await dispatchGitHubWrite(
          connectorId, connector, task, pushLeaseToken, 'update', options, cycleOutcome, [],
          () => connector.updateTask!(task.sourceId, {
          title: task.title,
          description: task.description ?? '',
          status: task.status as TaskItem['status'],
          priority: task.priority as TaskItem['priority'],
          effort: task.effort ?? undefined,
          dueDate: task.dueDate || undefined,
          }),
        );

        // If the remote reports a terminal status that differs from local,
        // apply it immediately. This handles the case where a task is set to
        // 'in_progress' locally but the upstream issue is already closed — the
        // connector can't represent 'in_progress' so the issue stays closed,
        // and without this check the task would remain stuck indefinitely
        // because subsequent incremental pulls won't re-fetch it.
        const remoteIsTerminal = remoteResult?.status === 'done' || remoteResult?.status === 'cancelled';
        const localNonTerminal = task.status !== 'done' && task.status !== 'cancelled';
        if (remoteIsTerminal && localNonTerminal) {
          if (pushLeaseToken) {
            if (!await completeTaskPush(
              task.id,
              pushLeaseToken,
              task.sourceId,
              undefined,
              {
                status: remoteResult.status,
                completedAt: remoteResult.completedAt || new Date().toISOString(),
              },
              task.updatedAt,
            )) continue;
          } else {
            await persistence.markSynced(task.id, new Date().toISOString(), {
              status: remoteResult.status,
              completedAt: remoteResult.completedAt || new Date().toISOString(),
            });
          }
          pushed++;
          audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: `Remote is ${remoteResult.status} — applied terminal status from remote` });
        } else {
          if (pushLeaseToken) {
            if (!await completeTaskPush(
              task.id, pushLeaseToken, task.sourceId, undefined, undefined, task.updatedAt,
            )) continue;
          } else {
            await persistence.markSynced(task.id, new Date().toISOString());
          }
          pushed++;
          audit.push({ action: 'pushed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: 'Updated on remote' });
        }
      } else {
        await persistence.markSynced(task.id, new Date().toISOString());
      }
    } catch (err) {
      pushFailures.push(err);
      if (
        err instanceof GitHubWriteFenceError
        && err.code === 'stale_task_push_claim'
        && writeCycleId
      ) {
        audit.push({
          action: 'protected',
          taskTitle: task.title,
          taskSourceId: task.sourceId,
          taskId: task.id,
          reason: 'Task changed after its GitHub push claim; the stale snapshot was not dispatched',
        });
        continue;
      }
      if (
        err instanceof GitHubWriteFenceError
        && err.code === 'write_already_succeeded'
        && writeCycleId
        && pushLeaseToken
      ) {
        const operation = remoteDispatchOperation(
          task,
          connector,
          { canWrite, canCreate, canDelete },
          parentSourceIds,
        );
        if (isPendingCreate || operation === 'update') {
          await failTaskPush(
            task.id,
            pushLeaseToken,
            'push_failed',
            MAX_PUSH_RETRIES,
            task.updatedAt,
          );
          audit.push({
            action: 'protected',
            taskTitle: task.title,
            taskSourceId: task.sourceId,
            taskId: task.id,
            reason: isPendingCreate
              ? 'GitHub create already succeeded but its returned identity was not persisted; reconciliation is required'
              : 'GitHub update already succeeded but its returned terminal projection was not persisted; readback is required',
          });
        } else {
          await completeTaskPush(
            task.id,
            pushLeaseToken,
            task.sourceId,
            undefined,
            undefined,
            task.updatedAt,
          );
          audit.push({
            action: 'pushed',
            taskTitle: task.title,
            taskSourceId: task.sourceId,
            taskId: task.id,
            reason: 'Identical GitHub write was already durably finalized',
          });
        }
        continue;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const msg = `Push failed for task "${task.title}": ${errMsg}`;
      errors.push(msg);
      if (err instanceof GitHubWriteFenceError) cycleOutcome.blocked++;
      else if (err instanceof GitHubUnknownWriteOutcomeError) cycleOutcome.unknown++;
      else cycleOutcome.failed++;

      // Detect 404/410 — the task was deleted or transferred on the remote.
      // Remove it locally rather than retrying forever.
      const is404or410 = /\b(404|410)\b/.test(errMsg);
      if (
        is404or410
        && !isPendingCreate
        && options?.deleteGhostsOnNotFound !== false
      ) {
        const reason = 'Remote returned 404/410 — task deleted or transferred';
        const archived = await archiveAndDeleteTask(task.id, reason);
        audit.push({
          action: 'removed',
          taskTitle: task.title,
          taskSourceId: task.sourceId,
          taskId: task.id,
          deletionSnapshotId: archived?.snapshotId,
          reason,
        });
        syncLogger.info({ taskId: task.id, title: task.title }, 'Removed ghost task after 404/410 from remote');
        continue;
      }

      audit.push({ action: 'push_failed', taskTitle: task.title, taskSourceId: task.sourceId, taskId: task.id, reason: errMsg });

      if (err instanceof GitHubUnknownWriteOutcomeError && connector.type === 'github-issues') {
        if (pushLeaseToken) {
          await failTaskPush(
            task.id,
            pushLeaseToken,
            'push_failed',
            MAX_PUSH_RETRIES,
            task.updatedAt,
          );
        }
        audit.push({
          action: 'protected',
          taskTitle: task.title,
          taskSourceId: task.sourceId,
          taskId: task.id,
          reason: 'Unknown GitHub post-dispatch outcome quarantined; explicit reconciliation is required',
        });
        continue;
      }

      const newRetryCount = (task.pushRetryCount || 0) + 1;
      if (newRetryCount >= MAX_PUSH_RETRIES) {
        // Permanently failed — stop retrying
        if (pushLeaseToken) {
          await failTaskPush(
            task.id,
            pushLeaseToken,
            'push_failed',
            newRetryCount,
            task.updatedAt,
          );
        } else {
          await persistence.markFailure(task.id, 'push_failed', newRetryCount);
        }
        syncLogger.warn({ taskId: task.id, title: task.title, retries: newRetryCount }, 'Push permanently failed after max retries');
      } else {
        if (pushLeaseToken) {
          await failTaskPush(
            task.id,
            pushLeaseToken,
            'push_error',
            newRetryCount,
            task.updatedAt,
          );
        } else {
          await persistence.markFailure(task.id, 'push_error', newRetryCount);
        }
      }
    } finally {
      if (pushLeaseToken) {
        await releaseTaskPush(
          task.id,
          pushLeaseToken,
          releaseStatusFor(task.syncStatus),
          task.updatedAt,
        );
      }
    }
  }

  if (writeCycleId) {
    if (!(await finishGitHubWriteCycle(writeCycleId, cycleOutcome))) {
      syncLogger.error({
        connectorId,
        writeCycleId,
        cycleOutcome,
        pushFailureCount: pushFailures.length,
      }, 'GitHub write cycle did not finish in a complete owned state');
    }
  }
  return { pushed, errors };
}

function remoteDispatchOperation(
  task: ConnectorTaskRecord,
  connector: IConnector,
  capabilities: { canWrite: boolean; canCreate: boolean; canDelete: boolean },
  parentSourceIds: ReadonlyMap<string, string>,
): 'create' | 'update' | 'complete' | 'delete' | 'sub_issue' | null {
  const localSubtask = task.isChecklistItem && task.sourceId === task.id;
  if (task.sourceId.startsWith('checklist:')) return null;
  if (task.sourceId.startsWith('local:')) {
    return capabilities.canCreate && connector.createTask ? 'create' : null;
  }
  if (task.isChecklistItem && task.parentId) {
    const parentSourceId = parentSourceIds.get(task.parentId);
    if (
      !parentSourceId
      || parentSourceId.startsWith('local:')
      || parentSourceId === task.parentId
    ) return null;
  }
  if (localSubtask) {
    return task.parentId
      && capabilities.canWrite
      && connector.createSubTask
      ? 'sub_issue'
      : null;
  }
  if (task.status === 'done' && task.isChecklistItem && task.parentId) {
    return capabilities.canWrite && connector.completeSubTask ? 'sub_issue' : null;
  }
  if (task.status === 'done') {
    return capabilities.canWrite && connector.completeTask ? 'complete' : null;
  }
  if (task.status === 'cancelled') {
    return capabilities.canDelete && connector.deleteTask ? 'delete' : null;
  }
  if (task.isChecklistItem && task.parentId) {
    return capabilities.canWrite && connector.updateSubTask ? 'sub_issue' : null;
  }
  return capabilities.canWrite && connector.updateTask ? 'update' : null;
}

function releaseStatusFor(syncStatus: string | undefined): string {
  return !syncStatus || syncStatus === 'pushing' ? 'pending_push' : syncStatus;
}

async function dispatchGitHubWrite<T>(
  connectorId: string,
  connector: IConnector,
  task: ConnectorTaskRecord,
  taskPushLeaseToken: string | null,
  operation: 'create' | 'update' | 'complete' | 'delete' | 'sub_issue',
  options: Parameters<typeof pushPendingChanges>[4],
  cycle: {
    writeCycleId: string | null;
    observed: number;
    applied: number;
    blocked: number;
    failed: number;
    unknown: number;
  },
  participantTaskIds: ReadonlyArray<{ role: 'parent_issue'; taskId: string }> = [],
  dispatch: () => Promise<T>,
): Promise<T> {
  if (connector.type !== 'github-issues') return dispatch();
  if (options?.identityMode === undefined) {
    throw new GitHubWriteFenceError('missing_frozen_identity_mode');
  }

  const authorization = await authorizeGitHubWrite({
    connectorInstanceId: connectorId,
    taskId: task.id,
    operation,
    identityRuntime: options?.identityRuntime,
    writeCycleId: cycle.writeCycleId,
    participantTaskIds,
    expectedTaskVersion: taskPushLeaseToken ? task.updatedAt : undefined,
    taskPushLeaseToken: taskPushLeaseToken ?? undefined,
  });
  cycle.observed++;
  let dispatched = false;
  try {
    const preflight = connector as IConnector & {
      preflightWriteRoute?: (route: GitHubWriteAuthorization) => Promise<{
        targets: Record<string, { repositoryStableId: string; issueStableId?: string }>;
      }>;
      runAuthorizedWrite?: <T>(
        route: GitHubWriteAuthorization,
        write: () => Promise<T>,
      ) => Promise<T>;
    };
    if (!preflight.preflightWriteRoute) {
      throw new GitHubWriteFenceError('missing_remote_preflight');
    }
    if (!preflight.runAuthorizedWrite) {
      throw new GitHubWriteFenceError('missing_authorized_write_wrapper');
    }
    await assertGitHubWriteCycleCurrent(authorization);
    const observed = await preflight.preflightWriteRoute(authorization);
    await verifyGitHubWritePreflight(authorization, observed);
    await confirmGitHubWriteDispatch(authorization);
    dispatched = true;
    const result = await preflight.runAuthorizedWrite(authorization, dispatch);
    await finalizeGitHubWrite(authorization, 'succeeded', undefined, result);
    cycle.applied++;
    return result;
  } catch (error) {
    if (dispatched) {
      await quarantineUnknownGitHubWrite(authorization, error);
    }
    if (error instanceof GitHubWriteFenceError) {
      await finalizeUndispatchedFence(authorization, error.code);
      throw error;
    }
    await finalizeGitHubWrite(authorization, 'failed', 'definitive_remote_failure');
    throw error;
  }
}

async function persistCreatedGitHubIdentity(
  connectorInstanceId: string,
  taskId: string,
  created: TaskItem,
  runtime?: GitHubStableIdentityRuntime,
): Promise<void> {
  if (!runtime) return;
  try {
    if (!created.externalIdentity) {
      throw new GitHubWriteFenceError('created_identity_evidence_missing');
    }
    await runtime.assertCurrentMode();
    const [result] = await persistGitHubPrimaryIdentityBatch([{
      target: {
        connectorInstanceId,
        bindingType: 'task',
        localId: taskId,
        legacyIdentity: created.sourceId,
      },
      evidence: created.externalIdentity,
    }], runtime.modeSnapshot);
    if (result?.state !== 'bound') {
      throw new GitHubWriteFenceError(
        result?.collisionCategory ?? 'created_identity_binding_failed',
      );
    }
  } catch (error) {
    runtime.markBlocked('created_identity_persistence_failed');
    throw error;
  }
}

async function finalizeUndispatchedFence(
  authorization: GitHubWriteAuthorization,
  code: string,
): Promise<void> {
  await blockGitHubWrite(authorization.leaseId, authorization.token, code);
}
