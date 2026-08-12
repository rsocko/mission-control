CREATE TABLE `github_identity_comparison_records` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`job_id` text,
	`surface` text NOT NULL,
	`candidate_key` text NOT NULL,
	`local_task_id` text,
	`local_source_list_id` text,
	`external_entity_id` text,
	`legacy_selected_local_id` text,
	`stable_selected_local_id` text,
	`legacy_action` text NOT NULL,
	`stable_action` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`stable_id_digest` text,
	`locator_revision` integer,
	`legacy_lookup_ms` integer DEFAULT 0 NOT NULL,
	`stable_lookup_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `github_identity_comparison_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "github_identity_comparison_records_surface_check" CHECK("github_identity_comparison_records"."surface" IN ('source_list', 'task', 'project_association', 'dependency', 'sub_issue', 'linked_source', 'deletion', 'write_route')),
	CONSTRAINT "github_identity_comparison_records_action_check" CHECK("github_identity_comparison_records"."legacy_action" IN ('create', 'update', 'present', 'delete_candidate', 'none')
      AND "github_identity_comparison_records"."stable_action" IN ('create', 'update', 'present', 'delete_candidate', 'none')),
	CONSTRAINT "github_identity_comparison_records_outcome_check" CHECK("github_identity_comparison_records"."outcome" IN ('agreement', 'legacy_fallback', 'missing_stable_id', 'collision', 'stable_legacy_disagree', 'locator_change', 'path_reuse', 'inaccessible', 'partial_fetch')),
	CONSTRAINT "github_identity_comparison_records_reason_check" CHECK("github_identity_comparison_records"."reason" IN ('exact_match', 'legacy_only', 'missing_stable_evidence', 'multiple_legacy_candidates', 'multiple_stable_bindings', 'selected_ids_differ', 'current_locator_changed', 'locator_owned_by_other_entity', 'access_denied', 'fetch_incomplete')),
	CONSTRAINT "github_identity_comparison_records_metrics_check" CHECK(("github_identity_comparison_records"."locator_revision" IS NULL OR "github_identity_comparison_records"."locator_revision" >= 1)
      AND "github_identity_comparison_records"."legacy_lookup_ms" >= 0 AND "github_identity_comparison_records"."stable_lookup_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_identity_comparison_records_candidate` ON `github_identity_comparison_records` (`run_id`,`surface`,`candidate_key`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_comparison_records_outcome` ON `github_identity_comparison_records` (`run_id`,`outcome`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_comparison_records_entity` ON `github_identity_comparison_records` (`external_entity_id`);--> statement-breakpoint
CREATE TABLE `github_identity_comparison_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`job_id` text,
	`identity_mode` text NOT NULL,
	`identity_mode_revision` integer NOT NULL,
	`sync_kind` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`query_count` integer DEFAULT 0 NOT NULL,
	`outcome_counts` text DEFAULT '{}' NOT NULL,
	`lookup_latency_p50_ms` integer,
	`lookup_latency_p95_ms` integer,
	`lookup_latency_p99_ms` integer,
	`evidence_eligible` integer DEFAULT false NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error_code` text,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_identity_comparison_runs_mode_check" CHECK("github_identity_comparison_runs"."identity_mode" IN ('legacy', 'comparison', 'stable')),
	CONSTRAINT "github_identity_comparison_runs_kind_check" CHECK("github_identity_comparison_runs"."sync_kind" IN ('full', 'incremental')),
	CONSTRAINT "github_identity_comparison_runs_state_check" CHECK("github_identity_comparison_runs"."state" IN ('running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "github_identity_comparison_runs_counts_check" CHECK("github_identity_comparison_runs"."identity_mode_revision" >= 0 AND "github_identity_comparison_runs"."page_count" >= 0 AND "github_identity_comparison_runs"."query_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_github_identity_comparison_runs_connector` ON `github_identity_comparison_runs` (`connector_instance_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_comparison_runs_job` ON `github_identity_comparison_runs` (`job_id`);--> statement-breakpoint
CREATE TABLE `github_identity_controls` (
	`connector_instance_id` text PRIMARY KEY NOT NULL,
	`stable_primary_enabled` integer DEFAULT false NOT NULL,
	`mode_revision` integer DEFAULT 1 NOT NULL,
	`last_mode_event_id` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_identity_controls_revision_check" CHECK("github_identity_controls"."mode_revision" >= 1),
	CONSTRAINT "github_identity_controls_stable_flag_check" CHECK("github_identity_controls"."stable_primary_enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `github_identity_mode_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connector_instance_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`old_phase` text NOT NULL,
	`new_phase` text NOT NULL,
	`old_effective_mode` text NOT NULL,
	`new_effective_mode` text NOT NULL,
	`old_stable_primary_enabled` integer NOT NULL,
	`new_stable_primary_enabled` integer NOT NULL,
	`old_mode_revision` integer NOT NULL,
	`new_mode_revision` integer NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`gate_result_code` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_identity_mode_events_old_phase_check" CHECK("github_identity_mode_events"."old_phase" IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'comparing', 'stable_primary', 'compatibility', 'complete', 'paused', 'rollback_legacy')),
	CONSTRAINT "github_identity_mode_events_new_phase_check" CHECK("github_identity_mode_events"."new_phase" IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'comparing', 'stable_primary', 'compatibility', 'complete', 'paused', 'rollback_legacy')),
	CONSTRAINT "github_identity_mode_events_old_mode_check" CHECK("github_identity_mode_events"."old_effective_mode" IN ('legacy', 'comparison', 'stable')),
	CONSTRAINT "github_identity_mode_events_new_mode_check" CHECK("github_identity_mode_events"."new_effective_mode" IN ('legacy', 'comparison', 'stable')),
	CONSTRAINT "github_identity_mode_events_revision_check" CHECK("github_identity_mode_events"."old_mode_revision" >= 0 AND "github_identity_mode_events"."new_mode_revision" = "github_identity_mode_events"."old_mode_revision" + 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_identity_mode_events_idempotency` ON `github_identity_mode_events` (`connector_instance_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_mode_events_connector` ON `github_identity_mode_events` (`connector_instance_id`,`id`);--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `identity_mode` text;--> statement-breakpoint
ALTER TABLE `sync_jobs` ADD `identity_mode_revision` integer;--> statement-breakpoint
ALTER TABLE `sync_log` ADD `identity_mode` text;--> statement-breakpoint
ALTER TABLE `sync_log` ADD `identity_mode_revision` integer;