CREATE OR REPLACE FUNCTION task_history_safe_date(value text)
RETURNS date AS $$
BEGIN
  IF value IS NULL OR value = '' THEN
    RETURN NULL;
  END IF;
  RETURN substring(value FROM 1 FOR 10)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_history_safe_timestamp(value text)
RETURNS timestamptz AS $$
BEGIN
  IF value IS NULL OR value = '' THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_due_date_push_count()
RETURNS trigger AS $$
DECLARE
  old_due_date date := task_history_safe_date(OLD.due_date);
  new_due_date date := task_history_safe_date(NEW.due_date);
  observed_at text := task_history_now();
BEGIN
  IF current_setting('mission_control.suppress_task_history', true) = 'on'
    OR old_due_date IS NULL
    OR new_due_date IS NULL
    OR new_due_date <= old_due_date THEN
    RETURN NEW;
  END IF;

  UPDATE tasks
  SET push_count = OLD.push_count + 1
  WHERE id = NEW.id;

  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, metadata
  ) VALUES (
    NEW.id, 'due_date_pushed', 'dueDate', OLD.due_date, NEW.due_date,
    observed_at, observed_at, 'database-trigger',
    jsonb_build_object('delayDays', new_due_date - old_due_date)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_snooze_extension_history()
RETURNS trigger AS $$
DECLARE
  old_snoozed_until timestamptz := task_history_safe_timestamp(OLD.snoozed_until);
  new_snoozed_until timestamptz := task_history_safe_timestamp(NEW.snoozed_until);
  observed_at text := task_history_now();
BEGIN
  IF current_setting('mission_control.suppress_task_history', true) = 'on'
    OR old_snoozed_until IS NULL
    OR new_snoozed_until IS NULL
    OR new_snoozed_until <= old_snoozed_until THEN
    RETURN NEW;
  END IF;

  INSERT INTO task_history_events (
    task_id, event_type, field_name, previous_value, new_value,
    occurred_at, recorded_at, provenance, metadata
  ) VALUES (
    NEW.id, 'snooze_extended', 'snoozedUntil',
    OLD.snoozed_until, NEW.snoozed_until,
    observed_at, observed_at, 'database-trigger',
    jsonb_build_object(
      'delayHours',
      round((extract(epoch FROM (new_snoozed_until - old_snoozed_until)) / 3600)::numeric, 1)
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_history_immutable_guard()
RETURNS trigger AS $$
BEGIN
  IF current_setting('mission_control.suppress_task_history', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'task_history_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_due_date_push_count ON tasks;
--> statement-breakpoint
CREATE TRIGGER task_due_date_push_count
AFTER UPDATE OF due_date ON tasks
FOR EACH ROW
EXECUTE FUNCTION task_due_date_push_count();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_snooze_extension_history ON tasks;
--> statement-breakpoint
CREATE TRIGGER task_snooze_extension_history
AFTER UPDATE OF snoozed_until ON tasks
FOR EACH ROW
EXECUTE FUNCTION task_snooze_extension_history();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_immutable_update ON task_history_events;
--> statement-breakpoint
CREATE TRIGGER task_history_immutable_update
BEFORE UPDATE ON task_history_events
FOR EACH ROW
EXECUTE FUNCTION task_history_immutable_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_history_immutable_delete ON task_history_events;
--> statement-breakpoint
CREATE TRIGGER task_history_immutable_delete
BEFORE DELETE ON task_history_events
FOR EACH ROW
EXECUTE FUNCTION task_history_immutable_guard();
