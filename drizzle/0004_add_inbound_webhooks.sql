-- Add inbound_webhooks and inbound_webhook_log tables for external system push support
CREATE TABLE IF NOT EXISTS `inbound_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_label` text NOT NULL DEFAULT 'webhook',
	`secret` text,
	`enabled` integer NOT NULL DEFAULT true,
	`default_action` text NOT NULL DEFAULT 'auto',
	`field_mappings` text NOT NULL DEFAULT '{}',
	`total_received` integer NOT NULL DEFAULT 0,
	`last_received_at` text,
	`last_status` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inbound_webhook_log` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`status` text NOT NULL,
	`http_status` integer NOT NULL,
	`created_type` text,
	`created_id` text,
	`error_message` text,
	`payload_preview` text,
	`received_at` text NOT NULL
);
