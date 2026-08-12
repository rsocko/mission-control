import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';
import { dbLogger } from '@/lib/logger';
import { normalizeNotificationUrl } from '@/lib/notifications/providers/registry';
import {
  createObservedDatabase,
  DatabaseTelemetryCollector,
  type DatabaseTelemetrySnapshot,
} from '@/lib/telemetry/database';

// Lazy initialization: defer SQLite connection until first use so that
// Next.js build workers don't all race to open the database file during
// static analysis (which causes SQLITE_BUSY errors).

let _sqlite: Database.Database | null = null;
let _observedSqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;
const databaseTelemetry = new DatabaseTelemetryCollector();

function resetPartialDatabaseInitialization(): void {
  try {
    _sqlite?.close();
  } catch {
    // The original initialization error is more useful than a cleanup error.
  }
  _sqlite = null;
  _observedSqlite = null;
  _db = null;
}

export function shouldRunDatabaseInitialization(
  role = process.env.MC_PROCESS_ROLE,
  initializerRole = process.env.MC_DATABASE_INITIALIZER_ROLE ?? 'web',
): boolean {
  return (role ?? 'web') === initializerRole;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    let parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function _repairInboundWebhookNotificationActions(sqlite: Database.Database): void {
  const actions = sqlite.prepare(`
    SELECT
      notification_actions.id,
      notification_actions.notification_id AS notificationId,
      notification_actions.payload,
      notification_actions.is_primary AS isPrimary,
      notification_actions.sort_order AS sortOrder
    FROM notification_actions
    INNER JOIN notifications
      ON notifications.id = notification_actions.notification_id
    WHERE notifications.connector_type = 'inbound-webhook'
      AND notification_actions.action_type = 'open_url'
    ORDER BY
      notification_actions.notification_id,
      notification_actions.is_primary DESC,
      notification_actions.sort_order,
      notification_actions.id
  `).all() as Array<{
    id: string;
    notificationId: string;
    payload: string;
    isPrimary: number;
    sortOrder: number;
  }>;

  const repair = sqlite.transaction(() => {
    sqlite.prepare(`
      UPDATE notifications
      SET is_actionable = 0, primary_action_id = NULL
      WHERE connector_type = 'inbound-webhook'
    `).run();
    sqlite.prepare(`
      UPDATE notification_actions
      SET is_primary = 0
      WHERE action_type = 'open_url'
        AND notification_id IN (
          SELECT id FROM notifications WHERE connector_type = 'inbound-webhook'
        )
    `).run();

    const updateAction = sqlite.prepare(`
      UPDATE notification_actions
      SET payload = ?, opens_external = 1, is_primary = ?, sort_order = 0, created_by = 'connector'
      WHERE id = ?
    `);
    const updateNotification = sqlite.prepare(`
      UPDATE notifications
      SET is_actionable = 1, primary_action_id = ?
      WHERE id = ?
    `);
    const deleteAction = sqlite.prepare('DELETE FROM notification_actions WHERE id = ?');
    const linkedNotifications = new Set<string>();

    for (const action of actions) {
      const payload = parseJsonRecord(action.payload);
      const url = normalizeNotificationUrl(payload?.url);
      if (!url) {
        deleteAction.run(action.id);
        continue;
      }

      const isPrimary = !linkedNotifications.has(action.notificationId);
      updateAction.run(JSON.stringify({ ...payload, url }), isPrimary ? 1 : 0, action.id);
      if (isPrimary) {
        updateNotification.run(action.id, action.notificationId);
        linkedNotifications.add(action.notificationId);
      }
    }
  });
  repair();
}

/**
 * Apply Drizzle migrations one at a time, outside of Drizzle's single-transaction
 * wrapper.  Drizzle's built-in migrate() wraps ALL pending migrations in one
 * BEGIN/COMMIT, so a single failure rolls back every preceding migration—including
 * ones that created tables we need.  By running each migration individually we can
 * skip schema-level idempotency errors (duplicate column, table already exists,
 * no such table for ALTER on a table created by safety-net code) while letting
 * every other migration commit successfully.
 */
export function _runMigrationsIndividually(sqlite: Database.Database, migrationsFolder: string): void {
  // Ensure the Drizzle migrations tracking table exists.
  // Schema intentionally matches Drizzle's own CREATE TABLE (id SERIAL → INTEGER
  // PRIMARY KEY in SQLite, hash text, created_at numeric/integer are compatible).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at INTEGER
    )
  `);

  // Read the migration journal
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) return;
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));

  // Get already-applied migration hashes
  const applied = sqlite
    .prepare('SELECT hash FROM __drizzle_migrations')
    .all() as Array<{ hash: string }>;
  const appliedHashes = new Set(applied.map((r) => r.hash));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('crypto') as typeof import('crypto');

  for (const entry of journal.entries) {
    const tag = entry.tag as string;
    const sqlFile = path.join(migrationsFolder, `${tag}.sql`);
    if (!fs.existsSync(sqlFile)) continue;

    const sql = fs.readFileSync(sqlFile, 'utf-8');
    // Same hash algorithm as Drizzle: sha256 of raw file contents
    const hash = createHash('sha256').update(sql).digest('hex');

    if (appliedHashes.has(hash)) continue; // already applied

    // Split on Drizzle's statement breakpoint marker (same as Drizzle's readMigrationFiles)
    const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);

    let skipped = false;
    let failed = false;
    try {
      for (const stmt of statements) {
        try {
          sqlite.exec(stmt);
        } catch (stmtErr: unknown) {
          const msg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr);
          if (
            msg.includes('duplicate column name') ||
            msg.includes('already exists') ||
            (entry.idx < 33 && msg.includes('no such column')) ||
            (entry.idx < 33 && msg.includes('no such table')) ||
            (
              entry.tag === '0038_enforce_task_source_identity'
              && msg.includes('no such table: task_triage_log')
            ) ||
            (
              entry.tag === '0060_optimize_list_queries'
              && msg.includes('no such table')
            ) ||
            msg.includes('DROP COLUMN')
          ) {
            // Expected on fresh DB or when safety-net already applied the change
            skipped = true;
            continue;
          }
          throw stmtErr;
        }
      }
    } catch (e) {
      // Unexpected error (disk, permissions, corruption) — do NOT mark as
      // applied so it will be retried on next startup.
      dbLogger.error({ err: e, tag }, 'Migration failed unexpectedly — will retry on next startup');
      failed = true;
    }

    if (!failed) {
      // Mark migration as applied (uses entry.when which is Drizzle's folderMillis)
      sqlite.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
      ).run(hash, entry.when ?? Date.now());

      if (skipped) {
        dbLogger.info({ tag }, 'Migration applied (some statements skipped — schema already matched)');
      }
    } else {
      break;
    }
  }
}

function initDatabase(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  if (_observedSqlite && _db) return { sqlite: _observedSqlite, db: _db };
  if (_sqlite || _observedSqlite || _db) resetPartialDatabaseInitialization();

  const DB_PATH = process.env.MC_DB_PATH || path.join(process.cwd(), 'data', 'mission-control.db');

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _sqlite = new Database(DB_PATH);

  // The web process owns persistent database configuration and schema changes.
  // Workers open the database only after web readiness.
  if (shouldRunDatabaseInitialization()) {
    _sqlite.pragma('journal_mode = WAL');
  }
  _sqlite.pragma('foreign_keys = ON');
  const configuredBusyTimeoutMs = Number(process.env.MC_DB_BUSY_TIMEOUT_MS);
  const busyTimeoutMs = Number.isSafeInteger(configuredBusyTimeoutMs)
    && configuredBusyTimeoutMs > 0
    ? configuredBusyTimeoutMs
    : 5_000;
  _sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // ─── Run Drizzle migrations FIRST ───────────────────────────────────────
  // On a fresh DB, migrations create all core tables (tasks, alerts, etc.).
  // On an existing DB, already-applied migrations are skipped.
  // This must happen BEFORE the safety-net code below, which adds indexes
  // and columns to tables that migrations create.
  //
  // We use a custom per-migration runner instead of Drizzle's migrate()
  // because Drizzle wraps ALL pending migrations in a single transaction,
  // and a single failure (e.g. "table already exists" from safety-net code)
  // rolls back every preceding migration's work.
  //
  // Note: _db is created here for the return value but the module-level
  // _db is only assigned at the very end of initDatabase() to prevent
  // concurrent callers from seeing a partially-initialized database.
  _observedSqlite = createObservedDatabase(_sqlite, databaseTelemetry);
  const localDb = drizzle(_observedSqlite, { schema });

  if (shouldRunDatabaseInitialization()) {
    const migrationsPath = path.join(process.cwd(), 'drizzle');
    if (fs.existsSync(migrationsPath)) {
      _runMigrationsIndividually(_sqlite, migrationsPath);
    }

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
  _sqlite.exec(`
    DELETE FROM task_linked_sources
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM task_linked_sources
      GROUP BY connector_instance_id, source_id
    )
  `);
  _sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_linked_sources_source_identity
    ON task_linked_sources(connector_instance_id, source_id)
  `);
  _sqlite.exec(`
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

  // Helper: execute SQL but silently ignore "no such table" errors.
  // After migrations, all Drizzle-managed tables should exist, but this
  // provides an extra safety net for edge cases.
  const _execSafe = (sql: string) => {
    try {
      _sqlite!.exec(sql);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('no such table')) return;
      throw e;
    }
  };

  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS list_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

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
      last_run_duration_ms INTEGER
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

  // Inbound Webhooks (safety-net for Drizzle migration 0004)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbound_webhooks (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_label TEXT NOT NULL DEFAULT 'webhook',
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      default_action TEXT NOT NULL DEFAULT 'auto',
      field_mappings TEXT NOT NULL DEFAULT '{}',
      total_received INTEGER NOT NULL DEFAULT 0,
      last_received_at TEXT,
      last_status INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbound_webhook_log (
      id TEXT PRIMARY KEY NOT NULL,
      webhook_id TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      created_type TEXT,
      created_id TEXT,
      error_message TEXT,
      payload_preview TEXT,
      received_at TEXT NOT NULL
    )
  `);

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

  // Notifications (safety-net for Drizzle migration 0018)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      level TEXT NOT NULL DEFAULT 'fyi',
      level_rank INTEGER NOT NULL DEFAULT 3,
      category TEXT NOT NULL DEFAULT 'system',
      template_key TEXT,
      state TEXT NOT NULL DEFAULT 'unread',
      read_state TEXT NOT NULL DEFAULT 'unread',
      disposition TEXT NOT NULL DEFAULT 'inbox',
      source_state TEXT NOT NULL DEFAULT 'active',
      sync_state TEXT NOT NULL DEFAULT 'synced',
      read_at TEXT,
      handled_at TEXT,
      dismissed_at TEXT,
      resolved_at TEXT,
      archived_at TEXT,
      snoozed_until TEXT,
      source_resolved_at TEXT,
      last_source_activity_at TEXT,
      last_source_activity_key TEXT,
      handled_source_activity_at TEXT,
      handled_source_activity_key TEXT,
      last_source_synced_at TEXT,
      is_actionable INTEGER NOT NULL DEFAULT 0,
      primary_action_id TEXT,
      ai_suggested_action_id TEXT,
      received_at TEXT NOT NULL,
      sort_at TEXT NOT NULL,
      expires_at TEXT,
      group_key TEXT,
      dedupe_key TEXT,
      related_task_id TEXT,
      related_project_id TEXT,
      related_entity_type TEXT,
      related_entity_id TEXT,
      navigation_target TEXT,
      reconcile_attempts INTEGER NOT NULL DEFAULT 0,
      last_reconciled_at TEXT,
      stale_since TEXT,
      auto_resolve_reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      presentation TEXT NOT NULL DEFAULT '{}'
    )
  `);
  // Safety-net ALTERs for existing databases missing lifecycle/reconciliation columns.
  for (const col of [
    ['read_state', "TEXT NOT NULL DEFAULT 'unread'"],
    ['disposition', "TEXT NOT NULL DEFAULT 'inbox'"],
    ['source_state', "TEXT NOT NULL DEFAULT 'active'"],
    ['sync_state', "TEXT NOT NULL DEFAULT 'synced'"],
    ['handled_at', 'TEXT'],
    ['snoozed_until', 'TEXT'],
    ['source_resolved_at', 'TEXT'],
    ['last_source_activity_at', 'TEXT'],
    ['last_source_activity_key', 'TEXT'],
    ['handled_source_activity_at', 'TEXT'],
    ['handled_source_activity_key', 'TEXT'],
    ['last_source_synced_at', 'TEXT'],
    ['reconcile_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_reconciled_at', 'TEXT'],
    ['stale_since', 'TEXT'],
    ['auto_resolve_reason', 'TEXT'],
  ]) {
    try { _sqlite.exec(`ALTER TABLE notifications ADD COLUMN ${col[0]} ${col[1]}`); } catch { /* already exists */ }
  }
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_actions (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      label TEXT NOT NULL,
      icon TEXT,
      variant TEXT NOT NULL DEFAULT 'secondary',
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL DEFAULT '{}',
      opens_external INTEGER NOT NULL DEFAULT 0,
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT 'system',
      execution_state TEXT NOT NULL DEFAULT 'pending',
      claimed_at TEXT,
      completed_at TEXT,
      last_error TEXT
    )
  `);
  // Safety-net ALTERs for existing databases missing workflow execution state (migration 0032)
  for (const col of [
    ['execution_state', "TEXT NOT NULL DEFAULT 'pending'"],
    ['claimed_at', 'TEXT'],
    ['completed_at', 'TEXT'],
    ['last_error', 'TEXT'],
  ]) {
    try { _sqlite.exec(`ALTER TABLE notification_actions ADD COLUMN ${col[0]} ${col[1]}`); } catch { /* already exists */ }
  }
  _sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_source_id ON notifications(source_id)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_state ON notifications(state)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_sort_at ON notifications(state, sort_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_inbox ON notifications(disposition, source_state, snoozed_until, sort_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_attention ON notifications(disposition, source_state, read_state, level)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_reconcile_source ON notifications(connector_instance_id, source_state, last_reconciled_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_level ON notifications(level)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_received_at ON notifications(received_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_connector ON notifications(connector_type)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notification_actions_notification ON notification_actions(notification_id)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_reconcile ON notifications(connector_instance_id, state, last_reconciled_at)');

  // ─── Performance indexes for core query paths ─────────────────────────────
  // Tables below are created by Drizzle migrations, so use _execSafe to
  // tolerate missing tables on a fresh database.

  // Tasks table: heavily filtered/sorted columns
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_source_list_id ON tasks(source_list_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_connector_instance_id ON tasks(connector_instance_id)');
  // Compound index for the hot sync lookup path (sourceId + connectorInstanceId)
  _execSafe('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_connector ON tasks(source_id, connector_instance_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_sync_status ON tasks(sync_status)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_connector_type ON tasks(connector_type)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_list_counts ON tasks(is_checklist_item, connector_instance_id, source_list_id, status)');

  // Junction tables: both columns for bidirectional lookups
  _execSafe('CREATE INDEX IF NOT EXISTS idx_task_tags_task_id ON task_tags(task_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_task_tags_tag_id ON task_tags(tag_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_task_projects_task_id ON task_projects(task_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_task_projects_project_id ON task_projects(project_id)');

  // My Day items: queried by date and task
  _execSafe('CREATE INDEX IF NOT EXISTS idx_my_day_items_date ON my_day_items(date)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_my_day_items_task_id ON my_day_items(task_id)');

  // My Day exclusions: tracks tasks the user explicitly removed from My Day
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS my_day_exclusions (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      date TEXT NOT NULL,
      removed_at TEXT NOT NULL
    )
  `);
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_my_day_exclusions_date ON my_day_exclusions(date)');
  _sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_my_day_exclusions_task_date ON my_day_exclusions(task_id, date)');

  // Alerts: common filter paths
  _execSafe('CREATE INDEX IF NOT EXISTS idx_alerts_is_read ON alerts(is_read)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_alerts_connector_instance_id ON alerts(connector_instance_id)');

  // Sync log: lookup by connector + sort by time
  _execSafe('CREATE INDEX IF NOT EXISTS idx_sync_log_connector_id ON sync_log(connector_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_sync_log_synced_at ON sync_log(synced_at DESC)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_sync_log_connector_success_synced_at ON sync_log(connector_id, success, synced_at)');

  // Project phases and items
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_project_phases_project_id ON project_phases(project_id)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_project_phase_items_phase_id ON project_phase_items(phase_id)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_project_phase_items_task_id ON project_phase_items(task_id)');

  // Task schedules: queried by date
  _execSafe('CREATE INDEX IF NOT EXISTS idx_task_schedules_scheduled_date ON task_schedules(scheduled_date)');

  // Inbound webhook log: queried by webhook and received_at
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_inbound_webhook_log_webhook_id ON inbound_webhook_log(webhook_id)');

  // Tags: slug lookups are frequent across tasks, goals, AI, and bug-report routes
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug)');

  // Tags: add unified_into column for cross-source tag unification
  const tagColumns = _sqlite.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>;
  if (tagColumns.length > 0 && !tagColumns.some((column) => column.name === 'unified_into')) {
    _execSafe('ALTER TABLE tags ADD COLUMN unified_into TEXT');
  }

  // Tasks: updatedAt used for sorting recent tasks in AI context
  _execSafe('CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC)');

  // Alerts: receivedAt sorting + composite for unread-by-recency queries
  _execSafe('CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts(received_at DESC)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_alerts_is_read_received_at ON alerts(is_read, received_at DESC)');

  // Routines: sort order and archive filter
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_routines_sort_order ON routines(sort_order)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_routines_is_archived ON routines(is_archived)');

  // Finance transactions: completely unindexed table with frequent filters/sorts
  _execSafe('CREATE INDEX IF NOT EXISTS idx_finance_transactions_date ON finance_transactions(date DESC)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_finance_transactions_assigned_kid_id ON finance_transactions(assigned_kid_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_finance_transactions_confirmed_category ON finance_transactions(confirmed_category)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_finance_transactions_triage_status ON finance_transactions(triage_status)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_finance_transactions_kid_date ON finance_transactions(assigned_kid_id, date DESC)');

  // Kid rules: lookups by kid_id
  _execSafe('CREATE INDEX IF NOT EXISTS idx_kid_card_rules_kid_id ON kid_card_rules(kid_id)');
  _execSafe('CREATE INDEX IF NOT EXISTS idx_kid_merchant_rules_kid_id ON kid_merchant_rules(kid_id)');

  // Migrate connector_configs table: add deleted_at for soft delete
  const connectorConfigColumns = _sqlite.prepare("PRAGMA table_info('connector_configs')").all() as Array<{ name: string }>;
  if (connectorConfigColumns.length > 0 && !connectorConfigColumns.some((column) => column.name === 'deleted_at')) {
    _sqlite.exec('ALTER TABLE connector_configs ADD COLUMN deleted_at TEXT');
  }

  // Migrate list_groups table: add source_id for remote group correlation
  const listGroupColumns = _sqlite.prepare("PRAGMA table_info('list_groups')").all() as Array<{ name: string }>;
  if (listGroupColumns.length > 0 && !listGroupColumns.some((column) => column.name === 'source_id')) {
    _sqlite.exec('ALTER TABLE list_groups ADD COLUMN source_id TEXT');
  }
  if (listGroupColumns.length > 0 && !listGroupColumns.some((column) => column.name === 'icon_color')) {
    _sqlite.exec('ALTER TABLE list_groups ADD COLUMN icon_color TEXT');
  }

  const sourceListColumns = _sqlite.prepare("PRAGMA table_info('source_lists')").all() as Array<{ name: string }>;
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'group_id')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN group_id TEXT REFERENCES list_groups(id) ON DELETE SET NULL');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'well_known_list_name')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN well_known_list_name TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'sort_order')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'hidden')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'last_known_remote_name')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN last_known_remote_name TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'user_display_name')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN user_display_name TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'icon')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN icon TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'icon_color')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN icon_color TEXT');
  }

  // Migrate hub_projects table: add hidden column (safety net for Drizzle migration 0015)
  const hubProjectColumns = _sqlite.prepare("PRAGMA table_info('hub_projects')").all() as Array<{ name: string }>;
  if (hubProjectColumns.length > 0 && !hubProjectColumns.some((column) => column.name === 'hidden')) {
    _sqlite.exec('ALTER TABLE hub_projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  if (hubProjectColumns.length > 0 && !hubProjectColumns.some((column) => column.name === 'icon_color')) {
    _sqlite.exec('ALTER TABLE hub_projects ADD COLUMN icon_color TEXT');
  }

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
  _execSafe(
    'CREATE INDEX IF NOT EXISTS idx_tasks_local_disposition ON tasks(local_disposition)',
  );

  // Backfill lastSyncedAt for historical tasks that pre-date the column.
  // Without this, the pull-manager's fallback to updatedAt re-introduces the
  // "local edit blocks remote update" bug for pre-existing synced tasks.
  _execSafe("UPDATE tasks SET last_synced_at = updated_at WHERE last_synced_at IS NULL OR last_synced_at = ''");

  // Migrate alerts table: add dismissed columns (safety net for Drizzle migration 0017)
  const alertColumns = _sqlite.prepare("PRAGMA table_info('alerts')").all() as Array<{ name: string }>;
  if (alertColumns.length > 0 && !alertColumns.some((column) => column.name === 'is_dismissed')) {
    _sqlite.exec('ALTER TABLE alerts ADD COLUMN is_dismissed INTEGER NOT NULL DEFAULT 0');
  }
  if (alertColumns.length > 0 && !alertColumns.some((column) => column.name === 'dismissed_at')) {
    _sqlite.exec('ALTER TABLE alerts ADD COLUMN dismissed_at TEXT');
  }
  // Create index on is_dismissed after the column is guaranteed to exist
  _execSafe('CREATE INDEX IF NOT EXISTS idx_alerts_is_dismissed ON alerts(is_dismissed)');

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

  // Migrate sync_log table: add new audit columns
  const syncLogColumns = _sqlite.prepare("PRAGMA table_info('sync_log')").all() as Array<{ name: string }>;
  if (syncLogColumns.length > 0) {
    if (!syncLogColumns.some((column) => column.name === 'tasks_pushed')) {
      _sqlite.exec('ALTER TABLE sync_log ADD COLUMN tasks_pushed INTEGER NOT NULL DEFAULT 0');
    }
    if (!syncLogColumns.some((column) => column.name === 'local_only_protected')) {
      _sqlite.exec('ALTER TABLE sync_log ADD COLUMN local_only_protected INTEGER NOT NULL DEFAULT 0');
    }
    if (!syncLogColumns.some((column) => column.name === 'details')) {
      _sqlite.exec("ALTER TABLE sync_log ADD COLUMN details TEXT NOT NULL DEFAULT '[]'");
    }
  }

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

  // Push preferences: add do_not_disturb column (safety-net for Drizzle migration 0026)
  const pushPrefColumns = _sqlite.prepare("PRAGMA table_info('push_preferences')").all() as Array<{ name: string }>;
  if (pushPrefColumns.length > 0 && !pushPrefColumns.some(c => c.name === 'do_not_disturb')) {
    _execSafe('ALTER TABLE push_preferences ADD COLUMN do_not_disturb INTEGER NOT NULL DEFAULT 0');
  }

  // Connector push rules (safety-net for Drizzle migration 0035)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_push_rules (
      id TEXT PRIMARY KEY NOT NULL,
      connector_instance_id TEXT NOT NULL,
      template_key TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      min_level TEXT NOT NULL,
      preview TEXT NOT NULL,
      max_per_hour INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_push_rules_connector ON notification_push_rules(connector_instance_id)',
  );
  _sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_push_rules_connector_template ON notification_push_rules(connector_instance_id, template_key)',
  );

  // Durable push delivery outbox (safety-net for Drizzle migration 0036)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_delivery_events (
      id TEXT PRIMARY KEY NOT NULL,
      notification_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'web_push',
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      suppression_reason TEXT,
      policy_snapshot TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_expires_at TEXT,
      subscriptions_attempted INTEGER NOT NULL DEFAULT 0,
      subscriptions_sent INTEGER NOT NULL DEFAULT 0,
      subscriptions_failed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      last_error TEXT,
      FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
    )
  `);
  _sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_delivery_events_dedupe ON notification_delivery_events(dedupe_key)',
  );
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_delivery_events_dispatch ON notification_delivery_events(status, next_attempt_at, lease_expires_at)',
  );
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_delivery_events_notification ON notification_delivery_events(notification_id)',
  );
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_delivery_events_created_at ON notification_delivery_events(created_at)',
  );
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_deletion_candidates (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      first_missing_at TEXT NOT NULL,
      last_missing_at TEXT NOT NULL,
      missing_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_deletion_candidate_source
      ON sync_deletion_candidates (connector_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_sync_deletion_candidate_task
      ON sync_deletion_candidates (task_id);
    CREATE TABLE IF NOT EXISTS sync_deletion_snapshots (
      id TEXT PRIMARY KEY,
      original_task_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      reason TEXT NOT NULL,
      task_data TEXT NOT NULL,
      relationship_data TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      restored_at TEXT,
      restored_task_id TEXT,
      restore_mode TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_deletion_snapshot_task
      ON sync_deletion_snapshots (original_task_id);
    CREATE INDEX IF NOT EXISTS idx_sync_deletion_snapshot_deleted
      ON sync_deletion_snapshots (deleted_at);
  `);

    _repairInboundWebhookNotificationActions(_sqlite);
  }

  // Assign _db only after all initialization is complete, so concurrent
  // callers (via the Proxy) never see a partially-initialized database.
  _db = localDb;
  databaseTelemetry.reset();

  return { sqlite: _observedSqlite, db: _db };
}

export function initializeDatabase(): void {
  initDatabase();
}

// Use a Proxy so that `import db from '@/db'` still works seamlessly —
// every property access / method call lazily initialises the connection.
const db: BetterSQLite3Database<typeof schema> = new Proxy({} as BetterSQLite3Database<typeof schema>, {
  get(_target, prop, receiver) {
    const { db: realDb } = initDatabase();
    return Reflect.get(realDb, prop, receiver);
  },
});

// Proxy for `sqlite` so existing `import { sqlite } from '@/db'` call sites
// continue to work without changes — every property/method access lazily inits.
const sqlite: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop, receiver) {
    const { sqlite: realSqlite } = initDatabase();
    return Reflect.get(realSqlite, prop, receiver);
  },
});

/**
 * Run a set of write operations inside a single SQLite transaction.
 * BEGIN IMMEDIATE acquires the WAL write reservation before invoking the
 * callback, preventing a read snapshot from becoming SQLITE_BUSY_SNAPSHOT.
 * busy_timeout handles bounded waiting for another process's active writer.
 * Pass { readOnly: true } for a consistent deferred read snapshot that does
 * not reserve the writer slot.
 *
 * Usage:
 *   const result = runTransaction((tx) => {
 *     tx.update(tasks).set(...).where(...).run();
 *     tx.delete(taskTags).where(...).run();
 *     return { success: true };
 *   });
 */
function runTransaction<T>(
  fn: (tx: BetterSQLite3Database<typeof schema>) => T,
  options: { readOnly?: boolean } = {},
): T {
  const { db: realDb } = initDatabase();
  return realDb.transaction(fn, {
    behavior: options.readOnly ? 'deferred' : 'immediate',
  });
}

function getDatabaseTelemetry(): DatabaseTelemetrySnapshot {
  initDatabase();
  return databaseTelemetry.snapshot(_sqlite!);
}

function withoutDatabaseObservation<T>(callback: () => T): T {
  return databaseTelemetry.withoutObservation(callback);
}

export {
  db,
  sqlite,
  schema,
  runTransaction,
  getDatabaseTelemetry,
  withoutDatabaseObservation,
};
export default db;
