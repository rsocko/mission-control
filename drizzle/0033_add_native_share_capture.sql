CREATE TABLE `native_share_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `native_share_credentials_token_hash_unique` ON `native_share_credentials` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `native_share_credentials_installation_idx` ON `native_share_credentials` (`installation_id`);
--> statement-breakpoint
CREATE TABLE `native_share_capture_requests` (
	`credential_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`reservation_id` text NOT NULL,
	`item_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`credential_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `native_share_capture_requests_created_idx` ON `native_share_capture_requests` (`created_at`);
