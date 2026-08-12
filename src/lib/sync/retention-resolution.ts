import db from '@/db';
import { syncLog, tasks } from '@/db/schema';
import { connectorRegistry } from '@/lib/connectors';
import { getConnectorCapabilities } from '@/lib/connectors/capabilities';
import { deleteTaskTreeLocally, convertTaskTreeToLocal, getTaskByRetentionIdentity } from '@/lib/tasks/local-task-lifecycle';
import { and, eq } from 'drizzle-orm';
import { syncScheduler, type SyncAuditEntry } from './index';
import { pushPendingChanges } from './push-manager';
import {
  classifyRetainedReason,
  type RetentionResolution,
  type RetentionResolutionRecord,
} from './retention';
import { randomUUID } from 'node:crypto';

const RESOLUTION_LEASE_MS = 5 * 60 * 1000;
const RESOLUTION_LEASE_RENEWAL_MS = Math.floor(RESOLUTION_LEASE_MS / 3);

class IndeterminateRetryError extends Error {}

export interface RetentionResolutionRequestItem {
  syncLogId: string;
  detailIndex: number;
  resolution: RetentionResolution;
  confirmed: boolean;
}

export interface RetentionResolutionResult {
  syncLogId: string;
  detailIndex: number;
  resolution: RetentionResolution;
  success: boolean;
  message: string;
  taskId?: string;
  syncStatus?: string;
  idempotent?: boolean;
  resolutionStatus?: import('./retention').RetentionResolutionStatus;
}

function parseDetails(details: unknown): SyncAuditEntry[] {
  if (Array.isArray(details)) return details as SyncAuditEntry[];
  if (typeof details !== 'string') return [];
  try {
    const parsed = JSON.parse(details);
    return Array.isArray(parsed) ? parsed as SyncAuditEntry[] : [];
  } catch {
    return [];
  }
}

function getSuccessfulResolutionSyncStatus(resolution: RetentionResolution): string {
  return resolution === 'delete_local' || resolution === 'discard_local_changes'
    ? 'deleted'
    : 'synced';
}

type DetailUpdateResult =
  | { status: 'updated'; detail: SyncAuditEntry }
  | { status: 'unchanged'; detail?: SyncAuditEntry }
  | { status: 'not_found' };

async function updateResolutionAtomically(
  syncLogId: string,
  detailIndex: number,
  mutate: (detail: SyncAuditEntry) => RetentionResolutionRecord | undefined,
): Promise<DetailUpdateResult> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await db.select({ details: syncLog.details })
      .from(syncLog)
      .where(eq(syncLog.id, syncLogId));
    if (!row) return { status: 'not_found' };

    const details = parseDetails(row.details);
    const detail = details[detailIndex];
    if (!detail || detail.action !== 'protected') return { status: 'not_found' };

    const resolution = mutate(detail);
    if (!resolution) return { status: 'unchanged', detail };

    const updatedDetail = { ...detail, resolution };
    details[detailIndex] = updatedDetail;
    const updated = await db.update(syncLog)
      .set({ details: details as unknown as string })
      .where(and(
        eq(syncLog.id, syncLogId),
        eq(syncLog.details, row.details),
      ))
      .returning({ id: syncLog.id });
    if (updated.length > 0) return { status: 'updated', detail: updatedDetail };
  }

  throw new Error('Sync history changed while applying the resolution; retry the request');
}

async function performResolution(
  detail: SyncAuditEntry,
  connectorId: string,
  retainedAt: string | undefined,
  resolution: RetentionResolution,
  confirmed: boolean,
  recoveringStaleClaim = false,
): Promise<Omit<RetentionResolutionResult, 'syncLogId' | 'detailIndex' | 'resolution'>> {
  const classification = classifyRetainedReason(detail.reason);
  if (!classification.actions.includes(resolution)) {
    throw new Error(`${classification.label} does not support this resolution`);
  }
  if (resolution !== 'retry_push' && !confirmed) {
    throw new Error('Explicit confirmation is required for this resolution');
  }

  let task = await getTaskByRetentionIdentity({
    connectorId,
    taskId: detail.taskId,
    taskSourceId: detail.taskSourceId,
  });
  if (!task && recoveringStaleClaim && detail.taskId) {
    const [taskById] = await db.select().from(tasks).where(eq(tasks.id, detail.taskId));
    if (
      taskById
      && (resolution === 'keep_local' || resolution === 'archive_local')
      && taskById.connectorInstanceId === 'local'
    ) {
      return {
        success: true,
        message: resolution === 'archive_local'
          ? 'The task and its subtasks were archived as local Mission Control history.'
          : 'The task and its subtasks are now local-only.',
        taskId: taskById.id,
        syncStatus: 'synced',
      };
    }
    if (taskById?.connectorInstanceId === connectorId) {
      task = taskById;
    }
  }
  if (!task) {
    if (
      recoveringStaleClaim
      && (resolution === 'delete_local' || resolution === 'discard_local_changes')
    ) {
      return {
        success: true,
        message: resolution === 'discard_local_changes'
          ? 'The local task and its unpushed changes were deleted because no upstream copy exists.'
          : 'The local task copy and its subtasks were deleted.',
        taskId: detail.taskId,
        syncStatus: 'deleted',
      };
    }
    throw new Error('The retained task no longer exists');
  }

  if (resolution === 'retry_push' && recoveringStaleClaim && task.syncStatus === 'synced') {
    return {
      success: true,
      message: 'The task was pushed upstream successfully.',
      taskId: task.id,
      syncStatus: task.syncStatus,
    };
  }

  const taskChangedAt = [task.updatedAt, task.lastSyncedAt]
    .filter((value): value is string => typeof value === 'string')
    .reduce((latest, value) => Math.max(latest, Date.parse(value) || 0), 0);
  if (retainedAt && taskChangedAt > Date.parse(retainedAt)) {
    throw new Error('The task changed after this sync-history entry was recorded; refresh sync history before resolving it');
  }

  if (resolution === 'retry_push') {
    const isLocallyCreated = task.sourceId.startsWith('local:')
      || (task.isChecklistItem && task.sourceId === task.id);
    if (recoveringStaleClaim && isLocallyCreated && task.syncStatus !== 'synced') {
      throw new IndeterminateRetryError(
        'The previous create attempt was interrupted, so its upstream outcome is unknown. Retry is blocked to avoid creating a duplicate; keep the item local or reconcile it upstream first.',
      );
    }

    const connector = connectorRegistry.getConnector(connectorId)
      ?? await syncScheduler.initializeConnectorFromDb(connectorId);
    if (!connector) throw new Error('Connector is unavailable');

    if (isLocallyCreated && task.isChecklistItem) {
      if (!task.parentId) {
        throw new Error('The locally-created subtask no longer has an upstream parent');
      }
      const [parentTask] = await db.select({ sourceId: tasks.sourceId })
        .from(tasks)
        .where(eq(tasks.id, task.parentId));
      if (
        !parentTask
        || parentTask.sourceId.startsWith('local:')
        || parentTask.sourceId === task.parentId
      ) {
        throw new Error('The parent task must be created upstream before retrying this subtask');
      }
    }

    const capabilities = await getConnectorCapabilities(connectorId);
    const createCapabilitySupported = !capabilities || (
      capabilities.notificationOnly !== true
      && (capabilities.taskCreate ?? capabilities.write) !== false
    );
    const createOperationSupported = task.sourceId.startsWith('local:')
      ? Boolean(connector.createTask)
      : isLocallyCreated
        ? Boolean(connector.createSubTask)
        : false;
    if (isLocallyCreated && !createOperationSupported) {
      throw new Error('This connector does not support creating this task upstream');
    }
    if (isLocallyCreated && !createCapabilitySupported) {
      throw new Error('Task creation is disabled for this connector');
    }
    const usesDelete = !isLocallyCreated
      && task.status === 'cancelled'
      && Boolean(connector.deleteTask);
    if (usesDelete && capabilities?.delete === false) {
      throw new Error('Delete is disabled for this connector');
    }
    if (!isLocallyCreated && !usesDelete && capabilities?.write === false) {
      throw new Error('Write is disabled for this connector');
    }

    await db.update(tasks).set({
      syncStatus: 'pending_push',
      pushRetryCount: 0,
    }).where(eq(tasks.id, task.id));

    const retryAudit: SyncAuditEntry[] = [];
    const result = await pushPendingChanges(
      connectorId,
      connector,
      retryAudit,
      [task.id],
      { deleteGhostsOnNotFound: false },
    );
    const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    if (!updatedTask) throw new Error('The retained task was removed unexpectedly');
    if (updatedTask.syncStatus !== 'synced') {
      if (isLocallyCreated && createOperationSupported) {
        throw new IndeterminateRetryError(
          'The upstream create attempt did not return a safely persisted identity. Retry is blocked to avoid creating a duplicate; keep the item local or reconcile it upstream first.',
        );
      }
      throw new Error(result.errors[0] || 'The connector could not complete the push');
    }
    return {
      success: true,
      message: 'The task was pushed upstream successfully.',
      taskId: task.id,
      syncStatus: updatedTask.syncStatus,
    };
  }

  if (resolution === 'keep_local' || resolution === 'archive_local') {
    convertTaskTreeToLocal(task.id, resolution);
    return {
      success: true,
      message: resolution === 'archive_local'
        ? 'The task and its subtasks were archived as local Mission Control history.'
        : 'The task and its subtasks are now local-only.',
      taskId: task.id,
      syncStatus: 'synced',
    };
  }

  deleteTaskTreeLocally(task.id);
  return {
    success: true,
    message: resolution === 'discard_local_changes'
      ? 'The local task and its unpushed changes were deleted because no upstream copy exists.'
      : 'The local task copy and its subtasks were deleted.',
    taskId: task.id,
    syncStatus: 'deleted',
  };
}

export async function resolveRetainedItems(
  items: RetentionResolutionRequestItem[],
): Promise<RetentionResolutionResult[]> {
  const results: RetentionResolutionResult[] = [];

  for (const item of items) {
    const [row] = await db.select({
      connectorId: syncLog.connectorId,
      details: syncLog.details,
      syncedAt: syncLog.syncedAt,
    }).from(syncLog).where(eq(syncLog.id, item.syncLogId));
    const details = parseDetails(row?.details);
    const detail = details[item.detailIndex];

    if (!row || !detail || detail.action !== 'protected') {
      results.push({
        ...item,
        success: false,
        message: 'Retained sync detail not found',
        resolutionStatus: 'failed',
      });
      continue;
    }

    if (detail.resolution?.status === 'succeeded') {
      if (detail.resolution.action === item.resolution) {
        results.push({
          ...item,
          success: true,
          message: detail.resolution.message,
          taskId: detail.taskId,
          syncStatus: getSuccessfulResolutionSyncStatus(detail.resolution.action),
          idempotent: true,
          resolutionStatus: 'succeeded',
        });
      } else {
        results.push({
          ...item,
          resolution: detail.resolution.action,
          success: false,
          message: `This item was already resolved with ${detail.resolution.action}`,
          taskId: detail.taskId,
          syncStatus: getSuccessfulResolutionSyncStatus(detail.resolution.action),
          resolutionStatus: 'succeeded',
        });
      }
      continue;
    }

    const claimId = randomUUID();
    let recoveringStaleClaim = false;
    const claim = await updateResolutionAtomically(
      item.syncLogId,
      item.detailIndex,
      (currentDetail) => {
        if (currentDetail.resolution?.status === 'succeeded') return undefined;
        if (
          currentDetail.resolution?.status === 'indeterminate'
          && item.resolution === 'retry_push'
        ) {
          return undefined;
        }
        if (currentDetail.resolution?.status === 'in_progress') {
          const leaseExpiresAt = currentDetail.resolution.leaseExpiresAt
            ?? new Date(
              new Date(currentDetail.resolution.resolvedAt).getTime() + RESOLUTION_LEASE_MS,
            ).toISOString();
          if (Date.parse(leaseExpiresAt) > Date.now()) return undefined;
          recoveringStaleClaim = true;
        }
        const now = new Date();
        return {
          action: item.resolution,
          status: 'in_progress',
          resolvedAt: now.toISOString(),
          message: 'Resolution is in progress.',
          claimId,
          leaseExpiresAt: new Date(now.getTime() + RESOLUTION_LEASE_MS).toISOString(),
        };
      },
    );
    if (claim.status !== 'updated') {
      const currentResolution = claim.status === 'unchanged'
        ? claim.detail?.resolution
        : undefined;
      results.push({
        ...item,
        resolution: currentResolution?.action ?? item.resolution,
        success: currentResolution?.status === 'succeeded'
          && currentResolution.action === item.resolution,
        message: currentResolution?.status === 'succeeded'
          ? currentResolution.action === item.resolution
            ? currentResolution.message
            : `This item was already resolved with ${currentResolution.action}`
          : currentResolution?.status === 'in_progress'
            ? 'This item is already being resolved'
            : currentResolution?.message || 'Retained sync detail not found',
        taskId: detail.taskId,
        syncStatus: currentResolution?.status === 'succeeded'
          ? getSuccessfulResolutionSyncStatus(currentResolution.action)
          : undefined,
        idempotent: currentResolution?.status === 'succeeded'
          && currentResolution.action === item.resolution,
        resolutionStatus: currentResolution?.status,
      });
      continue;
    }

    let renewalError: Error | undefined;
    let renewalInProgress = false;
    const leaseRenewal = setInterval(() => {
      if (renewalInProgress) return;
      renewalInProgress = true;
      void updateResolutionAtomically(
        item.syncLogId,
        item.detailIndex,
        (currentDetail) => currentDetail.resolution?.status === 'in_progress'
          && currentDetail.resolution.claimId === claimId
          ? {
              ...currentDetail.resolution,
              leaseExpiresAt: new Date(Date.now() + RESOLUTION_LEASE_MS).toISOString(),
            }
          : undefined,
      ).then((renewed) => {
        if (renewed.status !== 'updated') {
          renewalError = new Error('Resolution ownership changed while the operation was running');
        }
      }).catch((error) => {
        renewalError = error instanceof Error ? error : new Error(String(error));
      }).finally(() => {
        renewalInProgress = false;
      });
    }, RESOLUTION_LEASE_RENEWAL_MS);
    leaseRenewal.unref();

    try {
      const outcome = await syncScheduler.runExclusiveConnectorOperation(
        row.connectorId,
        () => performResolution(
          detail,
          row.connectorId,
          row.syncedAt,
          item.resolution,
          item.confirmed,
          recoveringStaleClaim,
        ),
      );
      if (renewalError) throw renewalError;
      const resolutionRecord: RetentionResolutionRecord = {
        action: item.resolution,
        status: 'succeeded',
        resolvedAt: new Date().toISOString(),
        message: outcome.message,
      };
      const finalized = await updateResolutionAtomically(
        item.syncLogId,
        item.detailIndex,
        (currentDetail) => currentDetail.resolution?.status === 'in_progress'
          && currentDetail.resolution.claimId === claimId
          ? resolutionRecord
          : undefined,
      );
      if (finalized.status !== 'updated') {
        throw new Error('Resolution ownership changed before the result could be recorded');
      }
      results.push({ ...item, ...outcome, resolutionStatus: 'succeeded' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const resolutionStatus = error instanceof IndeterminateRetryError ? 'indeterminate' : 'failed';
      await updateResolutionAtomically(
        item.syncLogId,
        item.detailIndex,
        (currentDetail) => currentDetail.resolution?.status === 'in_progress'
          && currentDetail.resolution.claimId === claimId
          ? {
              action: item.resolution,
              status: resolutionStatus,
              resolvedAt: new Date().toISOString(),
              message,
            }
          : undefined,
      );
      results.push({
        ...item,
        success: false,
        message,
        taskId: detail.taskId,
        resolutionStatus,
      });
    } finally {
      clearInterval(leaseRenewal);
    }
  }

  return results;
}
