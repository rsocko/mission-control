-- Purge legacy markdown checkbox tasks from GitHub Issues connector.
-- These were created by parseMarkdownTaskList() which scanned issue bodies
-- for "- [ ]" / "- [x]" lines and created a task row for each one.
-- They are NOT real GitHub entities and cannot be updated bidirectionally.
-- Real sub-issues (with proper repo:number sourceIds) are preserved.

-- Remove from all junction/reference tables first
DELETE FROM task_projects WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM task_tags WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM task_attachments WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM task_linked_sources WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM task_schedules WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM my_day_items WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM my_day_exclusions WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM focus_items WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM weekly_one_thing WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM priority_sync_log WHERE task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
DELETE FROM notifications WHERE related_task_id IN (
  SELECT id FROM tasks WHERE source_id LIKE 'checklist:%'
);
--> statement-breakpoint
-- Clear child_ids on parent tasks — next sync will rebuild them
-- with only real sub-issues (no more checklist phantoms).
UPDATE tasks SET child_ids = '[]'
WHERE id IN (
  SELECT DISTINCT parent_id FROM tasks
  WHERE source_id LIKE 'checklist:%' AND parent_id IS NOT NULL
);
--> statement-breakpoint
-- Delete the checklist tasks themselves
DELETE FROM tasks WHERE source_id LIKE 'checklist:%';
