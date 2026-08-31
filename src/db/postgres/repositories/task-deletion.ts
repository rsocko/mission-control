import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { TASK_ASSOCIATION_TABLES } from '@/db/persistence/task-deletion';
import type { PostgresTransaction } from '../runtime';

type Client = Pool | PoolClient;

/**
 * PostgreSQL half of the canonical task-deletion cleanup.
 *
 * Two shapes exist because the two callers hold two different handles: the
 * connector-execution and Work To Do adapters own an explicit `pg` client
 * inside a `BEGIN`/`COMMIT`, while the core task repository runs inside a
 * Drizzle transaction. Both drive the same {@link TASK_ASSOCIATION_TABLES}
 * list, so the two paths cannot drift apart.
 */

/**
 * Deletes every canonical association row for the given tasks and nulls the
 * notification back-reference. The `tasks` rows are left to the caller.
 */
export async function cleanupTaskAssociations(
  client: Client,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  const ids = [...taskIds];
  for (const table of TASK_ASSOCIATION_TABLES) {
    await client.query(`DELETE FROM ${table} WHERE task_id = ANY($1::text[])`, [ids]);
  }
  await client.query(
    `DELETE FROM task_dependencies
     WHERE task_id = ANY($1::text[]) OR depends_on_task_id = ANY($1::text[])`,
    [ids],
  );
  await client.query(
    'UPDATE notifications SET related_task_id = NULL WHERE related_task_id = ANY($1::text[])',
    [ids],
  );
}

/** Applies {@link cleanupTaskAssociations} and then deletes the task rows. */
export async function deleteTasksWithCanonicalCleanup(
  client: Client,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  await cleanupTaskAssociations(client, taskIds);
  await client.query('DELETE FROM tasks WHERE id = ANY($1::text[])', [[...taskIds]]);
}

/**
 * Drizzle-transaction variant used by the core task repository, which cannot
 * borrow a raw client from the pool without leaving its own transaction.
 */
export async function cleanupTaskAssociationsInTransaction(
  tx: PostgresTransaction,
  taskId: string,
): Promise<void> {
  for (const table of TASK_ASSOCIATION_TABLES) {
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE task_id = ${taskId}`);
  }
  await tx.execute(sql`
    DELETE FROM task_dependencies
    WHERE task_id = ${taskId} OR depends_on_task_id = ${taskId}
  `);
  await tx.execute(sql`
    UPDATE notifications SET related_task_id = NULL WHERE related_task_id = ${taskId}
  `);
}
