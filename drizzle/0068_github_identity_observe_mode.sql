CREATE TABLE `github_identity_exception_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connector_instance_id` text NOT NULL,
	`binding_type` text NOT NULL,
	`local_id` text NOT NULL,
	`category` text NOT NULL,
	`action` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_identity_exception_events_type_check" CHECK("github_identity_exception_events"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "github_identity_exception_events_category_check" CHECK("github_identity_exception_events"."category" IN ('terminal_inaccessible')),
	CONSTRAINT "github_identity_exception_events_action_check" CHECK("github_identity_exception_events"."action" IN ('accept', 'revoke'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_identity_exception_events_idempotency` ON `github_identity_exception_events` (`connector_instance_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_exception_events_local` ON `github_identity_exception_events` (`connector_instance_id`,`binding_type`,`local_id`,`id`);