CREATE TABLE `native_installation_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `native_installation_credentials_token_hash_unique` ON `native_installation_credentials` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `native_installation_credentials_installation_idx` ON `native_installation_credentials` (`installation_id`);
--> statement-breakpoint
CREATE TABLE `apns_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_hash` text NOT NULL,
	`environment` text NOT NULL,
	`topic` text NOT NULL,
	`app_version` text NOT NULL,
	`build_number` integer NOT NULL,
	`locale` text NOT NULL,
	`time_zone` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`invalidated_at` text,
	`invalidation_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apns_registrations_installation_target_idx` ON `apns_registrations` (`installation_id`,`environment`,`topic`);
--> statement-breakpoint
CREATE INDEX `apns_registrations_token_target_idx` ON `apns_registrations` (`token_hash`,`environment`,`topic`);
--> statement-breakpoint
CREATE INDEX `apns_registrations_active_idx` ON `apns_registrations` (`environment`,`topic`,`invalidated_at`);
--> statement-breakpoint
CREATE INDEX `apns_registrations_installation_idx` ON `apns_registrations` (`installation_id`);
--> statement-breakpoint
CREATE TABLE `native_push_requests` (
	`credential_id` text NOT NULL,
	`request_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`credential_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `native_push_requests_created_idx` ON `native_push_requests` (`created_at`);
