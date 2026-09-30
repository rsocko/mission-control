-- Restore PostgreSQL parity with the SQLite task-history triggers introduced
-- by drizzle/0031_add_task_history.sql and drizzle/0116_track_task_disposition_history.sql.
-- Every task writer flows through these tables, so database triggers preserve
-- history for connectors, webhooks, reconciliation, imports, and local edits.
CREATE OR REPLACE FUNCTION task_history_safe_json(value text)
RETURNS jsonb AS $$
BEGIN
  IF value IS NULL OR value = '' THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN value::jsonb;
EXCEPTION WHEN others THEN
  RETURN '{}'::jsonb;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_history_now()
RETURNS text AS $$
  SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$ LANGUAGE sql VOLATILE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_history_task_insert()
RETURNS trigger AS $$
DECLARE
  observed_at text := task_history_now();
BEGIN
  IF current_setting('mission_control.suppress_task_history', true) = 'on' THEN
    RETURN NEW;
  END IF;
  INSERT INTO task_history_events (
    task_id, event_type, new_value, occurred_at, recorded_at,
    provenance, provenance_ref, metadata
  ) VALUES (
    NEW.id,
    'baseline',
    jsonb_build_object(
      'status', NEW.status,
      'microStatus', NEW.micro_status,
      'kanbanColumn', NEW.kanban_column,
      'effort', NEW.effort,
      'localDisposition', NEW.local_disposition,
      'projectIds', '[]'::jsonb,
      'phaseIds', '[]'::jsonb
    )::text,
    observed_at,
    observed_at,
    CASE
      WHEN NEW.connector_type IN ('local', 'mission-control')
        OR NEW.connector_instance_id IN ('local', 'mc-local') THEN 'local'
      ELSE 'connector'
    END,
    jsonb_build_object(
      'connectorType', NEW.connector_type,
      'connectorInstanceId', NEW.connector_instance_id,
      'sourceId', NEW.source_id,
      'syncStatus', NEW.sync_status
    ),
    jsonb_build_object(
      'historicalBoundary', true,
      'reason', 'Task entered the observed history stream'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_history_task_update()
RETURNS trigger AS $$
DECLARE
  observed_at text := task_history_now();
  event_provenance text := CASE
    WHEN NEW.connector_type IN ('local', 'mission-control')
      OR NEW.connector_instance_id IN ('local', 'mc-local')
      OR NEW.sync_status = 'pending_push' THEN 'local'
    ELSE 'connector'
  END;
  event_ref jsonb := jsonb_build_object(
    'connectorType', NEW.connector_type,
    'connectorInstanceId', NEW.connector_instance_id,
    'sourceId', NEW.source_id,
    'syncStatus', NEW.sync_status,
    'sourceUpdatedAt', NEW.updated_at
  );
  status_occurred_at text;
  latest_status_at text;
BEGIN
  IF current_setting('mission_control.suppress_task_history', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT MAX(occurred_at) INTO latest_status_at
    FROM task_history_events
    WHERE task_id = NEW.id
      AND event_type IN ('baseline', 'status_changed');
    status_occurred_at := CASE
      WHEN NEW.status IN ('done', 'cancelled')
        AND NEW.completed_at IS NOT NULL
        AND NEW.completed_at <> ''
        AND NEW.completed_at > COALESCE(latest_status_at, '') THEN NEW.completed_at
      ELSE observed_at
    END;
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, new_value,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      NEW.id, 'status_changed', 'status', OLD.status, NEW.status,
      status_occurred_at, observed_at, event_provenance, event_ref
    );
    IF OLD.status IN ('done', 'cancelled')
      AND NEW.status NOT IN ('done', 'cancelled') THEN
      INSERT INTO task_history_events (
        task_id, event_type, field_name, previous_value, new_value,
        occurred_at, recorded_at, provenance, provenance_ref
      ) VALUES (
        NEW.id, 'reopened', 'status', OLD.status, NEW.status,
        observed_at, observed_at, event_provenance, event_ref
      );
    END IF;
  END IF;

  IF OLD.micro_status IS DISTINCT FROM NEW.micro_status THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, new_value,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      NEW.id, 'micro_status_changed', 'micro_status', OLD.micro_status, NEW.micro_status,
      observed_at, observed_at, event_provenance, event_ref
    );
  END IF;

  IF OLD.kanban_column IS DISTINCT FROM NEW.kanban_column THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, new_value,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      NEW.id, 'kanban_column_changed', 'kanban_column',
      OLD.kanban_column, NEW.kanban_column,
      observed_at, observed_at, 'local', event_ref
    );
  END IF;

  IF OLD.effort IS DISTINCT FROM NEW.effort THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, new_value,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      NEW.id, 'effort_changed', 'effort', OLD.effort::text, NEW.effort::text,
      observed_at, observed_at, 'local', event_ref
    );
  END IF;

  IF OLD.local_disposition IS DISTINCT FROM NEW.local_disposition THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, new_value,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      NEW.id, 'local_disposition_changed', 'local_disposition',
      OLD.local_disposition, NEW.local_disposition,
      observed_at, observed_at, 'local', event_ref
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_history_project_membership()
RETURNS trigger AS $$
DECLARE
  observed_at text := task_history_now();
  old_ref jsonb;
  new_ref jsonb;
  old_provenance text := 'system';
  new_provenance text := 'system';
BEGIN
  IF current_setting('mission_control.suppress_task_history', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT
      jsonb_build_object(
        'connectorType', connector_type,
        'connectorInstanceId', connector_instance_id,
        'sourceId', source_id,
        'syncStatus', sync_status
      ),
      CASE
        WHEN connector_type IN ('local', 'mission-control')
          OR connector_instance_id IN ('local', 'mc-local') THEN 'local'
        ELSE 'system'
      END
    INTO old_ref, old_provenance
    FROM tasks WHERE id = OLD.task_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT
      jsonb_build_object(
        'connectorType', connector_type,
        'connectorInstanceId', connector_instance_id,
        'sourceId', source_id,
        'syncStatus', sync_status
      ),
      CASE
        WHEN connector_type IN ('local', 'mission-control')
          OR connector_instance_id IN ('local', 'mc-local') THEN 'local'
        ELSE 'system'
      END
    INTO new_ref, new_provenance
    FROM tasks WHERE id = NEW.task_id;
  END IF;

  IF TG_OP = 'DELETE' OR (
    TG_OP = 'UPDATE'
    AND (OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.project_id IS DISTINCT FROM NEW.project_id)
  ) THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, project_id,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      OLD.task_id, 'project_removed', 'project_id', OLD.project_id, OLD.project_id,
      observed_at, observed_at, old_provenance,
      COALESCE(old_ref, jsonb_build_object('reason', 'membership row reassigned'))
    );
  END IF;

  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE'
    AND (OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.project_id IS DISTINCT FROM NEW.project_id)
  ) THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, new_value, project_id,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      NEW.task_id, 'project_added', 'project_id', NEW.project_id, NEW.project_id,
      observed_at, observed_at, new_provenance,
      COALESCE(new_ref, jsonb_build_object('reason', 'membership row reassigned'))
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_history_phase_membership()
RETURNS trigger AS $$
DECLARE
  observed_at text := task_history_now();
  old_ref jsonb;
  new_ref jsonb;
  old_provenance text := 'system';
  new_provenance text := 'system';
BEGIN
  IF current_setting('mission_control.suppress_task_history', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT
      jsonb_build_object(
        'connectorType', connector_type,
        'connectorInstanceId', connector_instance_id,
        'sourceId', source_id,
        'syncStatus', sync_status
      ),
      CASE
        WHEN connector_type IN ('local', 'mission-control')
          OR connector_instance_id IN ('local', 'mc-local') THEN 'local'
        ELSE 'system'
      END
    INTO old_ref, old_provenance
    FROM tasks WHERE id = OLD.task_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT
      jsonb_build_object(
        'connectorType', connector_type,
        'connectorInstanceId', connector_instance_id,
        'sourceId', source_id,
        'syncStatus', sync_status
      ),
      CASE
        WHEN connector_type IN ('local', 'mission-control')
          OR connector_instance_id IN ('local', 'mc-local') THEN 'local'
        ELSE 'system'
      END
    INTO new_ref, new_provenance
    FROM tasks WHERE id = NEW.task_id;
  END IF;

  IF TG_OP = 'DELETE' OR (
    TG_OP = 'UPDATE'
    AND (OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.phase_id IS DISTINCT FROM NEW.phase_id)
  ) THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, phase_id,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      OLD.task_id, 'phase_removed', 'phase_id', OLD.phase_id, OLD.phase_id,
      observed_at, observed_at, old_provenance,
      COALESCE(old_ref, jsonb_build_object('reason', 'membership row reassigned'))
    );
  END IF;

  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE'
    AND (OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.phase_id IS DISTINCT FROM NEW.phase_id)
  ) THEN
    INSERT INTO task_history_events (
      task_id, event_type, field_name, new_value, phase_id,
      occurred_at, recorded_at, provenance, provenance_ref
    ) VALUES (
      NEW.task_id, 'phase_added', 'phase_id', NEW.phase_id, NEW.phase_id,
      observed_at, observed_at, new_provenance,
      COALESCE(new_ref, jsonb_build_object('reason', 'membership row reassigned'))
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_task_insert ON tasks;
--> statement-breakpoint
CREATE TRIGGER task_history_task_insert
AFTER INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION task_history_task_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_task_update ON tasks;
--> statement-breakpoint
CREATE TRIGGER task_history_task_update
AFTER UPDATE OF status, micro_status, kanban_column, effort, local_disposition ON tasks
FOR EACH ROW EXECUTE FUNCTION task_history_task_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_project_insert ON task_projects;
--> statement-breakpoint
CREATE TRIGGER task_history_project_insert
AFTER INSERT ON task_projects
FOR EACH ROW EXECUTE FUNCTION task_history_project_membership();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_project_update ON task_projects;
--> statement-breakpoint
CREATE TRIGGER task_history_project_update
AFTER UPDATE OF task_id, project_id ON task_projects
FOR EACH ROW EXECUTE FUNCTION task_history_project_membership();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_project_delete ON task_projects;
--> statement-breakpoint
CREATE TRIGGER task_history_project_delete
AFTER DELETE ON task_projects
FOR EACH ROW EXECUTE FUNCTION task_history_project_membership();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_phase_insert ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER task_history_phase_insert
AFTER INSERT ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION task_history_phase_membership();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_phase_update ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER task_history_phase_update
AFTER UPDATE OF task_id, phase_id ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION task_history_phase_membership();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_phase_delete ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER task_history_phase_delete
AFTER DELETE ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION task_history_phase_membership();
--> statement-breakpoint
-- Add a baseline for tasks created after the PostgreSQL cutover. The burn
-- report can reconstruct their creation and completion dates from task rows.
INSERT INTO task_history_events (
  task_id, event_type, new_value, occurred_at, recorded_at,
  provenance, provenance_ref, metadata
)
SELECT
  task.id,
  'baseline',
  jsonb_build_object(
    'status', task.status,
    'microStatus', task.micro_status,
    'kanbanColumn', task.kanban_column,
    'effort', task.effort,
    'localDisposition', task.local_disposition,
    'projectIds', COALESCE((
      SELECT jsonb_agg(project_id ORDER BY project_id)
      FROM task_projects WHERE task_id = task.id
    ), '[]'::jsonb),
    'phaseIds', COALESCE((
      SELECT jsonb_agg(phase_id ORDER BY phase_id)
      FROM project_phase_items WHERE task_id = task.id
    ), '[]'::jsonb)
  )::text,
  task_history_now(),
  task_history_now(),
  'migration_baseline',
  jsonb_build_object(
    'connectorType', task.connector_type,
    'connectorInstanceId', task.connector_instance_id,
    'sourceId', task.source_id,
    'syncStatus', task.sync_status
  ),
  jsonb_build_object(
    'historicalBoundary', true,
    'reason', 'Current state recovered after PostgreSQL task-history capture was restored'
  )
FROM tasks AS task
WHERE NOT EXISTS (
  SELECT 1 FROM task_history_events AS history
  WHERE history.task_id = task.id AND history.event_type = 'baseline'
);
--> statement-breakpoint
-- Reconcile tracked task fields whose current value advanced without a
-- PostgreSQL trigger. Terminal status corrections retain completed_at when it
-- is later than the last observed status, preserving the known completion day.
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id,
    CASE
      WHEN event_type = 'baseline'
        THEN task_history_safe_json(new_value) ->> 'status'
      ELSE new_value
    END AS value,
    occurred_at
  FROM task_history_events
  WHERE event_type IN ('baseline', 'status_changed')
  ORDER BY task_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, new_value,
  occurred_at, recorded_at, provenance, provenance_ref, metadata
)
SELECT
  task.id, 'status_changed', 'status', latest.value, task.status,
  CASE
    WHEN task.status IN ('done', 'cancelled')
      AND task.completed_at IS NOT NULL
      AND task.completed_at > latest.occurred_at THEN task.completed_at
    ELSE task_history_now()
  END,
  task_history_now(),
  'migration_reconciliation',
  jsonb_build_object(
    'connectorType', task.connector_type,
    'connectorInstanceId', task.connector_instance_id,
    'sourceId', task.source_id,
    'syncStatus', task.sync_status,
    'sourceUpdatedAt', task.updated_at
  ),
  jsonb_build_object(
    'reason', 'Current status differed from the latest PostgreSQL history event'
  )
FROM tasks AS task
INNER JOIN latest ON latest.task_id = task.id
WHERE latest.value IS DISTINCT FROM task.status;
--> statement-breakpoint
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id,
    CASE
      WHEN event_type = 'baseline'
        THEN task_history_safe_json(new_value) ->> 'microStatus'
      ELSE new_value
    END AS value
  FROM task_history_events
  WHERE event_type IN ('baseline', 'micro_status_changed')
  ORDER BY task_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, new_value,
  occurred_at, recorded_at, provenance, provenance_ref, metadata
)
SELECT
  task.id, 'micro_status_changed', 'micro_status', latest.value, task.micro_status,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('sourceUpdatedAt', task.updated_at),
  jsonb_build_object('reason', 'Current micro-status differed from PostgreSQL history')
FROM tasks AS task
INNER JOIN latest ON latest.task_id = task.id
WHERE latest.value IS DISTINCT FROM task.micro_status;
--> statement-breakpoint
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id,
    CASE
      WHEN event_type = 'baseline'
        THEN task_history_safe_json(new_value) ->> 'kanbanColumn'
      ELSE new_value
    END AS value
  FROM task_history_events
  WHERE event_type IN ('baseline', 'kanban_column_changed')
  ORDER BY task_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, new_value,
  occurred_at, recorded_at, provenance, provenance_ref, metadata
)
SELECT
  task.id, 'kanban_column_changed', 'kanban_column', latest.value, task.kanban_column,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('sourceUpdatedAt', task.updated_at),
  jsonb_build_object('reason', 'Current kanban column differed from PostgreSQL history')
FROM tasks AS task
INNER JOIN latest ON latest.task_id = task.id
WHERE latest.value IS DISTINCT FROM task.kanban_column;
--> statement-breakpoint
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id,
    CASE
      WHEN event_type = 'baseline'
        THEN task_history_safe_json(new_value) ->> 'effort'
      ELSE new_value
    END AS value
  FROM task_history_events
  WHERE event_type IN ('baseline', 'effort_changed')
  ORDER BY task_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, new_value,
  occurred_at, recorded_at, provenance, provenance_ref, metadata
)
SELECT
  task.id, 'effort_changed', 'effort', latest.value, task.effort::text,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('sourceUpdatedAt', task.updated_at),
  jsonb_build_object('reason', 'Current effort differed from PostgreSQL history')
FROM tasks AS task
INNER JOIN latest ON latest.task_id = task.id
WHERE latest.value IS DISTINCT FROM task.effort::text;
--> statement-breakpoint
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id,
    CASE
      WHEN event_type = 'baseline'
        THEN COALESCE(task_history_safe_json(new_value) ->> 'localDisposition', 'active')
      ELSE new_value
    END AS value
  FROM task_history_events
  WHERE event_type IN ('baseline', 'local_disposition_changed')
  ORDER BY task_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, new_value,
  occurred_at, recorded_at, provenance, provenance_ref, metadata
)
SELECT
  task.id, 'local_disposition_changed', 'local_disposition',
  latest.value, task.local_disposition,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('sourceUpdatedAt', task.updated_at),
  jsonb_build_object('reason', 'Current local disposition differed from PostgreSQL history')
FROM tasks AS task
INNER JOIN latest ON latest.task_id = task.id
WHERE latest.value IS DISTINCT FROM task.local_disposition;
--> statement-breakpoint
-- Reconcile project memberships in both directions. A latest "present" state
-- is derived from baselines and subsequent membership events.
WITH membership_events AS (
  SELECT
    history.task_id,
    project_id.value AS project_id,
    true AS present,
    history.occurred_at,
    history.id
  FROM task_history_events AS history
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(task_history_safe_json(history.new_value) -> 'projectIds', '[]'::jsonb)
  ) AS project_id(value)
  WHERE history.event_type = 'baseline'
  UNION ALL
  SELECT
    task_id,
    project_id,
    event_type = 'project_added',
    occurred_at,
    id
  FROM task_history_events
  WHERE event_type IN ('project_added', 'project_removed') AND project_id IS NOT NULL
),
latest AS (
  SELECT DISTINCT ON (task_id, project_id)
    task_id, project_id, present
  FROM membership_events
  ORDER BY task_id, project_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, new_value, project_id,
  occurred_at, recorded_at, provenance, metadata
)
SELECT
  current.task_id, 'project_added', 'project_id', current.project_id, current.project_id,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('reason', 'Current project membership was absent from PostgreSQL history')
FROM task_projects AS current
LEFT JOIN latest
  ON latest.task_id = current.task_id AND latest.project_id = current.project_id
WHERE COALESCE(latest.present, false) = false;
--> statement-breakpoint
WITH membership_events AS (
  SELECT
    history.task_id,
    project_id.value AS project_id,
    true AS present,
    history.occurred_at,
    history.id
  FROM task_history_events AS history
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(task_history_safe_json(history.new_value) -> 'projectIds', '[]'::jsonb)
  ) AS project_id(value)
  WHERE history.event_type = 'baseline'
  UNION ALL
  SELECT
    task_id,
    project_id,
    event_type = 'project_added',
    occurred_at,
    id
  FROM task_history_events
  WHERE event_type IN ('project_added', 'project_removed') AND project_id IS NOT NULL
),
latest AS (
  SELECT DISTINCT ON (task_id, project_id)
    task_id, project_id, present
  FROM membership_events
  ORDER BY task_id, project_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, project_id,
  occurred_at, recorded_at, provenance, metadata
)
SELECT
  latest.task_id, 'project_removed', 'project_id', latest.project_id, latest.project_id,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('reason', 'Historical project membership was absent from current state')
FROM latest
WHERE latest.present = true
  AND NOT EXISTS (
    SELECT 1 FROM task_projects AS current
    WHERE current.task_id = latest.task_id AND current.project_id = latest.project_id
  );
--> statement-breakpoint
WITH membership_events AS (
  SELECT
    history.task_id,
    phase_id.value AS phase_id,
    true AS present,
    history.occurred_at,
    history.id
  FROM task_history_events AS history
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(task_history_safe_json(history.new_value) -> 'phaseIds', '[]'::jsonb)
  ) AS phase_id(value)
  WHERE history.event_type = 'baseline'
  UNION ALL
  SELECT
    task_id,
    phase_id,
    event_type = 'phase_added',
    occurred_at,
    id
  FROM task_history_events
  WHERE event_type IN ('phase_added', 'phase_removed') AND phase_id IS NOT NULL
),
latest AS (
  SELECT DISTINCT ON (task_id, phase_id)
    task_id, phase_id, present
  FROM membership_events
  ORDER BY task_id, phase_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, new_value, phase_id,
  occurred_at, recorded_at, provenance, metadata
)
SELECT
  current.task_id, 'phase_added', 'phase_id', current.phase_id, current.phase_id,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('reason', 'Current phase membership was absent from PostgreSQL history')
FROM project_phase_items AS current
LEFT JOIN latest
  ON latest.task_id = current.task_id AND latest.phase_id = current.phase_id
WHERE COALESCE(latest.present, false) = false;
--> statement-breakpoint
WITH membership_events AS (
  SELECT
    history.task_id,
    phase_id.value AS phase_id,
    true AS present,
    history.occurred_at,
    history.id
  FROM task_history_events AS history
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(task_history_safe_json(history.new_value) -> 'phaseIds', '[]'::jsonb)
  ) AS phase_id(value)
  WHERE history.event_type = 'baseline'
  UNION ALL
  SELECT
    task_id,
    phase_id,
    event_type = 'phase_added',
    occurred_at,
    id
  FROM task_history_events
  WHERE event_type IN ('phase_added', 'phase_removed') AND phase_id IS NOT NULL
),
latest AS (
  SELECT DISTINCT ON (task_id, phase_id)
    task_id, phase_id, present
  FROM membership_events
  ORDER BY task_id, phase_id, occurred_at DESC, id DESC
)
INSERT INTO task_history_events (
  task_id, event_type, field_name, previous_value, phase_id,
  occurred_at, recorded_at, provenance, metadata
)
SELECT
  latest.task_id, 'phase_removed', 'phase_id', latest.phase_id, latest.phase_id,
  task_history_now(), task_history_now(), 'migration_reconciliation',
  jsonb_build_object('reason', 'Historical phase membership was absent from current state')
FROM latest
WHERE latest.present = true
  AND NOT EXISTS (
    SELECT 1 FROM project_phase_items AS current
    WHERE current.task_id = latest.task_id AND current.phase_id = latest.phase_id
  );
