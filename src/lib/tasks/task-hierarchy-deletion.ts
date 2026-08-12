import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';

export function detachTaskDescendants(
  tx: BetterSQLite3Database<typeof schema>,
  taskId: string,
): void {
  tx.run(sql`
    WITH RECURSIVE descendants(id, depth, path) AS (
      SELECT id, 0, ',' || id || ','
      FROM tasks
      WHERE parent_id = ${taskId} AND id <> ${taskId}
      UNION ALL
      SELECT child.id, descendants.depth + 1, descendants.path || child.id || ','
      FROM tasks AS child
      INNER JOIN descendants ON child.parent_id = descendants.id
      WHERE instr(descendants.path, ',' || child.id || ',') = 0
    )
    UPDATE tasks
    SET
      parent_id = CASE WHEN parent_id = ${taskId} THEN NULL ELSE parent_id END,
      depth = (
        SELECT descendants.depth
        FROM descendants
        WHERE descendants.id = tasks.id
      )
    WHERE id IN (SELECT id FROM descendants)
  `);
}
