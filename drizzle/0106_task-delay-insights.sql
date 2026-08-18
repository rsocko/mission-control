ALTER TABLE `tasks` ADD `push_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_tasks_push_count` ON `tasks` (`push_count`) WHERE `push_count` >= 2;--> statement-breakpoint
CREATE TRIGGER `task_due_date_push_count`
AFTER UPDATE OF `due_date` ON `tasks`
WHEN OLD.`due_date` IS NOT NULL
  AND NEW.`due_date` IS NOT NULL
  AND julianday(substr(NEW.`due_date`, 1, 10)) > julianday(substr(OLD.`due_date`, 1, 10))
BEGIN
  UPDATE `tasks`
  SET `push_count` = OLD.`push_count` + 1
  WHERE `id` = NEW.`id`;

  INSERT INTO `task_history_events` (
    `task_id`,
    `event_type`,
    `field_name`,
    `previous_value`,
    `new_value`,
    `occurred_at`,
    `recorded_at`,
    `provenance`,
    `metadata`
  )
  VALUES (
    NEW.`id`,
    'due_date_pushed',
    'dueDate',
    OLD.`due_date`,
    NEW.`due_date`,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'database-trigger',
    json_object(
      'delayDays',
      CAST(julianday(substr(NEW.`due_date`, 1, 10)) - julianday(substr(OLD.`due_date`, 1, 10)) AS INTEGER)
    )
  );
END;
