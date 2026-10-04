CREATE TABLE `rymessage_action_v2_feed_state` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`feed_id` text,
	`cursor` text,
	`recovery_generation` integer DEFAULT 0 NOT NULL,
	`recovery_required` integer DEFAULT true NOT NULL,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rymessage_action_v2_outbound_mutations` (
	`connector_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`action_id` text NOT NULL,
	`mutation` text NOT NULL,
	`mutation_digest` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_id` text,
	`lease_expires_at` text,
	`available_at` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`receipt` text,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `operation_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rymessage_action_v2_mutation_ready` ON `rymessage_action_v2_outbound_mutations` (`connector_id`,`status`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `rymessage_action_v2_projections` (
	`connector_id` text NOT NULL,
	`action_id` text NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text,
	`payload_digest` text NOT NULL,
	`last_event_id` text NOT NULL,
	`last_operation_id` text NOT NULL,
	`tombstoned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `action_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rymessage_action_v2_source` ON `rymessage_action_v2_projections` (`connector_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `rymessage_action_v2_receipts` (
	`connector_id` text NOT NULL,
	`event_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`action_id` text NOT NULL,
	`aggregate_revision` integer NOT NULL,
	`payload_digest` text NOT NULL,
	`outcome` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `event_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rymessage_action_v2_receipt_retention` ON `rymessage_action_v2_receipts` (`connector_id`,`received_at`);