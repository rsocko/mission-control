import type Database from 'better-sqlite3';

export function applyProjectHierarchyTableSafetyNets(_sqlite: Database.Database): void {
  // Project Phases (safety-net for Drizzle migration 0002)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_phases (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      color TEXT,
      estimated_days REAL,
      target_start TEXT,
      target_end TEXT,
      start_after_phase_id TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_phase_items (
      id TEXT PRIMARY KEY NOT NULL,
      phase_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sort_order REAL NOT NULL DEFAULT 0,
      estimated_effort_hours REAL,
      is_proposed INTEGER NOT NULL DEFAULT 0,
      proposal_type TEXT,
      created_at TEXT NOT NULL
    )
  `);
}

export function applyHubProjectColumnSafetyNets(_sqlite: Database.Database): void {
  // Migrate hub_projects table: add hidden column (safety net for Drizzle migration 0015)
  const hubProjectColumns = _sqlite.prepare("PRAGMA table_info('hub_projects')").all() as Array<{ name: string }>;
  if (hubProjectColumns.length > 0 && !hubProjectColumns.some((column) => column.name === 'hidden')) {
    _sqlite.exec('ALTER TABLE hub_projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  if (hubProjectColumns.length > 0 && !hubProjectColumns.some((column) => column.name === 'icon_color')) {
    _sqlite.exec('ALTER TABLE hub_projects ADD COLUMN icon_color TEXT');
  }
}

export function applyProjectPhaseColumnSafetyNets(_sqlite: Database.Database): void {
  // Migrate project_phases table: add columns from migration 0005
  const phaseColumns = _sqlite.prepare("PRAGMA table_info('project_phases')").all() as Array<{ name: string }>;
  if (phaseColumns.length > 0) {
    if (!phaseColumns.some((column) => column.name === 'start_after_phase_id')) {
      _sqlite.exec('ALTER TABLE project_phases ADD COLUMN start_after_phase_id TEXT');
    }
    if (!phaseColumns.some((column) => column.name === 'plan_name')) {
      _sqlite.exec('ALTER TABLE project_phases ADD COLUMN plan_name TEXT');
    }
    if (!phaseColumns.some((column) => column.name === 'plan_status')) {
      _sqlite.exec("ALTER TABLE project_phases ADD COLUMN plan_status TEXT DEFAULT 'draft'");
    }
  }
}
