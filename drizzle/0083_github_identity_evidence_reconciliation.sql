ALTER TABLE `github_identity_comparison_runs` ADD `sub_issue_generation_complete` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `github_identity_comparison_runs` ADD `sub_issue_expected_child_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `github_identity_comparison_runs` ADD `sub_issue_expected_parent_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `github_identity_comparison_runs`
SET `sub_issue_generation_complete` = 1,
    `sub_issue_expected_child_count` = (
      SELECT COUNT(*)
      FROM `github_identity_comparison_records`
      WHERE `run_id` = `github_identity_comparison_runs`.`id`
        AND `surface` = 'sub_issue'
        AND `candidate_key` LIKE 'sub_issue:%:child'
    ),
    `sub_issue_expected_parent_count` = (
      SELECT COUNT(*)
      FROM `github_identity_comparison_records`
      WHERE `run_id` = `github_identity_comparison_runs`.`id`
        AND `surface` = 'sub_issue'
        AND `candidate_key` LIKE 'sub_issue:%:parent'
    )
WHERE `sync_kind` = 'full'
  AND `state` = 'succeeded'
  AND `evidence_eligible` = 1
  AND EXISTS (
    SELECT 1
    FROM `github_identity_comparison_records`
    WHERE `run_id` = `github_identity_comparison_runs`.`id`
      AND `surface` = 'sub_issue'
      AND `candidate_key` LIKE 'sub_issue:%:child'
  );--> statement-breakpoint
ALTER TABLE `github_identity_write_cycles` ADD `reconciliation_state` text DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE `github_identity_write_cycles` ADD `reconciliation_reason` text;--> statement-breakpoint
ALTER TABLE `github_identity_write_cycles` ADD `reconciliation_code` text;--> statement-breakpoint
ALTER TABLE `github_identity_write_cycles` ADD `reconciled_at` text;--> statement-breakpoint
ALTER TABLE `github_identity_write_cycles` ADD `reconciled_by` text;--> statement-breakpoint
ALTER TABLE `github_identity_write_cycles` ADD `reconciliation_idempotency_key` text;--> statement-breakpoint
UPDATE `github_identity_write_cycles` AS `cycle`
SET `state` = 'interrupted',
    `completed_at` = COALESCE(
      `completed_at`,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
WHERE `state` = 'running'
  AND EXISTS (
    SELECT 1
    FROM `github_identity_write_cycles` AS `newer`
    WHERE `newer`.`connector_instance_id` = `cycle`.`connector_instance_id`
      AND `newer`.`state` = 'running'
      AND (
        `newer`.`started_at` > `cycle`.`started_at`
        OR (
          `newer`.`started_at` = `cycle`.`started_at`
          AND `newer`.`id` > `cycle`.`id`
        )
      )
  );--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_identity_write_cycles_active` ON `github_identity_write_cycles` (`connector_instance_id`) WHERE "github_identity_write_cycles"."state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_identity_write_cycles_reconciliation_key` ON `github_identity_write_cycles` (`connector_instance_id`,`reconciliation_idempotency_key`) WHERE "github_identity_write_cycles"."reconciliation_idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `task_source_write_leases` ADD `write_cycle_id` text REFERENCES github_identity_write_cycles(id);--> statement-breakpoint
ALTER TABLE `task_source_write_leases` ADD `cycle_observed_at` text;--> statement-breakpoint
ALTER TABLE `task_source_write_leases` ADD `cycle_outcome` text;--> statement-breakpoint
UPDATE `task_source_write_leases`
SET `write_cycle_id` = (
  SELECT `cycle`.`id`
  FROM `github_identity_write_cycles` AS `cycle`
  WHERE `cycle`.`comparison_run_id` = `task_source_write_leases`.`comparison_run_id`
)
WHERE `comparison_run_id` IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM `github_identity_write_cycles` AS `cycle`
    WHERE `cycle`.`comparison_run_id` = `task_source_write_leases`.`comparison_run_id`
  ) = 1;--> statement-breakpoint
UPDATE `task_source_write_leases`
SET `cycle_observed_at` = `updated_at`
WHERE `write_cycle_id` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `github_identity_comparison_records` AS `record`
    WHERE `record`.`run_id` = `task_source_write_leases`.`comparison_run_id`
      AND `record`.`surface` = 'write_route'
      AND `record`.`candidate_key` LIKE '%:' || `task_source_write_leases`.`id`
  );--> statement-breakpoint
UPDATE `task_source_write_leases`
SET `cycle_outcome` = `state`
WHERE `write_cycle_id` IS NOT NULL
  AND `state` IN ('succeeded', 'failed', 'blocked', 'unknown');--> statement-breakpoint
CREATE INDEX `idx_task_source_write_leases_cycle` ON `task_source_write_leases` (`write_cycle_id`);