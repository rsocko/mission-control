import type Database from 'better-sqlite3';

export function applyTaskActivitySafetyNets(_sqlite: Database.Database): void {
  // Quick Sort Log (activity stats & streak tracking)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_triage_log (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      triaged_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_task_triage_log_triaged_at ON task_triage_log(triaged_at DESC)');

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
