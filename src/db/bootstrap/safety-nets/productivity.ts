import type Database from 'better-sqlite3';

export function applyProductivityTableSafetyNets(_sqlite: Database.Database): void {
  // Focus 3 widget
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS focus_items (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      date TEXT NOT NULL,
      slot INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      is_ai_suggested INTEGER NOT NULL DEFAULT 0
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_focus_items_scope_date ON focus_items(scope, date)');
  _sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_items_scope_date_slot ON focus_items(scope, date, slot)');

  // Weekly One Thing (ADHD "This Week, One Thing" banner)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS weekly_one_thing (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      week_monday TEXT NOT NULL,
      is_manual_override INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_one_thing_week ON weekly_one_thing(week_monday)');

  // Priority Entities (Smart Score)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS priority_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      reference_id TEXT,
      description TEXT,
      tier TEXT NOT NULL DEFAULT 'standard',
      color TEXT NOT NULL DEFAULT '#64748b',
      rank INTEGER NOT NULL DEFAULT 0,
      active_task_count INTEGER NOT NULL DEFAULT 0,
      last_touched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_priority_entities_tier ON priority_entities(tier)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_priority_entities_rank ON priority_entities(rank)');
  const priorityEntityColumns = _sqlite.prepare("PRAGMA table_info('priority_entities')").all() as Array<{ name: string }>;
  if (!priorityEntityColumns.some(column => column.name === 'reference_id')) {
    _sqlite.exec('ALTER TABLE priority_entities ADD COLUMN reference_id TEXT');
  }

  // Source Rankings (Smart Score)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS source_rankings (
      id TEXT PRIMARY KEY,
      connector_type TEXT NOT NULL,
      name TEXT NOT NULL,
      rank INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  // Smart Score Settings
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS smart_score_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Routines & Habits
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cadence_type TEXT NOT NULL,
      cadence_config TEXT NOT NULL DEFAULT '{}',
      icon TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS routine_completions (
      id TEXT PRIMARY KEY NOT NULL,
      routine_id TEXT NOT NULL,
      date TEXT NOT NULL,
      notes TEXT,
      completed_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_date ON routine_completions(routine_id, date)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_routine_completions_date ON routine_completions(date)');

  // Energy Check-Ins
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS energy_checkins (
      id TEXT PRIMARY KEY NOT NULL,
      date TEXT NOT NULL,
      level TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_energy_checkins_date ON energy_checkins(date)');

  // List Fix Audit Log (emoji migration tracking)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS list_fix_audit_log (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL,
      strategy TEXT NOT NULL,
      status TEXT NOT NULL,
      original_list_id TEXT NOT NULL,
      original_source_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      original_group_id TEXT,
      connector_instance_id TEXT NOT NULL,
      new_list_id TEXT,
      new_name TEXT NOT NULL,
      task_snapshot TEXT,
      move_results TEXT,
      tasks_total INTEGER NOT NULL DEFAULT 0,
      tasks_moved INTEGER NOT NULL DEFAULT 0,
      tasks_failed INTEGER NOT NULL DEFAULT 0,
      old_list_deleted INTEGER NOT NULL DEFAULT 0,
      undone_at TEXT,
      undo_notes TEXT
    )
  `);

  // Subtask Templates (safety-net for Drizzle migration 0003)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS subtask_templates (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT,
      type TEXT NOT NULL DEFAULT 'single',
      subtasks TEXT NOT NULL,
      workflow_tasks TEXT,
      icon TEXT,
      is_built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

export function applySubtaskTemplateColumnSafetyNets(_sqlite: Database.Database): void {
  // Migrate subtask_templates table: add columns from migration 0004
  const subtaskTemplateColumns = _sqlite.prepare("PRAGMA table_info('subtask_templates')").all() as Array<{ name: string }>;
  if (subtaskTemplateColumns.length > 0) {
    if (!subtaskTemplateColumns.some((column) => column.name === 'category')) {
      _sqlite.exec('ALTER TABLE subtask_templates ADD COLUMN category TEXT');
    }
    if (!subtaskTemplateColumns.some((column) => column.name === 'type')) {
      _sqlite.exec("ALTER TABLE subtask_templates ADD COLUMN type TEXT NOT NULL DEFAULT 'single'");
    }
    if (!subtaskTemplateColumns.some((column) => column.name === 'workflow_tasks')) {
      _sqlite.exec('ALTER TABLE subtask_templates ADD COLUMN workflow_tasks TEXT');
    }
    if (!subtaskTemplateColumns.some((column) => column.name === 'icon')) {
      _sqlite.exec('ALTER TABLE subtask_templates ADD COLUMN icon TEXT');
    }
  }
}
