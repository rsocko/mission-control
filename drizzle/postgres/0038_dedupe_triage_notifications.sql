CREATE TEMP TABLE "_duplicate_triage_notification_ids" ON COMMIT DROP AS
WITH ranked_notifications AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY received_at DESC, id DESC) AS duplicate_rank
  FROM notifications
  WHERE connector_type = 'system'
    AND connector_instance_id = 'push-triggers'
    AND template_key = 'triage_nudge'
)
SELECT id FROM ranked_notifications WHERE duplicate_rank > 1;
--> statement-breakpoint
DELETE FROM notification_actions
WHERE notification_id IN (SELECT id FROM "_duplicate_triage_notification_ids");
--> statement-breakpoint
DELETE FROM semantic_intents
WHERE entity_type = 'alert'
  AND entity_id IN (SELECT id FROM "_duplicate_triage_notification_ids");
--> statement-breakpoint
DELETE FROM semantic_vectors
WHERE entity_type = 'alert'
  AND entity_id IN (SELECT id FROM "_duplicate_triage_notification_ids");
--> statement-breakpoint
DELETE FROM semantic_documents
WHERE entity_type = 'alert'
  AND entity_id IN (SELECT id FROM "_duplicate_triage_notification_ids");
--> statement-breakpoint
DELETE FROM notifications
WHERE id IN (SELECT id FROM "_duplicate_triage_notification_ids");
--> statement-breakpoint
UPDATE notifications
SET source_id = 'push:triage_nudge'
WHERE connector_type = 'system'
  AND connector_instance_id = 'push-triggers'
  AND template_key = 'triage_nudge';
