CREATE TABLE `finance_attention_repair_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`mode` text NOT NULL,
	`actor_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`dry_run_id` text,
	`reason_code` text NOT NULL,
	`target_digest` text NOT NULL,
	`occurrence_count` integer NOT NULL,
	`notification_count` integer NOT NULL,
	`action_count` integer NOT NULL,
	`delivery_count` integer NOT NULL,
	`task_count` integer NOT NULL,
	`my_day_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_attention_repair_idempotency` ON `finance_attention_repair_audit` (`connector_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_finance_attention_repair_connector` ON `finance_attention_repair_audit` (`connector_id`,`created_at`);