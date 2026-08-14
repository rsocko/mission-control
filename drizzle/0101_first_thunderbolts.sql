CREATE TABLE `houston_finance_action_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text NOT NULL,
	`call_hash` text NOT NULL,
	`tool` text NOT NULL,
	`decision` text NOT NULL,
	`outcome` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_houston_finance_action_call` ON `houston_finance_action_audit` (`call_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_houston_finance_action_correlation` ON `houston_finance_action_audit` (`correlation_id`,`created_at`);