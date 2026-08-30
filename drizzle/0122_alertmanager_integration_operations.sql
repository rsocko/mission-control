CREATE TABLE `alertmanager_integration_events` (
  `id` text PRIMARY KEY NOT NULL,
  `integration` text NOT NULL,
  `kind` text NOT NULL,
  `outcome` text NOT NULL,
  `authenticated` integer DEFAULT false NOT NULL,
  `http_status` integer NOT NULL,
  `accepted` integer DEFAULT 0 NOT NULL,
  `applied` integer DEFAULT 0 NOT NULL,
  `created` integer DEFAULT 0 NOT NULL,
  `updated` integer DEFAULT 0 NOT NULL,
  `stale` integer DEFAULT 0 NOT NULL,
  `duplicate_receipts` integer DEFAULT 0 NOT NULL,
  `detail` text,
  `occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_alertmanager_integration_events_history`
  ON `alertmanager_integration_events` (`integration`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `idx_alertmanager_integration_events_outcome`
  ON `alertmanager_integration_events` (`integration`,`kind`,`outcome`,`occurred_at`);
