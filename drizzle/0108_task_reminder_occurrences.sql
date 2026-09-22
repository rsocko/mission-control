CREATE TABLE `task_reminder_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`claimed_at` text,
	`lease_expires_at` text,
	`fired_at` text,
	`cancelled_at` text,
	`notification_id` text,
	`last_error` text,
	`next_attempt_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_reminder_occurrences_task_schedule` ON `task_reminder_occurrences` (`task_id`,`scheduled_at`);
--> statement-breakpoint
CREATE INDEX `idx_task_reminder_occurrences_claim` ON `task_reminder_occurrences` (`state`,`next_attempt_at`,`lease_expires_at`);
--> statement-breakpoint
UPDATE `tasks`
SET `reminder_at` = 'invalid-timezone:legacy:' || `reminder_at`
WHERE `reminder_at` IS NOT NULL
	AND julianday(`reminder_at`) IS NOT NULL
	AND `reminder_at` NOT GLOB '*[Zz]'
	AND `reminder_at` NOT GLOB '*[+-][0-9][0-9]:[0-9][0-9]';
--> statement-breakpoint
UPDATE `tasks`
SET `reminder_at` = strftime('%Y-%m-%dT%H:%M:%fZ', `reminder_at`)
WHERE `reminder_at` IS NOT NULL
	AND julianday(`reminder_at`) IS NOT NULL
	AND (
		`reminder_at` GLOB '*[Zz]'
		OR `reminder_at` GLOB '*[+-][0-9][0-9]:[0-9][0-9]'
	);
--> statement-breakpoint
CREATE INDEX `idx_tasks_due_reminder` ON `tasks` (`reminder_at`,`status`) WHERE `reminder_at` IS NOT NULL;
