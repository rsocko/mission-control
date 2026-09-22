import type { ConnectorTaskRecord } from '@/db/persistence/connector-execution';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

const PUSH_LEASE_MS = 5 * 60 * 1000;

export async function claimTaskForPush(taskId: string): Promise<string | null> {
  const now = new Date();
  const leaseToken = now.toISOString();
  const staleBefore = new Date(now.getTime() - PUSH_LEASE_MS).toISOString();
  const persistence = (await getWorkerPersistenceRepositories()).execution.pushes;
  return await persistence.claim(taskId, leaseToken, staleBefore) ? leaseToken : null;
}

export async function releaseTaskPush(
  taskId: string,
  leaseToken: string,
  syncStatus: string | null,
  expectedTaskVersion?: string,
): Promise<boolean> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.pushes;
  return persistence.release({
    taskId,
    leaseToken,
    syncStatus: syncStatus ?? 'pending_push',
    now: new Date().toISOString(),
    expectedTaskVersion,
  });
}

export async function loadClaimedTaskForPush(
  taskId: string,
  leaseToken: string,
): Promise<ConnectorTaskRecord | null> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.pushes;
  return persistence.loadClaimed(taskId, leaseToken);
}

export async function completeTaskPush(
  taskId: string,
  leaseToken: string,
  sourceId: string,
  metadata?: Record<string, unknown>,
  localUpdates?: {
    status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
    completedAt?: string | null;
  },
  expectedTaskVersion?: string,
  createdFromSourceId?: string,
): Promise<boolean> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.pushes;
  return persistence.complete({
    taskId,
    leaseToken,
    sourceId,
    metadata,
    localUpdates,
    expectedTaskVersion,
    createdFromSourceId,
    now: new Date().toISOString(),
  });
}

export async function heartbeatTaskPush(
  taskId: string,
  leaseToken: string,
): Promise<string | null> {
  const renewedToken = new Date(
    Math.max(Date.now(), new Date(leaseToken).getTime() + 1),
  ).toISOString();
  const persistence = (await getWorkerPersistenceRepositories()).execution.pushes;
  return await persistence.heartbeat(taskId, leaseToken, renewedToken)
    ? renewedToken
    : null;
}

export async function failTaskPush(
  taskId: string,
  leaseToken: string,
  syncStatus: 'push_error' | 'push_failed' = 'push_error',
  pushRetryCount?: number,
  expectedTaskVersion?: string,
): Promise<boolean> {
  const persistence = (await getWorkerPersistenceRepositories()).execution.pushes;
  return persistence.fail({
    taskId,
    leaseToken,
    syncStatus,
    pushRetryCount,
    expectedTaskVersion,
    now: new Date().toISOString(),
  });
}
