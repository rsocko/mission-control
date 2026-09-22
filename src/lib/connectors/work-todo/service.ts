import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  indexTasksForSearchBatch,
  removeTaskFromSearch,
} from '@/lib/sync/search-indexer';
import { connectorLogger } from '@/lib/logger';
import { getTimezone } from '@/lib/mode';
import { WorkTodoBridgeError } from '@/db/persistence/work-todo';
import type { WorkTodoBridgePersistence } from '@/db/persistence/work-todo';
import { normalizeWorkTodoReminderAt } from '@/db/persistence/work-todo-values';
import type { WorkTodoAck, WorkTodoIngest } from './contracts';

/**
 * Application service for the Microsoft To Do - Work ("Work To Do") Power
 * Automate bridge.
 *
 * Every durable command now runs through the Layer 4
 * `connectorState.workTodo` persistence port, so the unchanged API/MCP contract
 * works on either backend. This module owns only the effects that must stay
 * outside the adapter transaction: search indexing, search removal, and
 * logging.
 */

export { WorkTodoBridgeError };
export { normalizeWorkTodoReminderAt };

async function workTodoPersistence(): Promise<WorkTodoBridgePersistence> {
  return (await getWorkerPersistenceRepositories()).connectorState.workTodo;
}

async function removeCommittedTasksFromSearch(
  connectorId: string,
  taskIds: readonly string[],
): Promise<void> {
  for (const taskId of taskIds) {
    try {
      await removeTaskFromSearch(taskId);
    } catch (error) {
      connectorLogger.error(
        { err: error, taskId, connectorId },
        'Work To Do task removed but search index cleanup failed',
      );
    }
  }
}

export async function ingestWorkTodo(payload: WorkTodoIngest) {
  const now = new Date().toISOString();
  const persistence = await workTodoPersistence();
  const result = await persistence.ingest({
    payload,
    now,
    timezone: getTimezone(),
  });

  try {
    await indexTasksForSearchBatch(result.indexedTasks.map((task) => ({ ...task })));
  } catch (error) {
    connectorLogger.error(
      { err: error, connectorId: payload.connectorInstanceId },
      'Work To Do tasks committed but search indexing failed',
    );
  }
  await removeCommittedTasksFromSearch(payload.connectorInstanceId, result.removedTaskIds);

  return {
    connectorInstanceId: payload.connectorInstanceId,
    mode: result.mode,
    created: result.created,
    updated: result.updated,
    removed: result.removed,
    protectedPending: result.protectedPending,
    acceptedAt: now,
  };
}

export async function leaseWorkTodoChanges(input: {
  connectorInstanceId: string;
  limit?: number;
  leaseSeconds?: number;
}) {
  const requestedAt = new Date().toISOString();
  const persistence = await workTodoPersistence();
  const lease = await persistence.lease({
    connectorId: input.connectorInstanceId,
    limit: input.limit,
    leaseSeconds: input.leaseSeconds,
    now: requestedAt,
  });

  return {
    schemaVersion: '1.0' as const,
    connectorInstanceId: input.connectorInstanceId,
    requestedAt,
    allowDelete: false,
    leaseId: lease.leaseId,
    leaseExpiresAt: lease.leaseExpiresAt,
    changes: lease.changes.map((change) => ({
      idempotencyKey: change.idempotencyKey,
      sourceId: change.sourceId,
      listId: change.listSourceId,
      taskId: change.remoteTaskId,
      operation: change.operation,
      ...(change.fields ? { fields: change.fields } : {}),
    })),
  };
}

export async function createWorkTodoPullRequest(connectorId: string) {
  const requestedAt = new Date().toISOString();
  const persistence = await workTodoPersistence();
  const state = await persistence.readPullState(connectorId);
  if (state.capabilityProfile === 'standard-v1') {
    return {
      schemaVersion: '1.0' as const,
      connectorInstanceId: connectorId,
      requestedAt,
    };
  }
  return {
    schemaVersion: '1.1' as const,
    connectorInstanceId: connectorId,
    requestedAt,
    ...(state.selectedListIds.length > 0
      ? { selectedListIds: [...state.selectedListIds] }
      : {}),
    listDeltaLink: state.resetRequired ? null : state.listDeltaLink,
    taskDeltaLinks: Object.fromEntries(
      state.taskDeltaLinks.map((list) => [
        list.listSourceId,
        state.resetRequired ? null : list.deltaLink,
      ]),
    ),
  };
}

export async function acknowledgeWorkTodoChanges(payload: WorkTodoAck) {
  const now = new Date().toISOString();
  const persistence = await workTodoPersistence();
  const result = await persistence.acknowledge({ payload, now });

  await removeCommittedTasksFromSearch(payload.connectorInstanceId, result.removedTaskIds);

  return {
    connectorInstanceId: payload.connectorInstanceId,
    succeeded: result.succeeded,
    failed: result.failed,
    skipped: result.skipped,
    stale: result.stale,
    acknowledgedAt: payload.processedAt,
  };
}

export async function getWorkTodoBridgeStatus(connectorId: string) {
  const persistence = await workTodoPersistence();
  const status = await persistence.readStatus(connectorId);
  return {
    connectorId,
    enabled: status.enabled,
    initialized: status.initialized,
    transport: status.transport,
    capabilityProfile: status.capabilityProfile,
    resetRequired: status.resetRequired,
    lastIngestAt: status.lastIngestAt,
    lastIngestMode: status.lastIngestMode,
    lastError: status.lastError,
    deltaCheckpointStored: status.deltaCheckpointStored,
    pendingWriteBackCount: status.pendingWriteBackCount,
  };
}

export async function resetWorkTodoDelta(connectorId: string) {
  const now = new Date().toISOString();
  const persistence = await workTodoPersistence();
  const result = await persistence.resetDelta({ connectorId, now });
  return {
    connectorId,
    resetRequired: result.resetRequired,
    updatedAt: result.updatedAt,
  };
}
