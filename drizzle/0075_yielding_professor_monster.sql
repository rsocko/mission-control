ALTER TABLE `dependency_reconciliation_edges` ADD `blocker_identity_evidence` text;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_edges` ADD `blocker_identity_evidence_state` text DEFAULT 'missing' NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_items` ADD `identity_evidence` text;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_items` ADD `identity_evidence_state` text DEFAULT 'missing' NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `identity_mode` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `identity_mode_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `identity_evidence_source` text DEFAULT 'legacy-unavailable' NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `identity_evidence_eligible` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `identity_comparison_run_id` text;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `identity_evidence_failure_reason` text;
