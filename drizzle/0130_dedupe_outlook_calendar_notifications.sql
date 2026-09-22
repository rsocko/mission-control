CREATE TEMP TABLE `_duplicate_outlook_calendar_notification_ids` AS
WITH ranked_notifications AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY connector_instance_id, json_extract(metadata, '$.eventId')
      ORDER BY received_at DESC, id DESC
    ) AS duplicate_rank
  FROM notifications
  WHERE connector_type = 'outlook-calendar'
    AND json_valid(metadata)
    AND COALESCE(json_extract(metadata, '$.eventId'), '') <> ''
)
SELECT id
FROM ranked_notifications
WHERE duplicate_rank > 1;
--> statement-breakpoint
DELETE FROM notification_actions
WHERE notification_id IN (
  SELECT id FROM `_duplicate_outlook_calendar_notification_ids`
);
--> statement-breakpoint
DELETE FROM semantic_intents
WHERE entity_type = 'alert'
  AND entity_id IN (
    SELECT id FROM `_duplicate_outlook_calendar_notification_ids`
  );
--> statement-breakpoint
DELETE FROM semantic_vectors
WHERE entity_type = 'alert'
  AND entity_id IN (
    SELECT id FROM `_duplicate_outlook_calendar_notification_ids`
  );
--> statement-breakpoint
DELETE FROM semantic_documents
WHERE entity_type = 'alert'
  AND entity_id IN (
    SELECT id FROM `_duplicate_outlook_calendar_notification_ids`
  );
--> statement-breakpoint
DELETE FROM notifications
WHERE id IN (
  SELECT id FROM `_duplicate_outlook_calendar_notification_ids`
);
--> statement-breakpoint
DROP TABLE `_duplicate_outlook_calendar_notification_ids`;
--> statement-breakpoint
UPDATE notifications
SET source_id = connector_instance_id || ':cal:' || (json_extract(metadata, '$.eventId'))
WHERE connector_type = 'outlook-calendar'
  AND json_valid(metadata)
  AND COALESCE(json_extract(metadata, '$.eventId'), '') <> '';
