DELETE FROM task_projects
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM task_projects
  GROUP BY task_id, project_id
);
--> statement-breakpoint
DELETE FROM project_phase_items
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM project_phase_items
  GROUP BY phase_id, task_id
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_projects_task_project
ON task_projects(task_id, project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_phase_items_phase_task
ON project_phase_items(phase_id, task_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS task_history_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  field_name TEXT,
  previous_value TEXT,
  new_value TEXT,
  project_id TEXT,
  phase_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  provenance TEXT NOT NULL,
  provenance_ref TEXT,
  metadata TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_history_task_time
ON task_history_events(task_id, occurred_at, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_history_type_time
ON task_history_events(event_type, occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_history_project_time
ON task_history_events(project_id, occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_history_phase_time
ON task_history_events(phase_id, occurred_at);
--> statement-breakpoint
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
SELECT
  task.id,
  'baseline',
  json_object(
    'status', task.status,
    'microStatus', task.micro_status,
    'kanbanColumn', task.kanban_column,
    'effort', task.effort,
    'projectIds', json(COALESCE((
      SELECT json_group_array(project_id)
      FROM task_projects
      WHERE task_id = task.id
    ), '[]')),
    'phaseIds', json(COALESCE((
      SELECT json_group_array(phase_id)
      FROM project_phase_items
      WHERE task_id = task.id
    ), '[]'))
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration_baseline',
  json_object(
    'connectorType', task.connector_type,
    'connectorInstanceId', task.connector_instance_id,
    'sourceId', task.source_id,
    'syncStatus', task.sync_status
  ),
  json_object(
    'historicalBoundary', true,
    'reason', 'State before this baseline was not observed by Mission Control task history'
  )
FROM tasks AS task
WHERE NOT EXISTS (
  SELECT 1
  FROM task_history_events AS history
  WHERE history.task_id = task.id
    AND history.event_type = 'baseline'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_task_insert
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
CREATE TRIGGER IF NOT EXISTS task_history_task_update
AFTER UPDATE OF status, micro_status, kanban_column, effort ON tasks
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  SELECT
    NEW.id, 'status_changed', 'status', OLD.status, NEW.status,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN NEW.connector_type IN ('local', 'mission-control')
        OR NEW.connector_instance_id IN ('local', 'mc-local')
        OR NEW.sync_status = 'pending_push' THEN 'local'
      ELSE 'connector'
    END,
    json_object(
      'connectorType', NEW.connector_type,
      'connectorInstanceId', NEW.connector_instance_id,
      'sourceId', NEW.source_id,
      'syncStatus', NEW.sync_status,
      'sourceUpdatedAt', NEW.updated_at
    )
  WHERE OLD.status IS NOT NEW.status;

  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  SELECT
    NEW.id, 'reopened', 'status', OLD.status, NEW.status,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN NEW.connector_type IN ('local', 'mission-control')
        OR NEW.connector_instance_id IN ('local', 'mc-local')
        OR NEW.sync_status = 'pending_push' THEN 'local'
      ELSE 'connector'
    END,
    json_object(
      'connectorType', NEW.connector_type,
      'connectorInstanceId', NEW.connector_instance_id,
      'sourceId', NEW.source_id,
      'syncStatus', NEW.sync_status,
      'sourceUpdatedAt', NEW.updated_at
    )
  WHERE OLD.status IN ('done', 'cancelled')
    AND NEW.status NOT IN ('done', 'cancelled');

  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  SELECT
    NEW.id, 'micro_status_changed', 'micro_status', OLD.micro_status, NEW.micro_status,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN NEW.connector_type IN ('local', 'mission-control')
        OR NEW.connector_instance_id IN ('local', 'mc-local')
        OR NEW.sync_status = 'pending_push' THEN 'local'
      ELSE 'connector'
    END,
    json_object(
      'connectorType', NEW.connector_type,
      'connectorInstanceId', NEW.connector_instance_id,
      'sourceId', NEW.source_id,
      'syncStatus', NEW.sync_status,
      'sourceUpdatedAt', NEW.updated_at
    )
  WHERE OLD.micro_status IS NOT NEW.micro_status;

  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  SELECT
    NEW.id, 'kanban_column_changed', 'kanban_column', OLD.kanban_column, NEW.kanban_column,
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
  WHERE OLD.kanban_column IS NOT NEW.kanban_column;

  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  SELECT
    NEW.id, 'effort_changed', 'effort', CAST(OLD.effort AS TEXT), CAST(NEW.effort AS TEXT),
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
  WHERE OLD.effort IS NOT NEW.effort;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_project_insert
AFTER INSERT ON task_projects
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, new_value, project_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  VALUES (
    NEW.task_id, 'project_added', 'project_id', NEW.project_id, NEW.project_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN (SELECT connector_instance_id FROM tasks WHERE id = NEW.task_id) = 'local' THEN 'local'
      WHEN (SELECT connector_type FROM tasks WHERE id = NEW.task_id) IN ('local', 'mission-control') THEN 'local'
      ELSE 'system'
    END,
    json_object(
      'connectorType', (SELECT connector_type FROM tasks WHERE id = NEW.task_id),
      'connectorInstanceId', (SELECT connector_instance_id FROM tasks WHERE id = NEW.task_id),
      'sourceId', (SELECT source_id FROM tasks WHERE id = NEW.task_id),
      'syncStatus', (SELECT sync_status FROM tasks WHERE id = NEW.task_id)
    )
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_project_delete
AFTER DELETE ON task_projects
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, project_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  VALUES (
    OLD.task_id, 'project_removed', 'project_id', OLD.project_id, OLD.project_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN (SELECT connector_instance_id FROM tasks WHERE id = OLD.task_id) = 'local' THEN 'local'
      WHEN (SELECT connector_type FROM tasks WHERE id = OLD.task_id) IN ('local', 'mission-control') THEN 'local'
      ELSE 'system'
    END,
    json_object(
      'connectorType', (SELECT connector_type FROM tasks WHERE id = OLD.task_id),
      'connectorInstanceId', (SELECT connector_instance_id FROM tasks WHERE id = OLD.task_id),
      'sourceId', (SELECT source_id FROM tasks WHERE id = OLD.task_id),
      'syncStatus', (SELECT sync_status FROM tasks WHERE id = OLD.task_id)
    )
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_project_update
AFTER UPDATE OF task_id, project_id ON task_projects
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.project_id IS NOT NEW.project_id
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, project_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  SELECT
    OLD.task_id, 'project_removed', 'project_id', OLD.project_id, OLD.project_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'system',
    json_object('reason', 'membership row reassigned');

  INSERT INTO task_history_events (
    task_id, event_type, field_name, new_value, project_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  SELECT
    NEW.task_id, 'project_added', 'project_id', NEW.project_id, NEW.project_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'system',
    json_object('reason', 'membership row reassigned');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_phase_insert
AFTER INSERT ON project_phase_items
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, new_value, phase_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  VALUES (
    NEW.task_id, 'phase_added', 'phase_id', NEW.phase_id, NEW.phase_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN (SELECT connector_instance_id FROM tasks WHERE id = NEW.task_id) = 'local' THEN 'local'
      WHEN (SELECT connector_type FROM tasks WHERE id = NEW.task_id) IN ('local', 'mission-control') THEN 'local'
      ELSE 'system'
    END,
    json_object(
      'connectorType', (SELECT connector_type FROM tasks WHERE id = NEW.task_id),
      'connectorInstanceId', (SELECT connector_instance_id FROM tasks WHERE id = NEW.task_id),
      'sourceId', (SELECT source_id FROM tasks WHERE id = NEW.task_id),
      'syncStatus', (SELECT sync_status FROM tasks WHERE id = NEW.task_id)
    )
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_phase_delete
AFTER DELETE ON project_phase_items
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, phase_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  VALUES (
    OLD.task_id, 'phase_removed', 'phase_id', OLD.phase_id, OLD.phase_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE
      WHEN (SELECT connector_instance_id FROM tasks WHERE id = OLD.task_id) = 'local' THEN 'local'
      WHEN (SELECT connector_type FROM tasks WHERE id = OLD.task_id) IN ('local', 'mission-control') THEN 'local'
      ELSE 'system'
    END,
    json_object(
      'connectorType', (SELECT connector_type FROM tasks WHERE id = OLD.task_id),
      'connectorInstanceId', (SELECT connector_instance_id FROM tasks WHERE id = OLD.task_id),
      'sourceId', (SELECT source_id FROM tasks WHERE id = OLD.task_id),
      'syncStatus', (SELECT sync_status FROM tasks WHERE id = OLD.task_id)
    )
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_phase_update
AFTER UPDATE OF task_id, phase_id ON project_phase_items
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.phase_id IS NOT NEW.phase_id
BEGIN
  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, phase_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  VALUES (
    OLD.task_id, 'phase_removed', 'phase_id', OLD.phase_id, OLD.phase_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'system',
    json_object('reason', 'membership row reassigned')
  );

  INSERT INTO task_history_events (
    task_id, event_type, field_name, new_value, phase_id,
    occurred_at, recorded_at, provenance, provenance_ref
  )
  VALUES (
    NEW.task_id, 'phase_added', 'phase_id', NEW.phase_id, NEW.phase_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'system',
    json_object('reason', 'membership row reassigned')
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_immutable_update
BEFORE UPDATE ON task_history_events
BEGIN
  SELECT RAISE(ABORT, 'task_history_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS task_history_immutable_delete
BEFORE DELETE ON task_history_events
BEGIN
  SELECT RAISE(ABORT, 'task_history_events is append-only');
END;
