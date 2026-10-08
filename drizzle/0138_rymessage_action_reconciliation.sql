CREATE TABLE `rymessage_action_feed_state` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`feed_id` text,
	`cursor` text,
	`recovery_generation` integer DEFAULT 0 NOT NULL,
	`recovery_required` integer DEFAULT true NOT NULL,
	`full_sync_generation` text,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rymessage_action_materializations` (
	`connector_id` text NOT NULL,
	`materialization_id` text NOT NULL,
	`action_id` text NOT NULL,
	`action_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`provider_list_id` text NOT NULL,
	`provider_task_id` text NOT NULL,
	`state` text NOT NULL,
	`provider_task_status_snapshot` text,
	`provider_version_snapshot` text,
	`last_observed_at` text,
	`local_task_id` text,
	`relation_state` text NOT NULL,
	`conflict_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `materialization_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rymessage_materialization_provider_identity` ON `rymessage_action_materializations` (`connector_id`,`provider`,`provider_account_id`,`provider_list_id`,`provider_task_id`);--> statement-breakpoint
CREATE INDEX `idx_rymessage_materialization_action` ON `rymessage_action_materializations` (`connector_id`,`action_id`);--> statement-breakpoint
CREATE INDEX `idx_rymessage_materialization_relation` ON `rymessage_action_materializations` (`connector_id`,`relation_state`);--> statement-breakpoint
CREATE TABLE `rymessage_action_outbound_mutations` (
	`connector_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`action_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`expected_field_revisions` text NOT NULL,
	`mutation` text NOT NULL,
	`mutation_digest` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_id` text,
	`lease_expires_at` text,
	`available_at` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`receipt` text,
	`last_error_code` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `operation_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rymessage_mutation_ready` ON `rymessage_action_outbound_mutations` (`connector_id`,`status`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_rymessage_mutation_action` ON `rymessage_action_outbound_mutations` (`connector_id`,`action_id`);--> statement-breakpoint
CREATE TABLE `rymessage_action_projections` (
	`connector_id` text NOT NULL,
	`action_id` text NOT NULL,
	`source_id` text NOT NULL,
	`stable_key` text,
	`revision` integer NOT NULL,
	`payload` text,
	`payload_digest` text NOT NULL,
	`last_event_id` text NOT NULL,
	`last_operation_id` text NOT NULL,
	`last_seen_generation` text,
	`tombstoned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `action_id`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rymessage_action_source` ON `rymessage_action_projections` (`connector_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_rymessage_action_generation` ON `rymessage_action_projections` (`connector_id`,`last_seen_generation`,`tombstoned_at`);--> statement-breakpoint
CREATE TABLE `rymessage_action_receipts` (
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
CREATE INDEX `idx_rymessage_receipt_operation` ON `rymessage_action_receipts` (`connector_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_rymessage_receipt_retention` ON `rymessage_action_receipts` (`connector_id`,`received_at`);