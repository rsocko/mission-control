import db from '@/db';
import { tasks, syncLog } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Conflict Resolution Engine
 * 
 * Strategy: Last-write-wins (LWW) with conflict log.
 * 
 * When a sync detects that both local and remote have changed since last sync:
 * 1. Compare updatedAt timestamps
 * 2. Apply the newer version
 * 3. Log the conflict for user review
 * 4. Optionally preserve the "losing" version as a note
 * 
 * Future: could offer manual merge UI or field-level merge.
 */

export interface ConflictRecord {
  id: string;
  taskId: string;
  connectorType: string;
  localVersion: TaskVersion;
  remoteVersion: TaskVersion;
  resolution: 'local_wins' | 'remote_wins' | 'manual' | 'merged';
  resolvedAt: string;
  resolvedBy: 'auto' | 'user';
}

export interface TaskVersion {
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  dueDate?: string | null;
  updatedAt: string;
}

export interface ConflictDetectionResult {
  hasConflict: boolean;
  localVersion?: TaskVersion;
  remoteVersion?: TaskVersion;
}

/**
 * Detect if there's a conflict between local and remote versions of a task.
 * A conflict exists when both have been modified since the last sync.
 */
export function detectConflict(
  localTask: TaskVersion & { lastSyncedAt?: string | null },
  remoteTask: TaskVersion
): ConflictDetectionResult {
  const lastSync = localTask.lastSyncedAt;

  // No previous sync — no conflict possible (just use remote)
  if (!lastSync) {
    return { hasConflict: false };
  }

  const localModifiedAfterSync = localTask.updatedAt > lastSync;
  const remoteModifiedAfterSync = remoteTask.updatedAt > lastSync;

  // Both modified = conflict
  if (localModifiedAfterSync && remoteModifiedAfterSync) {
    return {
      hasConflict: true,
      localVersion: {
        title: localTask.title,
        description: localTask.description,
        status: localTask.status,
        priority: localTask.priority,
        dueDate: localTask.dueDate,
        updatedAt: localTask.updatedAt,
      },
      remoteVersion: remoteTask,
    };
  }

  return { hasConflict: false };
}

/**
 * Resolve a conflict using Last-Write-Wins strategy.
 * Returns which version should be applied.
 */
export function resolveConflictLWW(
  local: TaskVersion,
  remote: TaskVersion
): { winner: 'local' | 'remote'; version: TaskVersion } {
  if (local.updatedAt >= remote.updatedAt) {
    return { winner: 'local', version: local };
  }
  return { winner: 'remote', version: remote };
}

/**
 * Field-level merge: for each field, take the most recently updated value.
 * This is more granular than LWW — if user changed title locally but
 * priority changed remotely, both changes are preserved.
 */
export function mergeFields(
  base: TaskVersion | null,
  local: TaskVersion,
  remote: TaskVersion
): TaskVersion {
  // If no base (first sync), use LWW
  if (!base) {
    return resolveConflictLWW(local, remote).version;
  }

  // Three-way merge: for each field, if only one side changed it, take that change.
  // If both changed the same field, take the more recent one.
  return {
    title: pickField(base.title, local.title, remote.title, local.updatedAt, remote.updatedAt),
    description: pickField(base.description, local.description, remote.description, local.updatedAt, remote.updatedAt),
    status: pickField(base.status, local.status, remote.status, local.updatedAt, remote.updatedAt),
    priority: pickField(base.priority, local.priority, remote.priority, local.updatedAt, remote.updatedAt),
    dueDate: pickField(base.dueDate, local.dueDate, remote.dueDate, local.updatedAt, remote.updatedAt),
    updatedAt: local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
  };
}

function pickField<T>(base: T, local: T, remote: T, localTime: string, remoteTime: string): T {
  const localChanged = local !== base;
  const remoteChanged = remote !== base;

  if (localChanged && !remoteChanged) return local;
  if (remoteChanged && !localChanged) return remote;
  if (localChanged && remoteChanged) {
    // Both changed — take the more recent
    return localTime >= remoteTime ? local : remote;
  }
  return base; // Neither changed
}

/**
 * Apply a resolved conflict to the database.
 * Updates the task and logs the conflict for audit.
 */
export async function applyResolution(
  taskId: string,
  resolution: ConflictRecord
): Promise<void> {
  const winningVersion = resolution.resolution === 'local_wins'
    ? resolution.localVersion
    : resolution.remoteVersion;

  await db.update(tasks).set({
    title: winningVersion.title,
    description: winningVersion.description,
    status: winningVersion.status,
    priority: winningVersion.priority,
    dueDate: winningVersion.dueDate,
    updatedAt: new Date().toISOString(),
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
  }).where(eq(tasks.id, taskId));

  // Log the conflict
  await db.insert(syncLog).values({
    id: crypto.randomUUID(),
    connectorId: resolution.connectorType,
    success: true,
    tasksAdded: 0,
    tasksUpdated: 1,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: JSON.stringify([{
      type: 'conflict_resolved',
      taskId,
      resolution: resolution.resolution,
      localUpdatedAt: resolution.localVersion.updatedAt,
      remoteUpdatedAt: resolution.remoteVersion.updatedAt,
    }]),
    syncedAt: resolution.resolvedAt,
  });
}

/**
 * Get all unresolved conflicts (tasks with syncStatus = 'conflict')
 */
export async function getUnresolvedConflicts() {
  return db.select().from(tasks).where(eq(tasks.syncStatus, 'conflict'));
}
