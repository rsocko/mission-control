CREATE TEMP TABLE `_duplicate_task_ids` AS
WITH RECURSIVE
ranked_tasks AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY source_id, connector_instance_id
      ORDER BY COALESCE(last_synced_at, '1970-01-01') DESC,
               COALESCE(updated_at, '1970-01-01') DESC,
               id DESC
    ) AS duplicate_rank
  FROM tasks
),
duplicate_tree(id) AS (
  SELECT id FROM ranked_tasks WHERE duplicate_rank > 1
  UNION
  SELECT tasks.id
  FROM tasks
  INNER JOIN duplicate_tree ON tasks.parent_id = duplicate_tree.id
)
SELECT id FROM duplicate_tree;
--> statement-breakpoint
DELETE FROM task_tags WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM task_projects WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM task_schedules WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM my_day_items WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM my_day_exclusions WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM focus_items WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM weekly_one_thing WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM priority_sync_log WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM task_triage_log WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM task_linked_sources WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM task_attachments WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM project_phase_items WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM task_dependencies
WHERE task_id IN (SELECT id FROM `_duplicate_task_ids`)
   OR depends_on_task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
UPDATE notifications
SET related_task_id = NULL
WHERE related_task_id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DELETE FROM tasks WHERE id IN (SELECT id FROM `_duplicate_task_ids`);
--> statement-breakpoint
DROP TABLE `_duplicate_task_ids`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_source_connector`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_source_connector`
ON `tasks` (`source_id`, `connector_instance_id`);
