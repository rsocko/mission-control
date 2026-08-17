import type Database from 'better-sqlite3';

export function applyTaskActivitySafetyNets(_sqlite: Database.Database): void {
  // Quick Sort Log (activity stats & streak tracking)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_triage_log (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      operation_id TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      triaged_at TEXT NOT NULL,
      reversed_at TEXT
    )
  `);
  const triageColumns = new Set(
    _sqlite.prepare('PRAGMA table_info(task_triage_log)').all()
      .map((column) => (column as { name: string }).name),
  );
  if (!triageColumns.has('operation_id')) {
    _sqlite.exec('ALTER TABLE task_triage_log ADD COLUMN operation_id TEXT');
  }
  if (!triageColumns.has('reversed_at')) {
    _sqlite.exec('ALTER TABLE task_triage_log ADD COLUMN reversed_at TEXT');
  }
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_task_triage_log_triaged_at ON task_triage_log(triaged_at DESC)');
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS quick_sort_operations (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      label TEXT NOT NULL,
      context_key TEXT NOT NULL,
      queue_index INTEGER NOT NULL,
      before_snapshot TEXT NOT NULL,
      after_snapshot TEXT NOT NULL,
      state TEXT NOT NULL,
      ai_accepted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      undone_at TEXT
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_quick_sort_operations_task_created ON quick_sort_operations(task_id, created_at)');

  // Task Attachments (safety-net for Drizzle migration 0023)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_base64 TEXT,
      source_attachment_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id ON task_attachments(task_id)');
}
