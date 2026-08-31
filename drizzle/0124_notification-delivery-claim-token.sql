ALTER TABLE `notification_delivery_events` ADD `claim_token` text;
--> statement-breakpoint
UPDATE `notification_delivery_events`
SET `claim_token` = NULL
WHERE `status` IN ('pending', 'sending');