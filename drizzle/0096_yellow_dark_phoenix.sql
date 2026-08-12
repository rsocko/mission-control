CREATE TABLE `github_identity_task_transfer_reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`source_task_id` text NOT NULL,
	`successor_task_id` text NOT NULL,
	`source_external_entity_id` text NOT NULL,
	`successor_external_entity_id` text NOT NULL,
	`expected_mode_revision` integer NOT NULL,
	`proof_kind` text NOT NULL,
	`proof` text NOT NULL,
	`proof_digest` text NOT NULL,
	`observed_at` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`successor_external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "github_task_transfer_reconciliations_distinct_tasks_check" CHECK("github_identity_task_transfer_reconciliations"."source_task_id" <> "github_identity_task_transfer_reconciliations"."successor_task_id"),
	CONSTRAINT "github_task_transfer_reconciliations_distinct_entities_check" CHECK("github_identity_task_transfer_reconciliations"."source_external_entity_id" <> "github_identity_task_transfer_reconciliations"."successor_external_entity_id"),
	CONSTRAINT "github_task_transfer_reconciliations_revision_check" CHECK("github_identity_task_transfer_reconciliations"."expected_mode_revision" >= 0),
	CONSTRAINT "github_task_transfer_reconciliations_proof_check" CHECK("github_identity_task_transfer_reconciliations"."proof_kind" = 'rest_historical_redirect'
        AND length("github_identity_task_transfer_reconciliations"."proof_digest") = 64),
	CONSTRAINT "github_task_transfer_reconciliations_audit_check" CHECK(length("github_identity_task_transfer_reconciliations"."actor") BETWEEN 1 AND 80
        AND length("github_identity_task_transfer_reconciliations"."reason") BETWEEN 3 AND 500
        AND length("github_identity_task_transfer_reconciliations"."idempotency_key") BETWEEN 8 AND 192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_task_transfer_reconciliations_idempotency` ON `github_identity_task_transfer_reconciliations` (`connector_instance_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_task_transfer_reconciliations_source` ON `github_identity_task_transfer_reconciliations` (`connector_instance_id`,`source_task_id`);--> statement-breakpoint
CREATE INDEX `idx_github_task_transfer_reconciliations_successor` ON `github_identity_task_transfer_reconciliations` (`connector_instance_id`,`successor_task_id`);