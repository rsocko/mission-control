import type Database from 'better-sqlite3';
import { execSafe } from './exec-safe';

export function applyTagUnificationColumnSafetyNet(_sqlite: Database.Database): void {
  const _execSafe = (sql: string) => execSafe(_sqlite, sql);
  // Tags: add unified_into column for cross-source tag unification
  const tagColumns = _sqlite.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>;
  if (tagColumns.length > 0 && !tagColumns.some((column) => column.name === 'unified_into')) {
    _execSafe('ALTER TABLE tags ADD COLUMN unified_into TEXT');
  }
}

export function applyTaskSafetyNets(_sqlite: Database.Database): void {
  const _execSafe = (sql: string) => execSafe(_sqlite, sql);
  // Migrate tasks table: add micro_status column (safety net for Drizzle migration 0004)
  const taskColumns = _sqlite.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>;
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'micro_status')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN micro_status TEXT');
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'snoozed_until')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN snoozed_until TEXT');
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'effort')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN effort INTEGER');
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'status_reason')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN status_reason TEXT');
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'push_retry_count')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN push_retry_count INTEGER NOT NULL DEFAULT 0');
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'reminder_at')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN reminder_at TEXT');
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'is_bulk_import')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN is_bulk_import INTEGER NOT NULL DEFAULT 0');
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'local_disposition')) {
    _sqlite.exec(
      "ALTER TABLE tasks ADD COLUMN local_disposition TEXT NOT NULL DEFAULT 'active' CHECK (local_disposition IN ('active', 'handled', 'dismissed'))",
    );
  }
  if (taskColumns.length > 0 && !taskColumns.some((column) => column.name === 'recurrence_generated_from_task_id')) {
    _sqlite.exec('ALTER TABLE tasks ADD COLUMN recurrence_generated_from_task_id TEXT');
  }
  const scheduleColumns = _sqlite.prepare("PRAGMA table_info('task_schedules')").all() as Array<{ name: string }>;
  if (scheduleColumns.length > 0 && !scheduleColumns.some((column) => column.name === 'recurrence_mode')) {
    _sqlite.exec("ALTER TABLE task_schedules ADD COLUMN recurrence_mode TEXT NOT NULL DEFAULT 'schedule'");
  }
  _execSafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_recurrence_generated_from ON tasks(recurrence_generated_from_task_id) WHERE recurrence_generated_from_task_id IS NOT NULL',
  );
  _execSafe(
    'CREATE INDEX IF NOT EXISTS idx_tasks_local_disposition ON tasks(local_disposition)',
  );
}
