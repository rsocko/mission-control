UPDATE notifications
SET metadata = json_extract(metadata, '$')
WHERE connector_type = 'inbound-webhook'
  AND json_valid(metadata)
  AND json_type(metadata) = 'text'
  AND json_valid(json_extract(metadata, '$'))
  AND json_type(json_extract(metadata, '$')) = 'object';--> statement-breakpoint
UPDATE notification_actions
SET payload = json_extract(payload, '$')
WHERE action_type = 'open_url'
  AND notification_id IN (
    SELECT id FROM notifications WHERE connector_type = 'inbound-webhook'
  )
  AND json_valid(payload)
  AND json_type(payload) = 'text'
  AND json_valid(json_extract(payload, '$'))
  AND json_type(json_extract(payload, '$')) = 'object';
