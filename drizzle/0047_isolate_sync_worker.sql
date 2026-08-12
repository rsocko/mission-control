CREATE TABLE `sync_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_id` text NOT NULL,
  `full` integer DEFAULT false NOT NULL,
  `source` text NOT NULL,
  `status` text NOT NULL,
  `attempt` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 3 NOT NULL,
  `available_at` text NOT NULL,
  `scheduled_for` text NOT NULL,
  `lease_owner` text,
  `lease_expires_at` text,
  `cancel_requested_at` text,
  `started_at` text,
  `completed_at` text,
  `result` text,
  `error` text,
  `duration_budget_ms` integer DEFAULT 300000 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sync_jobs_active_connector`
  ON `sync_jobs` (`connector_id`)
  WHERE `status` IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX `idx_sync_jobs_claim`
  ON `sync_jobs` (`status`, `available_at`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_sync_jobs_lease`
  ON `sync_jobs` (`status`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_sync_jobs_completed`
  ON `sync_jobs` (`completed_at`);
--> statement-breakpoint
CREATE TABLE `sync_job_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `job_id` text,
  `connector_id` text NOT NULL,
  `event_type` text NOT NULL,
  `payload` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`job_id`) REFERENCES `sync_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sync_job_events_cursor`
  ON `sync_job_events` (`id`);
--> statement-breakpoint
CREATE INDEX `idx_sync_job_events_job`
  ON `sync_job_events` (`job_id`, `id`);
--> statement-breakpoint
CREATE TABLE `runtime_telemetry` (
  `role` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL,
  `pid` integer NOT NULL,
  `started_at` text NOT NULL,
  `heartbeat_at` text NOT NULL,
  `metrics` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_schedules` (
  `connector_id` text PRIMARY KEY NOT NULL,
  `interval_minutes` integer NOT NULL,
  `next_due_at` text NOT NULL,
  `last_enqueued_at` text,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sync_schedules_next_due`
  ON `sync_schedules` (`next_due_at`);