import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { RetentionTaskRow } from '@/lib/tasks/core/contracts';

/**
 * Local task lifecycle operations, backend-neutral as of L04.
 *
 * The whole cascade (junction rows, My Day membership, focus items,
 * dependencies, and the task row itself) is a single adapter-owned
 * transaction, so a failure can never leave a task deleted with its
 * references dangling or vice versa. These functions are asynchronous
 * because PostgreSQL transactions genuinely are; SQLite still executes them
 * synchronously inside `runTransaction`.
 */

export async function deleteTaskLocally(taskId: string): Promise<void> {
  const persistence = await getTaskCorePersistence();
  await persistence.lifecycle.deleteTaskLocally({ taskId, recursive: false });
}

export async function deleteTaskTreeLocally(taskId: string): Promise<void> {
  const persistence = await getTaskCorePersistence();
  await persistence.lifecycle.deleteTaskLocally({ taskId, recursive: true });
}

export async function convertTaskTreeToLocal(
  taskId: string,
  resolution: 'keep_local' | 'archive_local',
): Promise<void> {
  const persistence = await getTaskCorePersistence();
  await persistence.lifecycle.convertTaskTreeToLocal(
    taskId,
    resolution,
    new Date().toISOString(),
  );
}

export async function getTaskByRetentionIdentity(input: {
  connectorId: string;
  taskId?: string;
  taskSourceId: string;
}): Promise<RetentionTaskRow | null> {
  const persistence = await getTaskCorePersistence();
  return persistence.lifecycle.findTaskByRetentionIdentity(input);
}
