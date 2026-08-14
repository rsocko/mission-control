import type Database from 'better-sqlite3';

export function applyResetSafetyNets(_sqlite: Database.Database): void {
  // Resets (Weekly/Monthly)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS resets (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      went_well TEXT,
      needs_adjustment TEXT,
      notes TEXT,
      stats TEXT,
      ai_summary TEXT,
      stale_actions TEXT NOT NULL DEFAULT '[]',
      carry_forward_items TEXT NOT NULL DEFAULT '[]',
      monthly_win TEXT,
      monthly_change TEXT,
      intentions TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_resets_type_period ON resets(type, period_start)');
}
