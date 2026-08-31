/**
 * Canonical task-deletion cleanup contract shared by every backend.
 *
 * A task row is referenced by a fixed set of association tables. Before the
 * `tasks` row itself is removed, every one of those rows must be deleted and
 * `notifications.related_task_id` must be nulled, otherwise a deleted task
 * leaves orphaned planning state (My Day, Focus, weekly one-thing), audit rows
 * (priority/triage/quick-sort), provenance (linked sources), or a dangling
 * notification reference behind.
 *
 * The list lives here — with no driver import — so the SQLite adapters, the
 * PostgreSQL adapters, and the architecture ratchet all read one definition
 * instead of maintaining separately drifting copies.
 */

/**
 * Association tables keyed by a plain `task_id` column, in deletion order.
 *
 * `task_dependencies` is deliberately absent: it references a task from two
 * columns and is handled by the backend helpers separately.
 */
export const TASK_ASSOCIATION_TABLES = [
  'task_tags',
  'project_auto_include_exclusions',
  'task_projects',
  'task_schedules',
  'task_field_states',
  'my_day_items',
  'my_day_exclusions',
  'focus_items',
  'weekly_one_thing',
  'priority_sync_log',
  'task_triage_log',
  'quick_sort_operations',
  'task_linked_sources',
  'task_attachments',
  'project_phase_items',
  'sync_deletion_candidates',
] as const;

export type TaskAssociationTable = typeof TASK_ASSOCIATION_TABLES[number];

/** Table whose rows reference a task from two columns. */
export const TASK_DEPENDENCY_TABLE = 'task_dependencies';

/** Table whose task reference is nulled rather than deleted. */
export const TASK_NOTIFICATION_TABLE = 'notifications';
