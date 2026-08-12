CREATE TABLE `task_field_states` (
  `task_id` text NOT NULL,
  `field_name` text NOT NULL,
  `source_value` text NOT NULL,
  `locally_overridden` integer DEFAULT false NOT NULL,
  `source_observed_at` text,
  `local_edited_at` text,
  `updated_at` text NOT NULL,
  PRIMARY KEY(`task_id`, `field_name`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_field_states_task_id` ON `task_field_states` (`task_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO task_field_states (
  task_id,
  field_name,
  source_value,
  locally_overridden,
  source_observed_at,
  local_edited_at,
  updated_at
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
  false,
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
WHERE tasks.connector_type = 'scout';
