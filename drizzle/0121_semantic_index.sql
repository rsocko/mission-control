CREATE TABLE `semantic_index_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`projection_version` integer NOT NULL,
	`status` text NOT NULL,
	`document_count` integer DEFAULT 0 NOT NULL,
	`vector_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ready_at` text,
	`activated_at` text,
	`retired_at` text,
	`failure_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_semantic_identities_active` ON `semantic_index_identities` (`status`) WHERE `semantic_index_identities`.`status` = 'active';--> statement-breakpoint
CREATE INDEX `idx_semantic_identities_lifecycle` ON `semantic_index_identities` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_identities_space` ON `semantic_index_identities` (`provider`,`model`,`dimensions`,`projection_version`);--> statement-breakpoint
CREATE TABLE `semantic_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`index_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`source_revision` text NOT NULL,
	`content_fingerprint` text NOT NULL,
	`projection_version` integer NOT NULL,
	`sensitivity` text NOT NULL,
	`retain_until` text,
	`source_updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`index_id`) REFERENCES `semantic_index_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_semantic_documents_entity` ON `semantic_documents` (`index_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_semantic_documents_kind` ON `semantic_documents` (`index_id`,`entity_type`,`source_updated_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_documents_retention` ON `semantic_documents` (`retain_until`);--> statement-breakpoint
CREATE INDEX `idx_semantic_documents_deleted` ON `semantic_documents` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `semantic_vectors` (
	`id` text PRIMARY KEY NOT NULL,
	`index_id` text NOT NULL,
	`document_id` text NOT NULL,
	`document_version` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`content_fingerprint` text NOT NULL,
	`projection_version` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`sensitivity` text NOT NULL,
	`embedding` text NOT NULL,
	`norm` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`embedded_at` text NOT NULL,
	`index_run_id` text,
	`intent_id` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`index_id`) REFERENCES `semantic_index_identities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `semantic_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_semantic_vectors_entity` ON `semantic_vectors` (`index_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_semantic_vectors_scan` ON `semantic_vectors` (`index_id`,`entity_type`,`source_updated_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_vectors_document` ON `semantic_vectors` (`document_id`,`document_version`);--> statement-breakpoint
CREATE INDEX `idx_semantic_vectors_expiry` ON `semantic_vectors` (`index_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_vectors_job` ON `semantic_vectors` (`index_run_id`);--> statement-breakpoint
CREATE TABLE `semantic_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`index_id` text NOT NULL,
	`kind` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`source_revision` text,
	`content_fingerprint` text,
	`projection_version` integer,
	`requested_at` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`available_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`retry_after` text,
	`last_error` text,
	`outcome` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`index_id`) REFERENCES `semantic_index_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_semantic_intents_pending` ON `semantic_intents` (`idempotency_key`) WHERE `semantic_intents`.`status` = 'queued';--> statement-breakpoint
CREATE INDEX `idx_semantic_intents_claim` ON `semantic_intents` (`index_id`,`status`,`available_at`,`requested_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_intents_lease` ON `semantic_intents` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_intents_entity` ON `semantic_intents` (`index_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_semantic_intents_history` ON `semantic_intents` (`status`,`completed_at`);--> statement-breakpoint
CREATE TABLE `semantic_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`index_id` text NOT NULL,
	`kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`checkpoint` text,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`available_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`index_id`) REFERENCES `semantic_index_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_semantic_runs_idempotency` ON `semantic_runs` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_semantic_runs_active` ON `semantic_runs` (`index_id`,`kind`) WHERE `semantic_runs`.`status` = 'running';--> statement-breakpoint
CREATE INDEX `idx_semantic_runs_claim` ON `semantic_runs` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_runs_lease` ON `semantic_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_semantic_runs_history` ON `semantic_runs` (`index_id`,`created_at`);
