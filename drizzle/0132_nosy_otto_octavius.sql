ALTER TABLE `tasks` ADD `sibling_order` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `subtask_order_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY parent_id
    ORDER BY created_at, id
  ) - 1 AS sibling_order
  FROM tasks
  WHERE parent_id IS NOT NULL
)
UPDATE tasks
SET sibling_order = (
  SELECT ranked.sibling_order
  FROM ranked
  WHERE ranked.id = tasks.id
)
WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_sibling_order` ON `tasks` (`parent_id`,`sibling_order`);