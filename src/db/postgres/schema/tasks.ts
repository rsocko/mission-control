import { boolean, jsonb, serial } from 'drizzle-orm/pg-core';
import {
  doublePrecision as real,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tsvector } from './search';
import type { LocalDisposition } from '@/types';
import type { QuickSortBeforeSnapshot, QuickSortTaskSnapshot } from '@/types/quick-sort';

// ─── TASKS ──────────────────────────────────────────────────────────────────

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull(),
  connectorType: text('connector_type').notNull(),
  connectorInstanceId: text('connector_instance_id').notNull(),

  title: text('title').notNull(),
  description: text('description'),
  searchVector: tsvector('search_vector').generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
  ),
  status: text('status').notNull().default('todo'),
  localDisposition: text('local_disposition')
    .$type<LocalDisposition>()
    .notNull()
    .default('active'),
  priority: text('priority').notNull().default('none'),
  planningHorizon: text('planning_horizon').$type<'next' | 'soon' | 'later' | 'someday'>(),

  dueDate: text('due_date'),
  pushCount: integer('push_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  // Set only on locally generated recurring occurrences. One successor per occurrence.
  recurrenceGeneratedFromTaskId: text('recurrence_generated_from_task_id'),

  // Hierarchy
  parentId: text('parent_id'),
  depth: integer('depth').notNull().default(0),
  isChecklistItem: boolean('is_checklist_item').notNull().default(false),

  // Source grouping
  sourceListId: text('source_list_id'),
  sourceListName: text('source_list_name'),

  assignee: text('assignee'),

  // Micro-status: honest sub-status beyond todo/in_progress/done
  microStatus: text('micro_status'),

  // Reason a task was closed: 'completed' | 'not_planned' | 'duplicate'
  statusReason: text('status_reason'),

  metadata: jsonb('metadata').notNull().default({}),
  syncStatus: text('sync_status').notNull().default('synced'),
  lastSyncedAt: text('last_synced_at').notNull(),
  pushRetryCount: integer('push_retry_count').notNull().default(0),

  // View state
  kanbanColumn: text('kanban_column'),
  kanbanOrder: real('kanban_order'),

  // Snooze
  snoozedUntil: text('snoozed_until'),

  // Reminder (computed ISO datetime plus optional due-date-relative intent)
  reminderAt: text('reminder_at'),
  reminderRelative: text('reminder_relative'),
  reminderDueTime: text('reminder_due_time'),

  // Effort level (1–5, nullable — purely optional)
  effort: integer('effort'),

  // Flag: task was imported during initial connector sync (pre-existed in source)
  isBulkImport: boolean('is_bulk_import').notNull().default(false),
}, (table) => [
  index('idx_tasks_search_vector').using('gin', table.searchVector),
  uniqueIndex('idx_tasks_source_connector').on(table.sourceId, table.connectorInstanceId),
  index('idx_tasks_local_disposition').on(table.localDisposition),
  index('idx_tasks_planning_horizon').on(table.planningHorizon),
  index('idx_tasks_list_counts')
    .on(table.isChecklistItem, table.connectorInstanceId, table.sourceListId, table.status),
  index('idx_tasks_due_reminder')
    .on(table.reminderAt, table.status)
    .where(sql`${table.reminderAt} IS NOT NULL`),
  index('idx_tasks_push_count')
    .on(table.pushCount)
    .where(sql`${table.pushCount} >= 2`),
  uniqueIndex('idx_tasks_recurrence_generated_from')
    .on(table.recurrenceGeneratedFromTaskId)
    .where(sql`${table.recurrenceGeneratedFromTaskId} IS NOT NULL`),
]);

// ─── TASK REMINDER OCCURRENCES ───────────────────────────────────────────────

export const taskReminderOccurrences = pgTable('task_reminder_occurrences', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  scheduledAt: text('scheduled_at').notNull(),
  state: text('state')
    .$type<'pending' | 'processing' | 'fired' | 'cancelled' | 'failed'>()
    .notNull()
    .default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  claimToken: text('claim_token'),
  claimedAt: text('claimed_at'),
  leaseExpiresAt: text('lease_expires_at'),
  firedAt: text('fired_at'),
  cancelledAt: text('cancelled_at'),
  notificationId: text('notification_id'),
  lastError: text('last_error'),
  nextAttemptAt: text('next_attempt_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_task_reminder_occurrences_task_schedule')
    .on(table.taskId, table.scheduledAt),
  index('idx_task_reminder_occurrences_claim')
    .on(table.state, table.nextAttemptAt, table.leaseExpiresAt),
]);

// ─── TASK SCHEDULES (Focus & Planning) ──────────────────────────────────────

export const taskSchedules = pgTable('task_schedules', {
  taskId: text('task_id').primaryKey(),
  scheduledDate: text('scheduled_date').notNull(),
  scheduledTime: text('scheduled_time'),
  estimatedDuration: integer('estimated_duration'), // minutes
  isTimeBlocked: boolean('is_time_blocked').notNull().default(false),
  recurrence: text('recurrence'),
  recurrenceMode: text('recurrence_mode')
    .$type<'schedule' | 'completion'>()
    .notNull()
    .default('schedule'),
});

// ─── TAGS ───────────────────────────────────────────────────────────────────

export const tags = pgTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  type: text('type').notNull(), // source | hub | ai-inferred
  source: text('source'),
  color: text('color'),
  confirmed: boolean('confirmed').notNull().default(true),
  createdAt: text('created_at').notNull(),
  // When set, this source tag is "unified" under a hub tag — it still exists
  // in the source system but MC displays all tasks under the hub tag.
  unifiedInto: text('unified_into'),
});

// ─── TASK-TAG JUNCTION ──────────────────────────────────────────────────────

export const taskTags = pgTable('task_tags', {
  taskId: text('task_id').notNull(),
  tagId: text('tag_id').notNull(),
});

// ─── TASK-PROJECT JUNCTION ──────────────────────────────────────────────────

export const taskProjects = pgTable('task_projects', {
  taskId: text('task_id').notNull(),
  projectId: text('project_id').notNull(),
}, (table) => [
  uniqueIndex('idx_task_projects_task_project').on(table.taskId, table.projectId),
]);

// ─── TASK HISTORY (Reporting Foundation) ─────────────────────────────────────

export const taskHistoryEvents = pgTable('task_history_events', {
  id: serial('id').primaryKey(),
  taskId: text('task_id').notNull(),
  eventType: text('event_type').notNull(),
  fieldName: text('field_name'),
  previousValue: text('previous_value'),
  newValue: text('new_value'),
  projectId: text('project_id'),
  phaseId: text('phase_id'),
  occurredAt: text('occurred_at').notNull(),
  recordedAt: text('recorded_at').notNull(),
  provenance: text('provenance').notNull(),
  provenanceRef: jsonb('provenance_ref').$type<Record<string, unknown>>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('idx_task_history_task_time').on(table.taskId, table.occurredAt, table.id),
  index('idx_task_history_type_time').on(table.eventType, table.occurredAt),
  index('idx_task_history_project_time').on(table.projectId, table.occurredAt),
  index('idx_task_history_phase_time').on(table.phaseId, table.occurredAt),
  uniqueIndex('idx_task_history_planning_signal_once')
    .on(table.taskId, table.eventType, table.newValue)
    .where(sql`${table.eventType} IN ('my_day_missed', 'focus_missed', 'scheduled_block_elapsed', 'became_overdue')`),
  uniqueIndex('idx_task_history_planning_observation_once')
    .on(table.taskId, table.eventType, table.newValue, table.occurredAt)
    .where(sql`${table.eventType} IN ('my_day_committed', 'my_day_withdrawn', 'focus_committed', 'focus_withdrawn')`),
  index('idx_task_history_planning_date')
    .on(table.eventType, table.newValue)
    .where(sql`${table.eventType} IN ('my_day_committed', 'my_day_withdrawn', 'focus_committed', 'focus_withdrawn')`),
]);

export const taskFieldStates = pgTable('task_field_states', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  fieldName: text('field_name').notNull(),
  sourceValue: text('source_value').notNull(),
  locallyOverridden: boolean('locally_overridden').notNull().default(false),
  sourceObservedAt: text('source_observed_at'),
  localEditedAt: text('local_edited_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.fieldName] }),
  index('idx_task_field_states_task_id').on(table.taskId),
]);

export const taskIngestSuppressions = pgTable('task_ingest_suppressions', {
  connectorInstanceId: text('connector_instance_id').notNull(),
  sourceId: text('source_id').notNull(),
  reason: text('reason').$type<'hard-deleted'>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.connectorInstanceId, table.sourceId] }),
  index('idx_task_ingest_suppressions_source').on(table.sourceId),
]);

// ─── TASK DEPENDENCIES ───────────────────────────────────────────────────────

export const taskDependencies = pgTable('task_dependencies', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: text('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  type: text('type').$type<'blocks' | 'related'>().notNull().default('blocks'),
  connectorInstanceId: text('connector_instance_id'),
  syncStatus: text('sync_status').$type<'local' | 'pending' | 'synced' | 'failed'>().notNull().default('local'),
  syncAction: text('sync_action').$type<'create' | 'delete'>(),
  syncError: text('sync_error'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_task_dependencies_pair_type').on(table.taskId, table.dependsOnTaskId, table.type),
  index('idx_task_dependencies_depends_on').on(table.dependsOnTaskId),
]);

// ─── MY DAY ─────────────────────────────────────────────────────────────────

export const myDayItems = pgTable('my_day_items', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  date: text('date').notNull(), // YYYY-MM-DD
  addedAt: text('added_at').notNull(),
  isAutoIncluded: boolean('is_auto_included').notNull().default(false),
  order: real('order').notNull().default(0),
});

// ─── MY DAY EXCLUSIONS (tracks user-removed items so sync doesn't re-add) ───

export const myDayExclusions = pgTable('my_day_exclusions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  date: text('date').notNull(), // YYYY-MM-DD
  removedAt: text('removed_at').notNull(),
});

// ─── FOCUS ITEMS (Focus 3 Widget) ───────────────────────────────────────────

export const focusItems = pgTable('focus_items', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  scope: text('scope').notNull(), // 'today' | 'week'
  date: text('date').notNull(), // YYYY-MM-DD: the day (today) or Monday of the week (week)
  slot: integer('slot').notNull(), // 1, 2, or 3
  addedAt: text('added_at').notNull(),
  isAiSuggested: boolean('is_ai_suggested').notNull().default(false),
}, (table) => [
  index('idx_focus_items_task_id').on(table.taskId),
]);

// ─── WEEKLY ONE THING (ADHD "This Week, One Thing" banner) ──────────────────

export const weeklyOneThing = pgTable('weekly_one_thing', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  weekMonday: text('week_monday').notNull(), // YYYY-MM-DD of the Monday
  isManualOverride: boolean('is_manual_override').notNull().default(false),
  completedAt: text('completed_at'), // set when the "one thing" is marked done
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_weekly_one_thing_task_id').on(table.taskId),
]);

// ─── PRIORITY SYNC LOG ──────────────────────────────────────────────────────

export const prioritySyncLog = pgTable('priority_sync_log', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  connectorType: text('connector_type').notNull(),
  connectorInstanceId: text('connector_instance_id').notNull(),
  previousPriority: text('previous_priority').notNull(),
  newPriority: text('new_priority').notNull(),
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
  writeBackTriggered: boolean('write_back_triggered').notNull().default(false),
  note: text('note'),
  timestamp: text('timestamp').notNull(),
}, (table) => [
  index('idx_priority_sync_log_task_id').on(table.taskId),
]);

// ─── SUBTASK TEMPLATES ──────────────────────────────────────────────────────

export const subtaskTemplates = pgTable('subtask_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  category: text('category'), // e.g. 'development', 'home', '3d-printing', 'travel', 'personal'
  type: text('type').notNull().default('single'), // 'single' = task+subtasks, 'workflow' = multi-task set
  subtasks: jsonb('subtasks').notNull(), // Array<{ title, priority?, estimatedMinutes? }>
  // For workflow templates: array of top-level tasks to stamp out
  workflowTasks: jsonb('workflow_tasks'), // Array<{ title, description?, priority?, subtasks?: string[], tags?: string[] }>
  icon: text('icon'), // emoji or icon name
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── PRIORITY ENTITIES (Smart Score) ────────────────────────────────────────

export const priorityEntities = pgTable('priority_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'person' | 'project' | 'tag' | 'source' (team/domain are legacy)
  referenceId: text('reference_id'),
  description: text('description'),
  tier: text('tier').notNull().default('standard'), // 'critical' | 'high' | 'medium' | 'standard'
  color: text('color').notNull().default('#64748b'),
  /** Global rank across all tiers (1 = highest priority) */
  rank: integer('rank').notNull().default(0),
  /** Number of active tasks linked to this entity */
  activeTaskCount: integer('active_task_count').notNull().default(0),
  lastTouchedAt: text('last_touched_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── SOURCE RANKINGS (Smart Score) ──────────────────────────────────────────

export const sourceRankings = pgTable('source_rankings', {
  id: text('id').primaryKey(), // connector instance ID
  connectorType: text('connector_type').notNull(),
  name: text('name').notNull(),
  /** Rank order (1 = most trusted source) */
  rank: integer('rank').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

// ─── SMART SCORE SETTINGS ───────────────────────────────────────────────────

export const smartScoreSettings = pgTable('smart_score_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── ROUTINES & HABITS ──────────────────────────────────────────────────────

export const routines = pgTable('routines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** Cadence type: daily | specific_days | x_per_week | every_n_days | weekly | monthly | quarterly */
  cadenceType: text('cadence_type').notNull(),
  /** JSON config that varies by cadence type:
   * - specific_days: { days: number[] } (0=Sun..6=Sat)
   * - x_per_week: { target: number }
   * - every_n_days: { minDays: number, maxDays: number }
   * - weekly: { preferredDay?: number }
   * - monthly: { preferredDay?: string }
   * - quarterly: { preferredDay?: string }
   * - daily: {} (no extra config)
   */
  cadenceConfig: jsonb('cadence_config').notNull().default({}),
  /** Emoji or icon name */
  icon: text('icon'),
  /** Sort order within the cadence group */
  sortOrder: real('sort_order').notNull().default(0),
  /** Whether the routine is currently active */
  isActive: boolean('is_active').notNull().default(true),
  /** Whether the routine is archived (soft delete) */
  isArchived: boolean('is_archived').notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const routineCompletions = pgTable('routine_completions', {
  id: text('id').primaryKey(),
  routineId: text('routine_id').notNull(),
  /** The date the completion is recorded for (YYYY-MM-DD) */
  date: text('date').notNull(),
  /** Optional notes about the completion */
  notes: text('notes'),
  completedAt: text('completed_at').notNull(),
});

// ─── ENERGY CHECK-INS ───────────────────────────────────────────────────────

export const energyCheckins = pgTable('energy_checkins', {
  id: text('id').primaryKey(),
  date: text('date').notNull(), // YYYY-MM-DD
  level: text('level').notNull(), // 'high' | 'medium' | 'low'
  note: text('note'),
  createdAt: text('created_at').notNull(),
});

// ─── WEEKLY/MONTHLY RESETS ──────────────────────────────────────────────────

export const resets = pgTable('resets', {
  id: text('id').primaryKey(),
  /** 'weekly' or 'monthly' */
  type: text('type').notNull(),
  /** Start of the period (Monday for weekly, 1st for monthly) YYYY-MM-DD */
  periodStart: text('period_start').notNull(),
  /** End of the period (Sunday for weekly, last day for monthly) YYYY-MM-DD */
  periodEnd: text('period_end').notNull(),
  /** Free text: "What went well?" */
  wentWell: text('went_well'),
  /** Free text: "What needs adjustment?" */
  needsAdjustment: text('needs_adjustment'),
  /** Optional additional notes */
  notes: text('notes'),
  /** JSON snapshot of computed stats at time of reset */
  stats: jsonb('stats'),
  /** AI-generated weekly/monthly narrative summary */
  aiSummary: text('ai_summary'),
  /** JSON array of stale task actions: [{ taskId, action: 'keep'|'archive'|'break_down' }] */
  staleActions: jsonb('stale_actions').notNull().default([]),
  /** JSON array of carry-forward items: [{ description, detail?, kept: boolean }] */
  carryForwardItems: jsonb('carry_forward_items').notNull().default([]),
  /** Monthly only: biggest win reflection */
  monthlyWin: text('monthly_win'),
  /** Monthly only: what to change reflection */
  monthlyChange: text('monthly_change'),
  /** Monthly only: JSON array of next-month intentions [{ text, tag? }] */
  intentions: jsonb('intentions'),
  /** Set when "Complete Reset" is clicked */
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── QUICK SORT LOG ──────────────────────────────────────────────────────────

/**
 * Audit log of individual Quick Sort actions — used for activity stats,
 * streak tracking, and motivational feedback on the Quick Sort mode selector.
 */
export const quickSortLog = pgTable('task_triage_log', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  operationId: text('operation_id'),
  /** 'no_priority' | 'quadrant' | 'no_effort' | 'no_tags' | 'no_planning_horizon' */
  mode: text('mode').notNull(),
  /** 'applied' | 'suggestion_accepted' | 'skipped' */
  action: text('action').notNull(),
  triagedAt: text('triaged_at').notNull(),
  reversedAt: text('reversed_at'),
});

export const quickSortOperations = pgTable('quick_sort_operations', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  mode: text('mode').notNull(),
  action: text('action').notNull(),
  label: text('label').notNull(),
  contextKey: text('context_key').notNull(),
  queueIndex: integer('queue_index').notNull(),
  beforeSnapshot: jsonb('before_snapshot').$type<QuickSortBeforeSnapshot>().notNull(),
  afterSnapshot: jsonb('after_snapshot').$type<QuickSortTaskSnapshot>().notNull(),
  state: text('state').$type<'applying' | 'applied' | 'undoing' | 'undone'>().notNull(),
  aiAccepted: boolean('ai_accepted').notNull().default(false),
  createdAt: text('created_at').notNull(),
  undoneAt: text('undone_at'),
}, (table) => [
  index('idx_quick_sort_operations_task_created').on(table.taskId, table.createdAt),
]);

// ─── TASK LINKED SOURCES (Cross-Connector Provenance) ───────────────────────

/**
 * Tracks when a task is also represented in another connector/source.
 * Enables cross-connector dedup: instead of creating duplicate tasks,
 * we link existing tasks to their additional sources.
 */
export const taskLinkedSources = pgTable('task_linked_sources', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  connectorType: text('connector_type').notNull(),
  connectorInstanceId: text('connector_instance_id').notNull(),
  sourceId: text('source_id').notNull(),
  title: text('title').notNull(),
  linkedAt: text('linked_at').notNull(),
  matchConfidence: real('match_confidence'),
  metadata: jsonb('metadata').notNull().default({}),
}, (table) => [
  index('idx_task_linked_sources_task_id').on(table.taskId),
  uniqueIndex('idx_task_linked_sources_unique').on(
    table.taskId,
    table.connectorType,
    table.sourceId,
  ),
  uniqueIndex('idx_task_linked_sources_source_identity').on(
    table.connectorInstanceId,
    table.sourceId,
  ),
]);

// ─── TASK ATTACHMENTS ───────────────────────────────────────────────────────

export const taskAttachments = pgTable('task_attachments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  /** Display name of the file */
  name: text('name').notNull(),
  /** MIME type (e.g. 'image/png', 'application/pdf') */
  contentType: text('content_type').notNull(),
  /** File size in bytes */
  size: integer('size').notNull(),
  /** Base64-encoded content for local attachments (null for remote-only) */
  contentBase64: text('content_base64'),
  /** Source attachment ID for remote connectors (e.g. Graph API attachment ID) */
  sourceAttachmentId: text('source_attachment_id'),
  createdAt: text('created_at').notNull(),
});
