CREATE TABLE `task_ingest_suppressions` (
  `connector_instance_id` text NOT NULL,
  `source_id` text NOT NULL,
  `reason` text NOT NULL CHECK (`reason` = 'hard-deleted'),
  `created_at` text NOT NULL,
  PRIMARY KEY(`connector_instance_id`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_task_ingest_suppressions_source`
ON `task_ingest_suppressions` (`source_id`);
--> statement-breakpoint
DELETE FROM `task_linked_sources`
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM `task_linked_sources`
  GROUP BY `connector_instance_id`, `source_id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_linked_sources_source_identity`
ON `task_linked_sources` (`connector_instance_id`, `source_id`);
