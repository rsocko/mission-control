CREATE TABLE `finance_connection_outages` (
  `connector_id` text PRIMARY KEY NOT NULL,
  `episode_id` text NOT NULL,
  `status` text NOT NULL,
  `auth_state` text NOT NULL,
  `started_at` text NOT NULL,
  `last_observed_at` text NOT NULL,
  `notification_created_at` text,
  `task_created_at` text,
  `recovery_sync_succeeded_at` text,
  `recovered_at` text,
  `last_error_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_finance_connection_outages_status`
  ON `finance_connection_outages` (`status`, `updated_at`);