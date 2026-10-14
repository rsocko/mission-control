import { randomUUID } from 'node:crypto';
import { syncLogger } from '@/lib/logger';
import type { SyncAuditEntry } from './execution-pipeline';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export interface WriteThroughLogParams {
  connectorId: string;
  action: 'created' | 'updated' | 'subtask_created' | 'completed';
  taskId: string;
  taskTitle: string;
  taskSourceId: string;
}

export interface WriteThroughFailureLogParams {
  connectorId: string;
  taskId: string;
  taskTitle: string;
  taskSourceId: string;
  error: unknown;
}

export async function logWriteThrough(params: WriteThroughLogParams): Promise<void> {
  try {
    const now = new Date().toISOString();
    const details: SyncAuditEntry[] = [{
      action: 'pushed',
      taskId: params.taskId,
      taskTitle: params.taskTitle,
      taskSourceId: params.taskSourceId,
      reason: `Write-through: ${params.action}`,
    }];
    const repositories = await getWorkerPersistenceRepositories();
    await repositories.syncRuns.append({
      id: randomUUID(),
      connectorId: params.connectorId,
      success: true,
      tasksAdded: params.action === 'created' || params.action === 'subtask_created' ? 1 : 0,
      tasksUpdated: params.action === 'updated' ? 1 : 0,
      tasksRemoved: 0,
      tasksPushed: 1,
      localOnlyProtected: 0,
      notificationsAdded: 0,
      errors: [],
      details,
      activity: null,
      syncedAt: now,
      durationMs: 0,
      jobId: null,
      identityMode: null,
      identityModeRevision: null,
    });
  } catch (err) {
    syncLogger.error({ err, ...params }, 'Failed to log write-through to sync_log');
  }
}

export async function logWriteThroughFailure(
  params: WriteThroughFailureLogParams,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const rawMessage = params.error instanceof Error
      ? params.error.message
      : 'Unknown connector write error';
    const message = rawMessage.replace(/\s+/g, ' ').trim().slice(0, 300)
      || 'Unknown connector write error';
    const details: SyncAuditEntry[] = [{
      action: 'push_failed',
      taskId: params.taskId,
      taskTitle: params.taskTitle,
      taskSourceId: params.taskSourceId,
      reason: `Write-through failed: ${message}`,
    }];
    const repositories = await getWorkerPersistenceRepositories();
    await repositories.syncRuns.append({
      id: randomUUID(),
      connectorId: params.connectorId,
      success: false,
      tasksAdded: 0,
      tasksUpdated: 0,
      tasksRemoved: 0,
      tasksPushed: 0,
      localOnlyProtected: 0,
      notificationsAdded: 0,
      errors: [message],
      details,
      activity: null,
      syncedAt: now,
      durationMs: 0,
      jobId: null,
      identityMode: null,
      identityModeRevision: null,
    });
  } catch (err) {
    syncLogger.error({ err, taskId: params.taskId }, 'Failed to log write-through failure');
  }
}
