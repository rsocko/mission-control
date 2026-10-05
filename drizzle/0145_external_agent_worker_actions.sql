CREATE TABLE `agent_dispatch_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer NOT NULL,
	`available_at` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`dispatch_id`) REFERENCES `agent_dispatches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_dispatch_actions_open` ON `agent_dispatch_actions` (`dispatch_id`,`action`);
--> statement-breakpoint
CREATE INDEX `idx_agent_dispatch_actions_claim` ON `agent_dispatch_actions` (`status`,`available_at`,`priority`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_agent_dispatch_actions_lease` ON `agent_dispatch_actions` (`status`,`lease_expires_at`);
