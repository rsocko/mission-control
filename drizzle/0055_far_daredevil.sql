CREATE TABLE `ai_provider_sessions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`encrypted_reference` text NOT NULL,
	`initialization_vector` text NOT NULL,
	`auth_tag` text NOT NULL,
	`key_version` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_provider_sessions_expiry` ON `ai_provider_sessions` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_provider_sessions_provider` ON `ai_provider_sessions` (`provider`,`state`);--> statement-breakpoint
CREATE TABLE `ai_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ai_run_events_event_id` ON `ai_run_events` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ai_run_events_sequence` ON `ai_run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ai_run_events_idempotency` ON `ai_run_events` (`run_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_ai_run_events_cursor` ON `ai_run_events` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_ai_run_events_created` ON `ai_run_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`feature_id` text NOT NULL,
	`sensitivity` text NOT NULL,
	`status` text NOT NULL,
	`execution_route` text NOT NULL,
	`requested_provider` text,
	`requested_model` text,
	`provider` text,
	`model` text,
	`fallback_state` text DEFAULT 'not_requested' NOT NULL,
	`correlation_id` text NOT NULL,
	`traceparent` text,
	`tracestate` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`available_at` text NOT NULL,
	`timeout_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`cancel_requested_at` text,
	`started_at` text,
	`completed_at` text,
	`last_error_code` text,
	`last_error_message` text,
	`notify_on_completion` integer DEFAULT false NOT NULL,
	`cleanup_status` text DEFAULT 'none' NOT NULL,
	`execution_state` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ai_runs_idempotency` ON `ai_runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_claim` ON `ai_runs` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_lease` ON `ai_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_correlation` ON `ai_runs` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_history` ON `ai_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_expiry` ON `ai_runs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_runs_cleanup` ON `ai_runs` (`cleanup_status`,`updated_at`);