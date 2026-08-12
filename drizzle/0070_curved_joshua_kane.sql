ALTER TABLE `github_identity_exception_events`
  ADD `comparison_run_id` text
  REFERENCES `github_identity_comparison_runs`(`id`) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `github_identity_exception_events`
  ADD `proof_type` text
  CHECK (
    (`proof_type` IS NULL OR `proof_type` IN ('stage1_inaccessible', 'post_backfill_authoritative_deletion'))
    AND (
      (
        `action` = 'revoke'
        AND `proof_type` IS NULL
        AND `comparison_run_id` IS NULL
      ) OR (
        `action` = 'accept'
        AND (
          (
            (`proof_type` IS NULL OR `proof_type` = 'stage1_inaccessible')
            AND `comparison_run_id` IS NULL
          ) OR (
            `proof_type` = 'post_backfill_authoritative_deletion'
            AND `comparison_run_id` IS NOT NULL
          )
        )
      )
    )
  );
