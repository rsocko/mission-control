DROP TRIGGER IF EXISTS task_history_task_insert;
--> statement-breakpoint
CREATE TRIGGER task_history_task_insert
AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_history_events (
    task_id,
    event_type,
    new_value,
    occurred_at,
    recorded_at,
    provenance,
    provenance_ref,
    metadata
  )
  VALUES (
    NEW.id,
    'baseline',
    json_object(
      'status', NEW.status,
      'microStatus', NEW.micro_status,
      'kanbanColumn', NEW.kanban_column,
      'effort', NEW.effort,
      'localDisposition', NEW.local_disposition,
      'projectIds', json('[]'),
      'phaseIds', json('[]')
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN NEW.connector_type IN ('local', 'mission-control')
        OR NEW.connector_instance_id IN ('local', 'mc-local') THEN 'local'
      ELSE 'connector'
    END,
    json_object(
      'connectorType', NEW.connector_type,
      'connectorInstanceId', NEW.connector_instance_id,
      'sourceId', NEW.source_id,
      'syncStatus', NEW.sync_status
    ),
    json_object(
      'historicalBoundary', true,
      'reason', 'Task entered the observed history stream'
    )
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_task_disposition_update
AFTER UPDATE OF local_disposition ON tasks
WHEN OLD.local_disposition IS NOT NEW.local_disposition
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  VALUES (
    NEW.id, 'local_disposition_changed', 'local_disposition',
    OLD.local_disposition, NEW.local_disposition,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'local',
    json_object(
      'connectorType', NEW.connector_type,
      'connectorInstanceId', NEW.connector_instance_id,
      'sourceId', NEW.source_id,
      'syncStatus', NEW.sync_status,
      'sourceUpdatedAt', NEW.updated_at
    )
  );
END;
--> statement-breakpoint
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, new_value,
  occurred_at, recorded_at, provenance, provenance_ref, metadata
)
SELECT
  task.id,
  'local_disposition_changed',
  'local_disposition',
  'active',
  task.local_disposition,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration_baseline',
  json_object(
    'connectorType', task.connector_type,
    'connectorInstanceId', task.connector_instance_id,
    'sourceId', task.source_id,
    'syncStatus', task.sync_status,
    'sourceUpdatedAt', task.updated_at
  ),
  json_object(
    'historicalBoundary', true,
    'reason', 'Current non-active disposition captured when disposition history was introduced'
  )
FROM tasks AS task
WHERE task.local_disposition <> 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM task_history_events AS history
    WHERE history.task_id = task.id
      AND history.event_type = 'local_disposition_changed'
  );
