CREATE TABLE `github_bulk_transfer_successions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`source_external_entity_id` text NOT NULL,
	`successor_external_entity_id` text NOT NULL,
	`source_stable_id_digest` text NOT NULL,
	`successor_stable_id_digest` text NOT NULL,
	`source_id` text NOT NULL,
	`successor_source_id` text NOT NULL,
	`target_repository_entity_id` text NOT NULL,
	`target_number` integer NOT NULL,
	`proof` text NOT NULL,
	`proof_digest` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `github_bulk_transfer_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`successor_external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_repository_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "github_bulk_transfer_successions_distinct_entities_check" CHECK("github_bulk_transfer_successions"."source_external_entity_id" <> "github_bulk_transfer_successions"."successor_external_entity_id"),
	CONSTRAINT "github_bulk_transfer_successions_digest_check" CHECK(length("github_bulk_transfer_successions"."source_stable_id_digest") = 64
        AND length("github_bulk_transfer_successions"."successor_stable_id_digest") = 64
        AND length("github_bulk_transfer_successions"."proof_digest") = 64),
	CONSTRAINT "github_bulk_transfer_successions_audit_check" CHECK("github_bulk_transfer_successions"."target_number" > 0
        AND length("github_bulk_transfer_successions"."actor") BETWEEN 1 AND 80
        AND length("github_bulk_transfer_successions"."reason") BETWEEN 3 AND 500
        AND length("github_bulk_transfer_successions"."idempotency_key") BETWEEN 8 AND 192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_bulk_transfer_successions_item` ON `github_bulk_transfer_successions` (`run_id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_bulk_transfer_successions_idempotency` ON `github_bulk_transfer_successions` (`run_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_github_bulk_transfer_successions_source` ON `github_bulk_transfer_successions` (`source_external_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_github_bulk_transfer_successions_successor` ON `github_bulk_transfer_successions` (`successor_external_entity_id`);