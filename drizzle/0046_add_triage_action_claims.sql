CREATE TABLE `triage_action_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `triage_item_id` text NOT NULL,
  `action_type` text NOT NULL,
  `state` text DEFAULT 'pending' NOT NULL,
  `claimed_at` text NOT NULL,
  `completed_at` text,
  `result` text,
  FOREIGN KEY (`triage_item_id`) REFERENCES `triage_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_triage_action_claims_item_action`
ON `triage_action_claims` (`triage_item_id`, `action_type`);
