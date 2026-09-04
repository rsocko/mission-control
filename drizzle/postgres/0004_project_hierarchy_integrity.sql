-- L15 project-hierarchy integrity parity.
--
-- The initial PostgreSQL schema created the hierarchy tables but not the
-- SQLite hierarchy triggers (drizzle/0032_project_hierarchy_commands.sql).
-- Adapter code alone is insufficient because already-portable project
-- automation and task-core operations also write `task_projects`,
-- `project_phases`, and `project_phase_items` outside the hierarchy adapter.
--
-- This migration is additive correctness parity only: functions and triggers
-- over existing tables. It creates no table, column, or index, and performs no
-- backfill or cutover.
CREATE OR REPLACE FUNCTION project_hierarchy_bump_revision(target_project_id text)
RETURNS void AS $$
BEGIN
  IF target_project_id IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_hierarchy_mutation_context
    WHERE project_id = target_project_id
  ) THEN
    RETURN;
  END IF;
  UPDATE hub_projects
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = target_project_id;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_phase_items_one_phase_guard_insert()
RETURNS trigger AS $$
DECLARE
  target_project_id text;
BEGIN
  SELECT project_id INTO target_project_id
  FROM project_phases WHERE id = NEW.phase_id;
  IF target_project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM project_phase_items existing
    INNER JOIN project_phases existing_phase ON existing_phase.id = existing.phase_id
    WHERE existing.task_id = NEW.task_id
      AND existing_phase.project_id = target_project_id
      AND existing.phase_id <> NEW.phase_id
  ) THEN
    RAISE EXCEPTION 'task already belongs to another phase in this project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_phase_items_one_phase_guard_update()
RETURNS trigger AS $$
DECLARE
  target_project_id text;
BEGIN
  SELECT project_id INTO target_project_id
  FROM project_phases WHERE id = NEW.phase_id;
  IF target_project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM project_phase_items existing
    INNER JOIN project_phases existing_phase ON existing_phase.id = existing.phase_id
    WHERE existing.task_id = NEW.task_id
      AND existing_phase.project_id = target_project_id
      AND existing.id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'task already belongs to another phase in this project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_phase_items_membership_guard()
RETURNS trigger AS $$
DECLARE
  target_project_id text;
BEGIN
  SELECT project_id INTO target_project_id
  FROM project_phases WHERE id = NEW.phase_id;
  IF target_project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM task_projects
    WHERE task_id = NEW.task_id AND project_id = target_project_id
  ) THEN
    RAISE EXCEPTION 'task must belong to the phase project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_phases_reparent_assignment_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NULL OR NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM project_phase_items moving_item
    INNER JOIN project_phase_items existing_item
      ON existing_item.task_id = moving_item.task_id
      AND existing_item.phase_id <> moving_item.phase_id
    INNER JOIN project_phases existing_phase
      ON existing_phase.id = existing_item.phase_id
    WHERE moving_item.phase_id = OLD.id
      AND existing_phase.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'phase tasks already belong to another phase in the target project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_phases_reparent_membership_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NULL OR NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM project_phase_items moving_item
    WHERE moving_item.phase_id = OLD.id
      AND NOT EXISTS (
        SELECT 1 FROM task_projects
        WHERE task_id = moving_item.task_id
          AND project_id = NEW.project_id
      )
  ) THEN
    RAISE EXCEPTION 'phase tasks must belong to the target project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_membership_phase_cleanup()
RETURNS trigger AS $$
BEGIN
  DELETE FROM project_phase_items
  WHERE task_id = OLD.task_id
    AND phase_id IN (
      SELECT id FROM project_phases WHERE project_id = OLD.project_id
    );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_hierarchy_revision_phase()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM project_hierarchy_bump_revision(NEW.project_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM project_hierarchy_bump_revision(OLD.project_id);
  ELSE
    PERFORM project_hierarchy_bump_revision(OLD.project_id);
    IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      PERFORM project_hierarchy_bump_revision(NEW.project_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_hierarchy_revision_phase_item()
RETURNS trigger AS $$
DECLARE
  old_project_id text;
  new_project_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT project_id INTO old_project_id FROM project_phases WHERE id = OLD.phase_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT project_id INTO new_project_id FROM project_phases WHERE id = NEW.phase_id;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM project_hierarchy_bump_revision(new_project_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM project_hierarchy_bump_revision(old_project_id);
  ELSE
    PERFORM project_hierarchy_bump_revision(old_project_id);
    IF NEW.phase_id IS DISTINCT FROM OLD.phase_id THEN
      PERFORM project_hierarchy_bump_revision(new_project_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_hierarchy_revision_task_project()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM project_hierarchy_bump_revision(NEW.project_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM project_hierarchy_bump_revision(OLD.project_id);
  ELSE
    PERFORM project_hierarchy_bump_revision(OLD.project_id);
    IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      PERFORM project_hierarchy_bump_revision(NEW.project_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_phase_items_one_phase_per_project_insert ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER project_phase_items_one_phase_per_project_insert
BEFORE INSERT ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION project_phase_items_one_phase_guard_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_phase_items_one_phase_per_project_update ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER project_phase_items_one_phase_per_project_update
BEFORE UPDATE OF phase_id, task_id ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION project_phase_items_one_phase_guard_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_phase_items_project_membership_insert ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER project_phase_items_project_membership_insert
BEFORE INSERT ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION project_phase_items_membership_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_phase_items_project_membership_update ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER project_phase_items_project_membership_update
BEFORE UPDATE OF phase_id, task_id ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION project_phase_items_membership_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_phases_reparent_assignment_guard ON project_phases;
--> statement-breakpoint
CREATE TRIGGER project_phases_reparent_assignment_guard
BEFORE UPDATE OF project_id ON project_phases
FOR EACH ROW EXECUTE FUNCTION project_phases_reparent_assignment_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_phases_reparent_membership_guard ON project_phases;
--> statement-breakpoint
CREATE TRIGGER project_phases_reparent_membership_guard
BEFORE UPDATE OF project_id ON project_phases
FOR EACH ROW EXECUTE FUNCTION project_phases_reparent_membership_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_membership_phase_cleanup_delete ON task_projects;
--> statement-breakpoint
CREATE TRIGGER project_membership_phase_cleanup_delete
AFTER DELETE ON task_projects
FOR EACH ROW EXECUTE FUNCTION project_membership_phase_cleanup();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_membership_phase_cleanup_update ON task_projects;
--> statement-breakpoint
CREATE TRIGGER project_membership_phase_cleanup_update
AFTER UPDATE OF task_id, project_id ON task_projects
FOR EACH ROW
WHEN (
  OLD.task_id IS DISTINCT FROM NEW.task_id
  OR OLD.project_id IS DISTINCT FROM NEW.project_id
)
EXECUTE FUNCTION project_membership_phase_cleanup();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_phase_insert ON project_phases;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_phase_insert
AFTER INSERT ON project_phases
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_phase();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_phase_update ON project_phases;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_phase_update
AFTER UPDATE ON project_phases
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_phase();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_phase_delete ON project_phases;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_phase_delete
AFTER DELETE ON project_phases
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_phase();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_item_insert ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_item_insert
AFTER INSERT ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_phase_item();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_item_update ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_item_update
AFTER UPDATE ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_phase_item();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_item_delete ON project_phase_items;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_item_delete
AFTER DELETE ON project_phase_items
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_phase_item();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_task_project_insert ON task_projects;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_task_project_insert
AFTER INSERT ON task_projects
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_task_project();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_task_project_update ON task_projects;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_task_project_update
AFTER UPDATE ON task_projects
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_task_project();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_hierarchy_revision_task_project_delete ON task_projects;
--> statement-breakpoint
CREATE TRIGGER project_hierarchy_revision_task_project_delete
AFTER DELETE ON task_projects
FOR EACH ROW EXECUTE FUNCTION project_hierarchy_revision_task_project();
