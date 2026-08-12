CREATE TABLE `task_linked_source_entities` (
	`linked_source_id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`external_entity_id` text NOT NULL,
	`verified_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`linked_source_id`) REFERENCES `task_linked_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_linked_source_entities_connector_entity` ON `task_linked_source_entities` (`connector_instance_id`,`external_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_task_linked_source_entities_entity` ON `task_linked_source_entities` (`external_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_task_linked_source_entities_connector` ON `task_linked_source_entities` (`connector_instance_id`,`linked_source_id`);