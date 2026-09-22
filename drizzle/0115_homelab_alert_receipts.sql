CREATE TABLE `homelab_alert_receipts` (
  `id` text PRIMARY KEY NOT NULL,
  `integration` text NOT NULL,
  `source` text NOT NULL,
  `event_id` text NOT NULL,
  `fingerprint` text NOT NULL,
  `status` text NOT NULL,
  `occurred_at` text NOT NULL,
  `notification_id` text NOT NULL,
  `first_received_at` text NOT NULL,
  `last_received_at` text NOT NULL,
  `delivery_count` integer DEFAULT 1 NOT NULL,
  `applied` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_homelab_alert_receipts_event`
  ON `homelab_alert_receipts` (`integration`,`source`,`event_id`);
--> statement-breakpoint
CREATE INDEX `idx_homelab_alert_receipts_incident`
  ON `homelab_alert_receipts` (`integration`,`source`,`fingerprint`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `idx_homelab_alert_receipts_received`
  ON `homelab_alert_receipts` (`last_received_at`);
