import type Database from 'better-sqlite3';
import {
  TASK_ASSOCIATION_TABLES,
} from './task-deletion';

type SqliteDatabase = Database.Database;

/**
 * SQLite half of the canonical task-deletion cleanup.
 *
 * Every helper here is statement-level and takes the raw connection, so the
 * caller owns the transaction. better-sqlite3 is a single synchronous
 * connection, so these statements join whichever transaction (`immediate`
 * write transaction or Drizzle transaction over the same handle) is already
 * open on the caller's side.
 */

/**
 * Deletes every canonical association row for one task and nulls the
 * notification back-reference. The `tasks` row itself is left to the caller,
 * which may need to detach descendants (core repository) or recurse into them
 * (connector execution, Work To Do) first.
 */
export function cleanupTaskAssociations(database: SqliteDatabase, taskId: string): void {
  for (const table of TASK_ASSOCIATION_TABLES) {
    database.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
  }
  database.prepare(
    'DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?',
  ).run(taskId, taskId);
  database.prepare(
    'UPDATE notifications SET related_task_id = NULL WHERE related_task_id = ?',
  ).run(taskId);
}

/**
 * Applies {@link cleanupTaskAssociations} and then deletes the task row.
 * Returns whether the task row existed.
 */
export function deleteTaskWithCanonicalCleanup(
  database: SqliteDatabase,
  taskId: string,
): boolean {
  cleanupTaskAssociations(database, taskId);
  return database.prepare('DELETE FROM tasks WHERE id = ?').run(taskId).changes === 1;
}

/**
 * Deletes a task and its descendant subtree depth-first, applying the canonical
 * cleanup to every node. The traversal is cycle-guarded, so a corrupt
 * `parent_id` cycle cannot recurse forever, and each removed ID is collected so
 * the caller can maintain the search index *after* its transaction commits.
 */
export function deleteTaskTreeWithCanonicalCleanup(
  database: SqliteDatabase,
  taskId: string,
  removedIds: Set<string>,
  visited: Set<string> = new Set(),
): void {
  if (visited.has(taskId)) return;
  visited.add(taskId);
  const children = database.prepare(
    'SELECT id FROM tasks WHERE parent_id = ?',
  ).all(taskId) as Array<{ id: string }>;
  for (const child of children) {
    if (child.id === taskId) continue;
    deleteTaskTreeWithCanonicalCleanup(database, child.id, removedIds, visited);
  }
  deleteTaskWithCanonicalCleanup(database, taskId);
  removedIds.add(taskId);
}
