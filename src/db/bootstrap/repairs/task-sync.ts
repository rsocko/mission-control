import type Database from 'better-sqlite3';
import { execSafe } from '../safety-nets/exec-safe';

export function repairTaskLinkedSourceDuplicates(sqlite: Database.Database): void {
  sqlite.exec(`
    DELETE FROM task_linked_sources
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM task_linked_sources
      GROUP BY connector_instance_id, source_id
    )
  `);
}

export function backfillTaskFieldStates(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT OR IGNORE INTO task_field_states (
      task_id, field_name, source_value, locally_overridden,
      source_observed_at, local_edited_at, updated_at
    )
    SELECT
      tasks.id,
      fields.field_name,
      CASE fields.field_name
        WHEN 'title' THEN json_quote(tasks.title)
        WHEN 'description' THEN json_quote(tasks.description)
        WHEN 'priority' THEN json_quote(tasks.priority)
        WHEN 'dueDate' THEN json_quote(tasks.due_date)
      END,
      0,
      COALESCE(tasks.last_synced_at, tasks.updated_at),
      NULL,
      tasks.updated_at
    FROM tasks
    CROSS JOIN (
      SELECT 'title' AS field_name
      UNION ALL SELECT 'description'
      UNION ALL SELECT 'priority'
      UNION ALL SELECT 'dueDate'
    ) AS fields
    WHERE tasks.connector_type = 'scout'
  `);
}

export function backfillTasksLastSyncedAt(sqlite: Database.Database): void {
  execSafe(
    sqlite,
    "UPDATE tasks SET last_synced_at = updated_at WHERE last_synced_at IS NULL OR last_synced_at = ''",
  );
}
