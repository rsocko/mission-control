import { boolean, jsonb } from 'drizzle-orm/pg-core';
import {
  doublePrecision as real,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandRequest,
  ProjectHierarchyCommandResult,
} from '@/lib/projects/hierarchy-types';

// ─── HUB PROJECTS ───────────────────────────────────────────────────────────

export const hubProjects = pgTable('hub_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#3b82f6'),
  icon: text('icon'),
  iconColor: text('icon_color'),
  sourceBindings: jsonb('source_bindings').notNull().default([]),
  autoIncludeRules: jsonb('auto_include_rules').notNull().default([]),
  kanbanColumns: jsonb('kanban_columns').notNull().default([]),
  defaultView: text('default_view').notNull().default('list'),
  defaultFilters: jsonb('default_filters'),

  // Lifecycle
  status: text('status').notNull().default('active'),
  statusOverride: text('status_override'),
  hidden: boolean('hidden').notNull().default(false),

  category: text('category'),
  targetDate: text('target_date'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  sortOrder: real('sort_order').notNull().default(0),
  hierarchyRevision: integer('hierarchy_revision').notNull().default(0),
  metadata: jsonb('metadata').notNull().default({}),

  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── PROJECT-TAG JUNCTION ───────────────────────────────────────────────────

export const projectTags = pgTable('project_tags', {
  projectId: text('project_id').notNull(),
  tagId: text('tag_id').notNull(),
});

export const projectAutoIncludeExclusions = pgTable('project_auto_include_exclusions', {
  projectId: text('project_id').notNull(),
  taskId: text('task_id').notNull(),
  excludedAt: text('excluded_at').notNull(),
}, (table) => [
  uniqueIndex('idx_project_auto_include_exclusions_project_task').on(table.projectId, table.taskId),
  index('idx_project_auto_include_exclusions_task').on(table.taskId),
]);

// ─── PROJECT MILESTONES ─────────────────────────────────────────────────────

export const projectMilestones = pgTable('project_milestones', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  targetDate: text('target_date'),
  completedAt: text('completed_at'),
  sortOrder: real('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

// ─── PROJECT PHASES ─────────────────────────────────────────────────────────

export const projectPhases = pgTable('project_phases', {
  id: text('id').primaryKey(),
  projectId: text('project_id'), // nullable = cross-project phase
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('pending'), // pending | in_progress | completed
  color: text('color'),
  estimatedDays: real('estimated_days'),
  targetStart: text('target_start'),
  targetEnd: text('target_end'),
  startAfterPhaseId: text('start_after_phase_id'), // dependency: starts after this phase
  sortOrder: real('sort_order').notNull().default(0),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const projectPhaseItems = pgTable('project_phase_items', {
  id: text('id').primaryKey(),
  phaseId: text('phase_id').notNull(),
  taskId: text('task_id').notNull(),
  sortOrder: real('sort_order').notNull().default(0),
  estimatedEffortHours: real('estimated_effort_hours'),
  isProposed: boolean('is_proposed').notNull().default(false),
  proposalType: text('proposal_type'), // new_task | close | split
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_project_phase_items_phase_task').on(table.phaseId, table.taskId),
]);

// ─── PROJECT HIERARCHY COMMAND AUDIT ────────────────────────────────────────

export const projectHierarchyCommands = pgTable('project_hierarchy_commands', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  baseRevision: integer('base_revision').notNull(),
  resultRevision: integer('result_revision').notNull(),
  commandType: text('command_type').notNull(),
  request: jsonb('request_json').$type<ProjectHierarchyCommandRequest>().notNull(),
  inverseCommand: jsonb('inverse_command_json').$type<ProjectHierarchyCommand>(),
  result: jsonb('result_json').$type<ProjectHierarchyCommandResult>().notNull(),
  actorType: text('actor_type').notNull().default('user'),
  actorId: text('actor_id'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_project_hierarchy_commands_project_revision').on(table.projectId, table.resultRevision),
]);

export const projectHierarchyMutationContext = pgTable('project_hierarchy_mutation_context', {
  projectId: text('project_id').primaryKey(),
});
