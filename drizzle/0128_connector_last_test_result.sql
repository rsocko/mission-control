ALTER TABLE `connector_configs` ADD `last_test_status` text;
--> statement-breakpoint
ALTER TABLE `connector_configs` ADD `last_test_error` text;
--> statement-breakpoint
ALTER TABLE `connector_configs` ADD `last_test_at` text;
