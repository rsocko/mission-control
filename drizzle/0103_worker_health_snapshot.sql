CREATE TABLE `worker_health_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`generated_at` text NOT NULL,
	`worker_instance_id` text NOT NULL,
	`worker_revision` text NOT NULL,
	`generation_duration_ms` integer NOT NULL,
	`payload` text NOT NULL
);
