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
