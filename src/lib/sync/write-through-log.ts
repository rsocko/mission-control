import { randomUUID } from 'node:crypto';
import db from '@/db';
import { syncLog } from '@/db/schema';
import { syncLogger } from '@/lib/logger';
import type { SyncAuditEntry } from './execution-pipeline';

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
    await db.insert(syncLog).values({
      id: randomUUID(),
      connectorId: params.connectorId,
      success: true,
      tasksAdded: params.action === 'created' || params.action === 'subtask_created' ? 1 : 0,
      tasksUpdated: params.action === 'updated' ? 1 : 0,
      tasksRemoved: 0,
      tasksPushed: 1,
      localOnlyProtected: 0,
      notificationsAdded: 0,
      errors: [] as unknown as string,
      details: details as unknown as string,
      syncedAt: now,
      durationMs: 0,
    });
  } catch (err) {
    syncLogger.error({ err, ...params }, 'Failed to log write-through to sync_log');
  }
}
