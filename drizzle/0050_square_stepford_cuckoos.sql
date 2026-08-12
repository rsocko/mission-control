CREATE TABLE `scout_reconciliation_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`candidate_action` text NOT NULL,
	`action` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence_hash` text NOT NULL,
	`evidence` text NOT NULL,
	`policy_decision` text NOT NULL,
	`policy_reason` text NOT NULL,
	`payload_hash` text NOT NULL,
	`applied` integer DEFAULT false NOT NULL,
	`applied_result` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `scout_reconciliation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scout_reconciliation_evaluation_run_task` ON `scout_reconciliation_evaluations` (`run_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `idx_scout_reconciliation_evaluation_task_time` ON `scout_reconciliation_evaluations` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_scout_reconciliation_evaluation_action_time` ON `scout_reconciliation_evaluations` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `scout_reconciliation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`lookback_hours` integer NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`source_identity` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`lease_token` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scout_reconciliation_run_idempotency` ON `scout_reconciliation_runs` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scout_reconciliation_active_scope` ON `scout_reconciliation_runs` (`scope_key`) WHERE "scout_reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `idx_scout_reconciliation_run_scope_time` ON `scout_reconciliation_runs` (`scope_key`,`started_at`);--> statement-breakpoint
CREATE TABLE `scout_reconciliation_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`evaluation_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence_hash` text NOT NULL,
	`evidence` text NOT NULL,
	`policy_decision` text NOT NULL,
	`policy_reason` text NOT NULL,
	`payload_hash` text NOT NULL,
	`proposed_effect` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`acted_at` text,
	`acted_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `scout_reconciliation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_id`) REFERENCES `scout_reconciliation_evaluations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scout_reconciliation_pending_task` ON `scout_reconciliation_suggestions` (`task_id`) WHERE "scout_reconciliation_suggestions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `idx_scout_reconciliation_suggestion_status_time` ON `scout_reconciliation_suggestions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_scout_reconciliation_suggestion_evidence` ON `scout_reconciliation_suggestions` (`task_id`,`evidence_hash`);--> statement-breakpoint
CREATE TABLE `scout_reconciliation_task_state` (
	`task_id` text PRIMARY KEY NOT NULL,
	`never_auto_complete` integer DEFAULT false NOT NULL,
	`reason` text NOT NULL,
	`source_run_id` text,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);