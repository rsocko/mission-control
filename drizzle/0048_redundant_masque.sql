CREATE TABLE `connector_operation_leases` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`operation_type` text NOT NULL,
	`owner` text NOT NULL,
	`lease_expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_connector_operation_leases_expiry` ON `connector_operation_leases` (`lease_expires_at`);