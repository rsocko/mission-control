CREATE UNIQUE INDEX `idx_task_history_planning_signal_once`
ON `task_history_events` (`task_id`, `event_type`, `new_value`)
WHERE `event_type` IN (
  'my_day_missed',
  'focus_missed',
  'scheduled_block_elapsed',
  'became_overdue'
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_history_planning_observation_once`
ON `task_history_events` (`task_id`, `event_type`, `new_value`, `occurred_at`)
WHERE `event_type` IN (
  'my_day_committed',
  'my_day_withdrawn',
  'focus_committed',
  'focus_withdrawn'
);--> statement-breakpoint
CREATE INDEX `idx_task_history_planning_date`
ON `task_history_events` (`event_type`, `new_value`)
WHERE `event_type` IN (
  'my_day_committed',
  'my_day_withdrawn',
  'focus_committed',
  'focus_withdrawn'
);--> statement-breakpoint
CREATE TRIGGER `task_snooze_extension_history`
AFTER UPDATE OF `snoozed_until` ON `tasks`
WHEN OLD.`snoozed_until` IS NOT NULL
  AND NEW.`snoozed_until` IS NOT NULL
  AND julianday(NEW.`snoozed_until`) > julianday(OLD.`snoozed_until`)
BEGIN
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
    'snooze_extended',
    'snoozedUntil',
    OLD.`snoozed_until`,
    NEW.`snoozed_until`,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'database-trigger',
    json_object(
      'delayHours',
      ROUND((julianday(NEW.`snoozed_until`) - julianday(OLD.`snoozed_until`)) * 24, 1)
    )
  );
END;
