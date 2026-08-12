CREATE TABLE `runtime_telemetry_instances` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`pid` integer NOT NULL,
	`started_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`stopped_at` text,
	`terminal_reason` text,
	`restart_count` integer,
	`build_sha` text,
	`runtime_mode` text NOT NULL,
	`high_water_metrics` text NOT NULL,
	`terminal_metrics` text
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_instances_role_started` ON `runtime_telemetry_instances` (`role`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_instances_last_seen` ON `runtime_telemetry_instances` (`last_seen_at`);--> statement-breakpoint
ALTER TABLE `runtime_telemetry_samples` ADD `resolution_seconds` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runtime_samples_instance_time_resolution` ON `runtime_telemetry_samples` (`instance_id`,`sampled_at`,`resolution_seconds`);--> statement-breakpoint
CREATE INDEX `idx_runtime_samples_role_time` ON `runtime_telemetry_samples` (`role`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_samples_time` ON `runtime_telemetry_samples` (`sampled_at`);
