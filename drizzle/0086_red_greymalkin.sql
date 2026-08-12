CREATE TABLE `github_identity_sub_issue_population_members` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`local_task_id` text NOT NULL,
	`source_id_digest` text NOT NULL,
	`issue_number` integer NOT NULL,
	`member_digest` text NOT NULL,
	`observed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `github_identity_comparison_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_sub_issue_population_member_check" CHECK("github_identity_sub_issue_population_members"."issue_number" > 0
        AND length("github_identity_sub_issue_population_members"."source_id_digest") = 64
        AND length("github_identity_sub_issue_population_members"."member_digest") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_sub_issue_population_run_task` ON `github_identity_sub_issue_population_members` (`run_id`,`local_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_sub_issue_population_run_member` ON `github_identity_sub_issue_population_members` (`run_id`,`member_digest`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_github_identity_comparison_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`job_id` text,
	`owner_id` text,
	`owner_token_digest` text,
	`owner_heartbeat_at` text,
	`owner_lease_expires_at` text,
	`predecessor_run_id` text,
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
	`sub_issue_generation_complete` integer DEFAULT false NOT NULL,
	`sub_issue_expected_child_count` integer DEFAULT 0 NOT NULL,
	`sub_issue_expected_parent_count` integer DEFAULT 0 NOT NULL,
	`sub_issue_population_count` integer DEFAULT 0 NOT NULL,
	`sub_issue_population_digest` text,
	`sub_issue_observed_child_count` integer DEFAULT 0 NOT NULL,
	`sub_issue_observed_child_digest` text,
	`interruption_state` text DEFAULT 'none' NOT NULL,
	`interruption_surface` text,
	`interrupted_at` text,
	`interrupted_by_owner_id` text,
	`interruption_reason` text,
	`reconciled_at` text,
	`reconciled_by` text,
	`reconciliation_reason` text,
	`reconciliation_key` text,
	`resolved_by_run_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error_code` text,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_identity_comparison_runs_mode_check" CHECK("__new_github_identity_comparison_runs"."identity_mode" IN ('legacy', 'comparison', 'stable')),
	CONSTRAINT "github_identity_comparison_runs_kind_check" CHECK("__new_github_identity_comparison_runs"."sync_kind" IN ('full', 'incremental')),
	CONSTRAINT "github_identity_comparison_runs_state_check" CHECK("__new_github_identity_comparison_runs"."state" IN ('running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "github_identity_comparison_runs_counts_check" CHECK("__new_github_identity_comparison_runs"."identity_mode_revision" >= 0
      AND "__new_github_identity_comparison_runs"."page_count" >= 0
      AND "__new_github_identity_comparison_runs"."query_count" >= 0
      AND "__new_github_identity_comparison_runs"."sub_issue_population_count" >= 0
      AND "__new_github_identity_comparison_runs"."sub_issue_observed_child_count" >= 0),
	CONSTRAINT "github_identity_comparison_runs_owner_check" CHECK((
      "__new_github_identity_comparison_runs"."owner_id" IS NULL
      AND "__new_github_identity_comparison_runs"."owner_token_digest" IS NULL
      AND "__new_github_identity_comparison_runs"."owner_heartbeat_at" IS NULL
      AND "__new_github_identity_comparison_runs"."owner_lease_expires_at" IS NULL
    ) OR (
      "__new_github_identity_comparison_runs"."owner_id" IS NOT NULL
      AND "__new_github_identity_comparison_runs"."owner_token_digest" IS NOT NULL
      AND "__new_github_identity_comparison_runs"."owner_heartbeat_at" IS NOT NULL
      AND "__new_github_identity_comparison_runs"."owner_lease_expires_at" IS NOT NULL
    )),
	CONSTRAINT "github_identity_comparison_runs_population_check" CHECK((
      "__new_github_identity_comparison_runs"."sub_issue_population_digest" IS NULL
      AND "__new_github_identity_comparison_runs"."sub_issue_observed_child_digest" IS NULL
    ) OR (
      length("__new_github_identity_comparison_runs"."sub_issue_population_digest") = 64
      AND length("__new_github_identity_comparison_runs"."sub_issue_observed_child_digest") = 64
    )),
	CONSTRAINT "github_identity_comparison_runs_interruption_check" CHECK("__new_github_identity_comparison_runs"."interruption_state" IN ('none', 'unresolved', 'resolved', 'retired')
      AND (
        ("__new_github_identity_comparison_runs"."interruption_state" = 'none' AND "__new_github_identity_comparison_runs"."interruption_surface" IS NULL)
        OR (
          "__new_github_identity_comparison_runs"."interruption_state" != 'none'
          AND "__new_github_identity_comparison_runs"."interruption_surface" IN ('comparison', 'sub_issue')
          AND "__new_github_identity_comparison_runs"."interrupted_at" IS NOT NULL
          AND "__new_github_identity_comparison_runs"."interruption_reason" IS NOT NULL
        )
      ))
);
--> statement-breakpoint
INSERT INTO `__new_github_identity_comparison_runs`(
	"id", "connector_instance_id", "job_id", "owner_id", "owner_token_digest",
	"owner_heartbeat_at", "owner_lease_expires_at", "predecessor_run_id",
	"identity_mode", "identity_mode_revision", "sync_kind", "state", "page_count",
	"query_count", "outcome_counts", "lookup_latency_p50_ms",
	"lookup_latency_p95_ms", "lookup_latency_p99_ms", "evidence_eligible",
	"sub_issue_generation_complete", "sub_issue_expected_child_count",
	"sub_issue_expected_parent_count", "sub_issue_population_count",
	"sub_issue_population_digest", "sub_issue_observed_child_count",
	"sub_issue_observed_child_digest", "interruption_state",
	"interruption_surface", "interrupted_at", "interrupted_by_owner_id",
	"interruption_reason", "reconciled_at", "reconciled_by",
	"reconciliation_reason", "reconciliation_key", "resolved_by_run_id",
	"started_at", "completed_at", "error_code"
) SELECT
	"id", "connector_instance_id", "job_id", NULL, NULL, NULL, NULL, NULL,
	"identity_mode", "identity_mode_revision", "sync_kind",
	CASE WHEN "state" = 'running' THEN 'cancelled' ELSE "state" END,
	"page_count", "query_count", "outcome_counts", "lookup_latency_p50_ms",
	"lookup_latency_p95_ms", "lookup_latency_p99_ms",
	CASE WHEN "sync_kind" = 'full' THEN 0 ELSE "evidence_eligible" END,
	0, 0, 0, 0, NULL, 0, NULL,
	CASE
		WHEN "state" IN ('running', 'failed', 'cancelled')
			OR ("sync_kind" = 'full' AND "sub_issue_generation_complete" = 0)
		THEN 'unresolved'
		ELSE 'none'
	END,
	CASE
		WHEN "state" IN ('running', 'failed', 'cancelled')
			OR ("sync_kind" = 'full' AND "sub_issue_generation_complete" = 0)
		THEN CASE WHEN "sync_kind" = 'full' THEN 'sub_issue' ELSE 'comparison' END
		ELSE NULL
	END,
	CASE
		WHEN "state" IN ('running', 'failed', 'cancelled')
			OR ("sync_kind" = 'full' AND "sub_issue_generation_complete" = 0)
		THEN COALESCE("completed_at", "started_at")
		ELSE NULL
	END,
	NULL,
	CASE
		WHEN "state" = 'running' THEN 'migration_interrupted_running_cycle'
		WHEN "state" IN ('failed', 'cancelled') THEN 'migration_unresolved_terminal_cycle'
		WHEN "sync_kind" = 'full' AND "sub_issue_generation_complete" = 0
			THEN 'migration_incomplete_sub_issue_cycle'
		ELSE NULL
	END,
	NULL, NULL, NULL, NULL, NULL,
	"started_at",
	CASE WHEN "state" = 'running' THEN COALESCE("completed_at", "started_at") ELSE "completed_at" END,
	CASE WHEN "state" = 'running' THEN COALESCE("error_code", 'migration_interrupted') ELSE "error_code" END
FROM `github_identity_comparison_runs`;--> statement-breakpoint
DROP TABLE `github_identity_comparison_runs`;--> statement-breakpoint
ALTER TABLE `__new_github_identity_comparison_runs` RENAME TO `github_identity_comparison_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_github_identity_comparison_runs_connector` ON `github_identity_comparison_runs` (`connector_instance_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_comparison_runs_job` ON `github_identity_comparison_runs` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_github_identity_comparison_runs_interruption` ON `github_identity_comparison_runs` (`connector_instance_id`,`interruption_state`,`identity_mode_revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_identity_comparison_runs_reconciliation_key` ON `github_identity_comparison_runs` (`connector_instance_id`,`reconciliation_key`);