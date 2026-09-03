import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { sourceLists, tasks } from '@/db/schema';
import type { TaskTransferIdentityRepository } from '@/lib/tasks/core/contracts';
import { decodeLenientJsonObject } from './value-codecs';

type SqliteDatabase = BetterSQLite3Database<typeof schema>;
type SqliteTransaction = Parameters<Parameters<SqliteDatabase['transaction']>[0]>[0];
type ResolveInput = Parameters<TaskTransferIdentityRepository['resolveIdentityTargets']>[0];
type ResolveResult = Awaited<
  ReturnType<TaskTransferIdentityRepository['resolveIdentityTargets']>
>;
type ReconcileInput = Parameters<TaskTransferIdentityRepository['reconcileTaskRefresh']>[0];

function resolveSqliteTaskTransferIdentityTargets(
  database: SqliteDatabase | SqliteTransaction,
  input: ResolveInput,
): ResolveResult {
  const orderedUniqueSourceIds = [...new Set(input.sourceListIds.filter(Boolean))];
  const localIdBySourceId = new Map<string, string>();
  if (orderedUniqueSourceIds.length > 0) {
    const rows = database.select({
      sourceId: sourceLists.sourceId,
      localId: sourceLists.id,
    }).from(sourceLists).where(and(
      eq(sourceLists.connectorInstanceId, input.connectorInstanceId),
      inArray(sourceLists.sourceId, orderedUniqueSourceIds),
    )).all();
    for (const row of rows) localIdBySourceId.set(row.sourceId, row.localId);
  }
  const resolvedSourceLists = orderedUniqueSourceIds
    .filter((sourceId) => localIdBySourceId.has(sourceId))
    .map((sourceId) => ({ sourceId, localId: localIdBySourceId.get(sourceId)! }));

  const taskRow = database.select({ metadata: tasks.metadata })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
    .get();
  return {
    taskExists: Boolean(taskRow),
    taskMetadata: taskRow ? decodeLenientJsonObject(taskRow.metadata) : {},
    sourceLists: resolvedSourceLists,
  };
}

export function resolveSqliteTaskTransferIdentityTargetsForRepository(
  database: SqliteDatabase,
  input: ResolveInput,
): ResolveResult {
  return resolveSqliteTaskTransferIdentityTargets(database, input);
}

/** Only call with the database handle supplied by the owning SQLite transaction. */
export function resolveSqliteTaskTransferIdentityTargetsInTransaction(
  transaction: SqliteTransaction,
  input: ResolveInput,
): ResolveResult {
  return resolveSqliteTaskTransferIdentityTargets(transaction, input);
}

/** Only call with the database handle supplied by the owning SQLite transaction. */
export function reconcileSqliteTaskTransferIdentityRefreshInTransaction(
  transaction: SqliteTransaction,
  input: ReconcileInput,
): boolean {
  const current = transaction.select({ metadata: tasks.metadata })
    .from(tasks)
    .where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.connectorInstanceId, input.connectorInstanceId),
    ))
    .limit(1)
    .get();
  if (!current) return false;
  const metadata = {
    ...decodeLenientJsonObject(current.metadata),
    ...input.task.metadata,
  };
  const result = transaction.update(tasks).set({
    sourceId: input.task.sourceId,
    sourceListId: input.task.sourceListId,
    sourceListName: input.task.sourceListName,
    title: input.task.title,
    description: input.task.description,
    status: input.task.status,
    statusReason: input.task.statusReason,
    priority: input.task.priority,
    effort: input.task.effort,
    microStatus: input.task.microStatus,
    assignee: input.task.assignee,
    updatedAt: input.task.updatedAt,
    completedAt: input.task.completedAt,
    metadata: JSON.stringify(metadata),
    syncStatus: 'synced',
    lastSyncedAt: input.observedAt,
  }).where(and(
    eq(tasks.id, input.taskId),
    eq(tasks.connectorInstanceId, input.connectorInstanceId),
  )).run();
  return result.changes === 1;
}
