CREATE TABLE `agent_dispatch_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`status` text NOT NULL,
	`provider_task_id` text,
	`provider_detail` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`dispatch_id`) REFERENCES `agent_dispatches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_dispatch_attempt_number` ON `agent_dispatch_attempts` (`dispatch_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `idx_agent_dispatch_attempt_status` ON `agent_dispatch_attempts` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `agent_dispatch_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dispatch_id` text NOT NULL,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`dispatch_id`) REFERENCES `agent_dispatches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_dispatch_events_dispatch` ON `agent_dispatch_events` (`dispatch_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_dispatch_events_created` ON `agent_dispatch_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `agent_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`external_agent_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`instruction` text NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`transport` text NOT NULL,
	`execution_locality` text NOT NULL,
	`data_classification` text NOT NULL,
	`allowed_actions` text NOT NULL,
	`disclosed_fields` text NOT NULL,
	`payload_preview` text NOT NULL,
	`preview_hash` text NOT NULL,
	`provider_task_id` text,
	`provider_detail` text,
	`result` text,
	`result_digest` text,
	`result_status` text,
	`claim_token_hash` text,
	`claimed_at` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`available_at` text NOT NULL,
	`deadline_at` text,
	`cancel_requested_at` text,
	`github_issue_url` text,
	`github_pull_request_url` text,
	`repository` text,
	`base_ref` text,
	`branch_ref` text,
	`commit_sha` text,
	`checks` text,
	`artifacts` text,
	`error_message` text,
	`confirmed_at` text,
	`started_at` text,
	`completed_at` text,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`external_agent_id`) REFERENCES `external_agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_dispatches_agent_idempotency` ON `agent_dispatches` (`external_agent_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_agent_dispatches_status_available` ON `agent_dispatches` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_dispatches_lease` ON `agent_dispatches` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_dispatches_provider_task` ON `agent_dispatches` (`provider_task_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_dispatches_completed` ON `agent_dispatches` (`completed_at`);--> statement-breakpoint
CREATE TABLE `external_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`transport` text NOT NULL,
	`execution_locality` text NOT NULL,
	`description` text,
	`endpoint` text,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auth_credential_ref` text,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`input_format` text DEFAULT 'mc-tasks' NOT NULL,
	`output_format` text DEFAULT 'mc-tasks' NOT NULL,
	`inbound_webhook_id` text,
	`data_policy` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_external_agents_enabled` ON `external_agents` (`enabled`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_external_agents_transport` ON `external_agents` (`transport`);