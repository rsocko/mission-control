CREATE TABLE `energy_checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`level` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_energy_checkins_date` ON `energy_checkins` (`date`);
