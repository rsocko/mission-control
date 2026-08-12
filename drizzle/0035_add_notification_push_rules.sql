CREATE TABLE `notification_push_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`template_key` text NOT NULL,
	`enabled` integer NOT NULL,
	`min_level` text NOT NULL,
	`preview` text NOT NULL,
	`max_per_hour` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notification_push_rules_connector` ON `notification_push_rules` (`connector_instance_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_push_rules_connector_template` ON `notification_push_rules` (`connector_instance_id`,`template_key`);
