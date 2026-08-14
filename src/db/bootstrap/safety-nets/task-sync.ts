import type Database from 'better-sqlite3';

export function applyTaskSyncTableSafetyNets(_sqlite: Database.Database): void {
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_field_states (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      source_value TEXT NOT NULL,
      locally_overridden INTEGER NOT NULL DEFAULT 0,
      source_observed_at TEXT,
      local_edited_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, field_name)
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_task_field_states_task_id ON task_field_states(task_id)');
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_ingest_suppressions (
      connector_instance_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason = 'hard-deleted'),
      created_at TEXT NOT NULL,
      PRIMARY KEY (connector_instance_id, source_id)
    )
  `);
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_task_ingest_suppressions_source ON task_ingest_suppressions(source_id)',
  );
}

export function applyTaskLinkedSourceIdentitySafetyNet(_sqlite: Database.Database): void {
  _sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_linked_sources_source_identity
    ON task_linked_sources(connector_instance_id, source_id)
  `);
}
