CREATE TABLE `external_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`host_key` text NOT NULL,
	`entity_type` text NOT NULL,
	`stable_id` text NOT NULL,
	`identity_version` integer DEFAULT 1 NOT NULL,
	`next_locator_revision` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT "external_entities_type_check" CHECK("external_entities"."entity_type" IN ('repository', 'issue')),
	CONSTRAINT "external_entities_identity_version_check" CHECK("external_entities"."identity_version" = 1),
	CONSTRAINT "external_entities_locator_revision_check" CHECK("external_entities"."next_locator_revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_entities_identity` ON `external_entities` (`provider`,`host_key`,`entity_type`,`stable_id`);--> statement-breakpoint
CREATE TABLE `external_entity_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`external_entity_id` text NOT NULL,
	`connector_instance_id` text NOT NULL,
	`binding_type` text NOT NULL,
	`local_id` text NOT NULL,
	`state` text DEFAULT 'shadow' NOT NULL,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "external_bindings_type_check" CHECK("external_entity_bindings"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "external_bindings_state_check" CHECK("external_entity_bindings"."state" IN ('shadow', 'active', 'collision', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_bindings_local` ON `external_entity_bindings` (`connector_instance_id`,`binding_type`,`local_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_bindings_entity` ON `external_entity_bindings` (`connector_instance_id`,`external_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_external_bindings_external_entity` ON `external_entity_bindings` (`external_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_external_bindings_state` ON `external_entity_bindings` (`connector_instance_id`,`state`);--> statement-breakpoint
CREATE TABLE `external_entity_locators` (
	`id` text PRIMARY KEY NOT NULL,
	`external_entity_id` text NOT NULL,
	`repository_entity_id` text,
	`provider` text NOT NULL,
	`host_key` text NOT NULL,
	`owner` text NOT NULL,
	`repository` text NOT NULL,
	`owner_key` text NOT NULL,
	`repository_key` text NOT NULL,
	`issue_number` integer,
	`api_url` text,
	`web_url` text,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`last_seen_at` text NOT NULL,
	`observation_source` text NOT NULL,
	`locator_revision` integer NOT NULL,
	FOREIGN KEY (`external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "external_locators_source_check" CHECK("external_entity_locators"."observation_source" IN ('graphql', 'rest', 'backfill', 'operator')),
	CONSTRAINT "external_locators_revision_check" CHECK("external_entity_locators"."locator_revision" >= 1),
	CONSTRAINT "external_locators_issue_repository_check" CHECK(("external_entity_locators"."issue_number" IS NULL AND "external_entity_locators"."repository_entity_id" IS NULL)
      OR ("external_entity_locators"."issue_number" IS NOT NULL AND "external_entity_locators"."repository_entity_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_locators_revision` ON `external_entity_locators` (`external_entity_id`,`locator_revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_locators_current` ON `external_entity_locators` (`external_entity_id`) WHERE "external_entity_locators"."valid_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_locators_current_repository` ON `external_entity_locators` (`provider`,`host_key`,`owner_key`,`repository_key`) WHERE "external_entity_locators"."valid_to" IS NULL AND "external_entity_locators"."issue_number" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_locators_current_issue` ON `external_entity_locators` (`provider`,`host_key`,`owner_key`,`repository_key`,`issue_number`) WHERE "external_entity_locators"."valid_to" IS NULL AND "external_entity_locators"."issue_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_external_locators_repository_issue` ON `external_entity_locators` (`repository_entity_id`,`issue_number`,`valid_to`);--> statement-breakpoint
CREATE TABLE `github_identity_backfill_items` (
	`connector_instance_id` text NOT NULL,
	`binding_type` text NOT NULL,
	`local_id` text NOT NULL,
	`state` text NOT NULL,
	`external_entity_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`reason_code` text,
	`observed_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_instance_id`, `binding_type`, `local_id`),
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "github_backfill_items_type_check" CHECK("github_identity_backfill_items"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "github_backfill_items_state_check" CHECK("github_identity_backfill_items"."state" IN ('pending', 'bound', 'legacy_only', 'collision', 'inaccessible')),
	CONSTRAINT "github_backfill_items_attempt_check" CHECK("github_identity_backfill_items"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_github_backfill_items_state` ON `github_identity_backfill_items` (`connector_instance_id`,`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_github_backfill_items_entity` ON `github_identity_backfill_items` (`external_entity_id`);--> statement-breakpoint
CREATE TABLE `github_identity_collisions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`category` text NOT NULL,
	`fingerprint` text NOT NULL,
	`binding_type` text NOT NULL,
	`local_ids` text NOT NULL,
	`external_entity_ids` text NOT NULL,
	`legacy_identity_digest` text,
	`state` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_identity_collisions_category_check" CHECK("github_identity_collisions"."category" IN ('multiple_local_one_stable', 'one_local_multiple_stable', 'stable_legacy_disagree', 'repository_path_replacement', 'same_stable_id_different_hosts', 'locator_overlap_or_regression')),
	CONSTRAINT "github_identity_collisions_type_check" CHECK("github_identity_collisions"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "github_identity_collisions_state_check" CHECK("github_identity_collisions"."state" IN ('open', 'resolved', 'accepted_legacy_only'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_identity_collisions_fingerprint` ON `github_identity_collisions` (`connector_instance_id`,`category`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_collisions_state` ON `github_identity_collisions` (`connector_instance_id`,`state`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `github_identity_migrations` (
	`connector_instance_id` text PRIMARY KEY NOT NULL,
	`phase` text DEFAULT 'disabled' NOT NULL,
	`task_cursor` text,
	`source_list_cursor` text,
	`batch_size` integer DEFAULT 100 NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`last_error` text,
	`counters` text DEFAULT '{"eligible":0,"bound":0,"legacyOnly":0,"inaccessible":0,"pending":0,"collisions":0,"batches":0,"retries":0,"rateLimitPauses":0}' NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_identity_migrations_phase_check" CHECK("github_identity_migrations"."phase" IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'comparing', 'stable_primary', 'compatibility', 'complete', 'paused', 'rollback_legacy')),
	CONSTRAINT "github_identity_migrations_batch_size_check" CHECK("github_identity_migrations"."batch_size" BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE INDEX `idx_github_identity_migrations_phase` ON `github_identity_migrations` (`phase`,`updated_at`);
--> statement-breakpoint
ALTER TABLE `connector_configs` ADD `deleted_at` text;
--> statement-breakpoint
INSERT INTO `github_identity_migrations` (
	`connector_instance_id`,
	`phase`,
	`updated_at`
)
SELECT
	`id`,
	'disabled',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `connector_configs`
WHERE `type` = 'github-issues'
	AND `deleted_at` IS NULL
ON CONFLICT (`connector_instance_id`) DO NOTHING;