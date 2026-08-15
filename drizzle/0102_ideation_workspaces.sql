CREATE TABLE `graph_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`schema_version` integer NOT NULL,
	`content_revision` integer NOT NULL,
	`current_document` text NOT NULL,
	`archived_at` text,
	`migration_source` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_graph_workspaces_migration_source` ON `graph_workspaces` (`migration_source`);
--> statement-breakpoint
CREATE INDEX `idx_graph_workspaces_library` ON `graph_workspaces` (`archived_at`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `graph_workspace_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`document` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `graph_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_graph_workspace_versions_revision` ON `graph_workspace_versions` (`workspace_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `idx_graph_workspace_versions_history` ON `graph_workspace_versions` (`workspace_id`,`created_at`);
