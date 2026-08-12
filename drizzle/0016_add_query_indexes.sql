-- Add missing indexes to optimize list endpoint queries and reduce full table scans.
-- Covers: tasks filters/sorts, junction table lookups, alerts, triage, tags, projects.

-- ─── TASKS ──────────────────────────────────────────────────────────────────

-- Status filter (openOnly, status=X)
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

-- Priority filter & sort
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority);

-- Parent lookup for subtask counts (GROUP BY parent_id)
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks (parent_id);

-- Connector instance filter (soft-delete exclusion subquery)
CREATE INDEX IF NOT EXISTS idx_tasks_connector_instance_id ON tasks (connector_instance_id);

-- Due date filter (overdue, dueToday, dueThisWeek) and sort
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date);

-- Source list filter
CREATE INDEX IF NOT EXISTS idx_tasks_source_list_id ON tasks (source_list_id);

-- Updated at sort & "recently updated" filter
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks (updated_at);

-- Created at sort & "recently added" filter
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at);

-- Composite: open tasks by status + due date (common query pattern)
CREATE INDEX IF NOT EXISTS idx_tasks_status_due_date ON tasks (status, due_date);

-- Composite: open tasks sorted by priority (common default sort for open tasks)
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks (status, priority);

-- Snoozed until filter
CREATE INDEX IF NOT EXISTS idx_tasks_snoozed_until ON tasks (snoozed_until);

-- ─── JUNCTION TABLES ────────────────────────────────────────────────────────

-- task_tags: both sides for bidirectional lookups
CREATE INDEX IF NOT EXISTS idx_task_tags_task_id ON task_tags (task_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag_id ON task_tags (tag_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_tags_unique ON task_tags (task_id, tag_id);

-- task_projects: both sides for bidirectional lookups
CREATE INDEX IF NOT EXISTS idx_task_projects_task_id ON task_projects (task_id);
CREATE INDEX IF NOT EXISTS idx_task_projects_project_id ON task_projects (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_projects_unique ON task_projects (task_id, project_id);

-- project_tags: both sides
CREATE INDEX IF NOT EXISTS idx_project_tags_project_id ON project_tags (project_id);
CREATE INDEX IF NOT EXISTS idx_project_tags_tag_id ON project_tags (tag_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_tags_unique ON project_tags (project_id, tag_id);

-- alert_tags: both sides
CREATE INDEX IF NOT EXISTS idx_alert_tags_alert_id ON alert_tags (alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_tags_tag_id ON alert_tags (tag_id);

-- alert_projects: both sides
CREATE INDEX IF NOT EXISTS idx_alert_projects_alert_id ON alert_projects (alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_projects_project_id ON alert_projects (project_id);

-- ─── MY DAY ─────────────────────────────────────────────────────────────────

-- Date filter (primary access pattern)
CREATE INDEX IF NOT EXISTS idx_my_day_items_date ON my_day_items (date);

-- Task lookup (for removal, deduplication)
CREATE INDEX IF NOT EXISTS idx_my_day_items_task_id ON my_day_items (task_id);

-- Composite: date + task (common query: "is task X in my day for date Y?")
CREATE UNIQUE INDEX IF NOT EXISTS idx_my_day_items_task_date ON my_day_items (task_id, date);

-- ─── ALERTS ─────────────────────────────────────────────────────────────────

-- Connector instance (soft-delete exclusion)
CREATE INDEX IF NOT EXISTS idx_alerts_connector_instance_id ON alerts (connector_instance_id);

-- Received at sort (DESC order for list endpoint)
CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts (received_at);

-- Unread filter
CREATE INDEX IF NOT EXISTS idx_alerts_is_read ON alerts (is_read);

-- Composite: unread alerts sorted by recency (common query)
CREATE INDEX IF NOT EXISTS idx_alerts_is_read_received_at ON alerts (is_read, received_at);

-- ─── TRIAGE ─────────────────────────────────────────────────────────────────

-- Status filter
CREATE INDEX IF NOT EXISTS idx_triage_items_status ON triage_items (status);

-- Source platform filter
CREATE INDEX IF NOT EXISTS idx_triage_items_source_platform ON triage_items (source_platform);

-- Captured at sort
CREATE INDEX IF NOT EXISTS idx_triage_items_captured_at ON triage_items (captured_at);

-- AI relevance score sort
CREATE INDEX IF NOT EXISTS idx_triage_items_ai_relevance_score ON triage_items (ai_relevance_score);

-- Composite: status + relevance (default list view: pending items by relevance)
CREATE INDEX IF NOT EXISTS idx_triage_items_status_relevance ON triage_items (status, ai_relevance_score);

-- Source deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_items_source ON triage_items (source_platform, source_id);

-- ─── TAGS ───────────────────────────────────────────────────────────────────

-- Slug lookup (filter-factory uses eq(tags.slug, ...) frequently)
CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags (slug);

-- ─── SOURCE LISTS ───────────────────────────────────────────────────────────

-- Connector + source composite (lookup by connector instance + source ID)
CREATE INDEX IF NOT EXISTS idx_source_lists_connector_source ON source_lists (connector_instance_id, source_id);

-- ─── PROJECTS ───────────────────────────────────────────────────────────────

-- Project milestones by project
CREATE INDEX IF NOT EXISTS idx_project_milestones_project_id ON project_milestones (project_id);

-- Project phases by project
CREATE INDEX IF NOT EXISTS idx_project_phases_project_id ON project_phases (project_id);

-- Project phase items by phase and by task
CREATE INDEX IF NOT EXISTS idx_project_phase_items_phase_id ON project_phase_items (phase_id);
CREATE INDEX IF NOT EXISTS idx_project_phase_items_task_id ON project_phase_items (task_id);

-- ─── SYNC & CONNECTORS ──────────────────────────────────────────────────────

-- Sync log by connector (for recent sync status lookups)
CREATE INDEX IF NOT EXISTS idx_sync_log_connector_id ON sync_log (connector_id);

-- Inbound webhook log by webhook ID (for log listing)
CREATE INDEX IF NOT EXISTS idx_inbound_webhook_log_webhook_id ON inbound_webhook_log (webhook_id);
