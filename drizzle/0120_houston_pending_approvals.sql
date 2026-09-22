CREATE TABLE `houston_finance_pending_approvals` (
	`approval_id` text PRIMARY KEY NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool` text NOT NULL,
	`tool_input` text NOT NULL,
	`correlation_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_houston_finance_pending_expiry` ON `houston_finance_pending_approvals` (`expires_at`);
