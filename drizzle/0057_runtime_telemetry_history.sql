CREATE TABLE `runtime_telemetry_samples` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `role` text NOT NULL,
  `instance_id` text NOT NULL,
  `pid` integer NOT NULL,
  `sampled_at` text NOT NULL,
  `metrics` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_telemetry_samples_time`
  ON `runtime_telemetry_samples` (`sampled_at`);
--> statement-breakpoint
CREATE INDEX `idx_runtime_telemetry_samples_role_time`
  ON `runtime_telemetry_samples` (`role`, `sampled_at`);
--> statement-breakpoint
CREATE INDEX `idx_runtime_telemetry_samples_role_id`
  ON `runtime_telemetry_samples` (`role`, `id`);
