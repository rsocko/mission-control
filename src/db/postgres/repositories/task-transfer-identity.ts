import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import * as schema from '../schema';
import { sourceLists, tasks } from '../schema';
import type { PostgresDatabase, PostgresTransaction } from '../runtime';
import type { TaskTransferIdentityRepository } from '@/lib/tasks/core/contracts';

type ResolveInput = Parameters<TaskTransferIdentityRepository['resolveIdentityTargets']>[0];
type ResolveResult = Awaited<
  ReturnType<TaskTransferIdentityRepository['resolveIdentityTargets']>
>;
type ReconcileInput = Parameters<TaskTransferIdentityRepository['reconcileTaskRefresh']>[0];
type TransactionDatabase = PostgresDatabase | PostgresTransaction;
const transactionScope = Symbol('PostgresTaskTransferIdentityTransaction');

export interface PostgresTaskTransferIdentityTransaction {
  readonly database: TransactionDatabase;
  readonly [transactionScope]: true;
}

function createTransactionScope(
  database: TransactionDatabase,
): PostgresTaskTransferIdentityTransaction {
  return Object.freeze({
    database,
    [transactionScope]: true as const,
  });
}

export function bindPostgresTaskTransferIdentityDrizzleTransaction(
  transaction: PostgresTransaction,
): PostgresTaskTransferIdentityTransaction {
  return createTransactionScope(transaction);
}

export async function bindPostgresTaskTransferIdentityClientTransaction(
  client: PoolClient,
): Promise<PostgresTaskTransferIdentityTransaction> {
  await client.query('SAVEPOINT task_transfer_identity_scope');
  await client.query('RELEASE SAVEPOINT task_transfer_identity_scope');
  return createTransactionScope(drizzle(client, { schema }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value } as Record<string, unknown>
    : {};
}

async function resolvePostgresTaskTransferIdentityTargetsInternal(
  database: TransactionDatabase,
  input: ResolveInput,
  lockRows: boolean,
): Promise<ResolveResult> {
  const orderedUniqueSourceIds = [...new Set(input.sourceListIds.filter(Boolean))];
  const localIdBySourceId = new Map<string, string>();
  if (orderedUniqueSourceIds.length > 0) {
    const sourceQuery = database.select({
      sourceId: sourceLists.sourceId,
      localId: sourceLists.id,
    }).from(sourceLists).where(and(
      eq(sourceLists.connectorInstanceId, input.connectorInstanceId),
      inArray(sourceLists.sourceId, orderedUniqueSourceIds),
    )).orderBy(asc(sourceLists.id));
    const rows = lockRows ? await sourceQuery.for('share') : await sourceQuery;
    for (const row of rows) localIdBySourceId.set(row.sourceId, row.localId);
  }
  const resolvedSourceLists = orderedUniqueSourceIds
    .filter((sourceId) => localIdBySourceId.has(sourceId))
    .map((sourceId) => ({ sourceId, localId: localIdBySourceId.get(sourceId)! }));

  const taskQuery = database.select({ metadata: tasks.metadata })
    .from(tasks)
    .where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.connectorInstanceId, input.connectorInstanceId),
    ))
    .limit(1);
  const [taskRow] = lockRows ? await taskQuery.for('update') : await taskQuery;
  return {
    taskExists: Boolean(taskRow),
    taskMetadata: taskRow ? asRecord(taskRow.metadata) : {},
    sourceLists: resolvedSourceLists,
  };
}

export function resolvePostgresTaskTransferIdentityTargets(
  database: PostgresDatabase,
  input: ResolveInput,
): Promise<ResolveResult> {
  return resolvePostgresTaskTransferIdentityTargetsInternal(database, input, false);
}

/**
 * Only call with a handle already bound to the adapter's owning transaction.
 * Source-list and task rows are locked in deterministic order before writes.
 */
export function resolvePostgresTaskTransferIdentityTargetsInTransaction(
  transaction: PostgresTaskTransferIdentityTransaction,
  input: ResolveInput,
): Promise<ResolveResult> {
  return resolvePostgresTaskTransferIdentityTargetsInternal(
    transaction.database,
    input,
    true,
  );
}

/** Only call with a handle already bound to the adapter's owning transaction. */
export async function reconcilePostgresTaskTransferIdentityRefreshInTransaction(
  transaction: PostgresTaskTransferIdentityTransaction,
  input: ReconcileInput,
): Promise<boolean> {
  const [current] = await transaction.database.select({ metadata: tasks.metadata })
    .from(tasks)
    .where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.connectorInstanceId, input.connectorInstanceId),
    ))
    .limit(1)
    .for('update');
  if (!current) return false;
  const metadata = {
    ...asRecord(current.metadata),
    ...input.task.metadata,
  };
  const updated = await transaction.database.update(tasks).set({
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
    metadata,
    syncStatus: 'synced',
    lastSyncedAt: input.observedAt,
  }).where(and(
    eq(tasks.id, input.taskId),
    eq(tasks.connectorInstanceId, input.connectorInstanceId),
  )).returning({ id: tasks.id });
  return updated.length === 1;
}
