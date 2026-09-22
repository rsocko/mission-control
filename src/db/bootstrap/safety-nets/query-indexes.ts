import type Database from 'better-sqlite3';
import { execSafe } from './exec-safe';

export function applyCoreQueryIndexSafetyNets(_sqlite: Database.Database): void {
  const _execSafe = (sql: string) => execSafe(_sqlite, sql);
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
  _execSafe("CREATE INDEX IF NOT EXISTS idx_tasks_due_reminder ON tasks(reminder_at, status) WHERE reminder_at IS NOT NULL");

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

}

export function applySecondaryQueryIndexSafetyNets(_sqlite: Database.Database): void {
  const _execSafe = (sql: string) => execSafe(_sqlite, sql);
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

}
