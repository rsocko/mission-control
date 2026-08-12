CREATE TABLE `connector_maintenance_locks` (
	`connector_instance_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`acquired_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `github_repository_repoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_connector_maintenance_locks_operation` ON `connector_maintenance_locks` (`operation_id`);--> statement-breakpoint
CREATE TABLE `github_repository_repoint_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_id` text NOT NULL,
	`phase` text NOT NULL,
	`actor` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `github_repository_repoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_github_repository_repoint_events_operation` ON `github_repository_repoint_events` (`operation_id`,`id`);--> statement-breakpoint
CREATE TABLE `github_repository_repoints` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`phase` text NOT NULL,
	`actor` text NOT NULL,
	`host_key` text NOT NULL,
	`repository_entity_id` text NOT NULL,
	`repository_stable_id` text NOT NULL,
	`from_owner` text NOT NULL,
	`from_repository` text NOT NULL,
	`to_owner` text NOT NULL,
	`to_repository` text NOT NULL,
	`connector_was_enabled` integer NOT NULL,
	`backup_proof` text NOT NULL,
	`preflight` text NOT NULL,
	`rollback_snapshot` text NOT NULL,
	`verification` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "github_repository_repoints_phase_check" CHECK("github_repository_repoints"."phase" IN ('locked', 'applying', 'applied', 'verifying', 'verified', 'verification_failed', 'rolling_back', 'rolled_back', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_repository_repoints_idempotency` ON `github_repository_repoints` (`connector_instance_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_repository_repoints_active_connector` ON `github_repository_repoints` (`connector_instance_id`) WHERE "github_repository_repoints"."phase" IN ('locked', 'applying', 'applied', 'verifying', 'verification_failed', 'rolling_back');--> statement-breakpoint
CREATE INDEX `idx_github_repository_repoints_phase` ON `github_repository_repoints` (`phase`,`updated_at`);