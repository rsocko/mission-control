import type Database from 'better-sqlite3';

export function applyTriageTableSafetyNets(_sqlite: Database.Database): void {
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS triage_items (
      id TEXT PRIMARY KEY,
      source_platform TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      canonical_url TEXT,
      title TEXT NOT NULL,
      description TEXT,
      thumbnail_url TEXT,
      content_type TEXT NOT NULL DEFAULT 'link',
      captured_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      snoozed_until TEXT,
      ai_summary TEXT,
      ai_categories TEXT NOT NULL DEFAULT '[]',
      ai_suggested_actions TEXT NOT NULL DEFAULT '[]',
      ai_relevance_score INTEGER NOT NULL DEFAULT 0,
      ai_urgency TEXT NOT NULL DEFAULT 'evergreen',
      raw_metadata TEXT NOT NULL DEFAULT '{}',
      actions_taken TEXT NOT NULL DEFAULT '[]',
      source_order INTEGER
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_triage_items_status ON triage_items(status)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_triage_items_captured_at ON triage_items(captured_at DESC)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_triage_items_status_captured_at ON triage_items(status, captured_at DESC)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_triage_items_canonical_url ON triage_items(canonical_url)');

  // Triage Collections (safety-net for Drizzle migration 0005)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS triage_collections (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      description TEXT,
      max_age_days INTEGER NOT NULL DEFAULT 14,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS triage_sync_state (
      id TEXT PRIMARY KEY,
      last_cursor TEXT,
      last_synced_at TEXT,
      total_imported INTEGER NOT NULL DEFAULT 0,
      total_skipped INTEGER NOT NULL DEFAULT 0,
      last_run_imported INTEGER NOT NULL DEFAULT 0,
      last_run_skipped INTEGER NOT NULL DEFAULT 0,
      last_run_errors TEXT NOT NULL DEFAULT '[]',
      last_run_duration_ms INTEGER,
      revision INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Triage Content Type Registry (safety-net for Drizzle migration 0014)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS triage_content_types (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT NOT NULL DEFAULT '#6b7280',
      builtin INTEGER NOT NULL DEFAULT 0,
      suppressed INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 50,
      url_patterns TEXT NOT NULL DEFAULT '[]',
      keyword_hints TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

export function applyTriageColumnSafetyNets(_sqlite: Database.Database): void {
  // Migrate triage_items table: add collection_id and collected_at from migrations 0005/0012
  const triageColumns = _sqlite.prepare("PRAGMA table_info('triage_items')").all() as Array<{ name: string }>;
  if (triageColumns.length > 0) {
    if (!triageColumns.some((column) => column.name === 'collection_id')) {
      _sqlite.exec('ALTER TABLE triage_items ADD COLUMN collection_id TEXT');
    }
    if (!triageColumns.some((column) => column.name === 'collected_at')) {
      _sqlite.exec('ALTER TABLE triage_items ADD COLUMN collected_at TEXT');
    }
    if (!triageColumns.some((column) => column.name === 'source_order')) {
      _sqlite.exec('ALTER TABLE triage_items ADD COLUMN source_order INTEGER');
    }
  }

  // Migrate triage_collections table: add max_age_days from migration 0012
  const collectionColumns = _sqlite.prepare("PRAGMA table_info('triage_collections')").all() as Array<{ name: string }>;
  if (collectionColumns.length > 0) {
    if (!collectionColumns.some((column) => column.name === 'max_age_days')) {
      _sqlite.exec('ALTER TABLE triage_collections ADD COLUMN max_age_days INTEGER NOT NULL DEFAULT 14');
    }
  }

}
