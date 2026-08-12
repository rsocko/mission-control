ALTER TABLE `hub_projects` ADD `hierarchy_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DELETE FROM `project_phase_items`
WHERE EXISTS (
  SELECT 1
  FROM `project_phase_items` AS earlier
  INNER JOIN `project_phases` AS earlier_phase ON earlier_phase.id = earlier.phase_id
  INNER JOIN `project_phases` AS current_phase ON current_phase.id = project_phase_items.phase_id
  WHERE earlier.task_id = project_phase_items.task_id
    AND earlier_phase.project_id = current_phase.project_id
    AND earlier_phase.project_id IS NOT NULL
    AND earlier.rowid < project_phase_items.rowid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `project_hierarchy_commands` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `base_revision` integer NOT NULL,
  `result_revision` integer NOT NULL,
  `command_type` text NOT NULL,
  `request_json` text NOT NULL,
  `inverse_command_json` text,
  `result_json` text NOT NULL,
  `actor_type` text DEFAULT 'user' NOT NULL,
  `actor_id` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_project_hierarchy_commands_project_revision`
ON `project_hierarchy_commands` (`project_id`, `result_revision`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `project_hierarchy_mutation_context` (
  `project_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_phase_items_one_phase_per_project_insert`
BEFORE INSERT ON `project_phase_items`
WHEN EXISTS (
  SELECT 1
  FROM `project_phase_items` AS existing
  INNER JOIN `project_phases` AS existing_phase ON existing_phase.id = existing.phase_id
  INNER JOIN `project_phases` AS target_phase ON target_phase.id = NEW.phase_id
  WHERE existing.task_id = NEW.task_id
    AND existing_phase.project_id = target_phase.project_id
    AND target_phase.project_id IS NOT NULL
    AND existing.phase_id <> NEW.phase_id
)
BEGIN
  SELECT RAISE(ABORT, 'task already belongs to another phase in this project');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_phase_items_project_membership_insert`
BEFORE INSERT ON `project_phase_items`
WHEN EXISTS (
  SELECT 1
  FROM `project_phases` AS target_phase
  WHERE target_phase.id = NEW.phase_id
    AND target_phase.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `task_projects`
      WHERE task_id = NEW.task_id
        AND project_id = target_phase.project_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'task must belong to the phase project');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_phases_reparent_assignment_guard`
BEFORE UPDATE OF `project_id` ON `project_phases`
WHEN NEW.project_id IS NOT NULL
  AND NEW.project_id IS NOT OLD.project_id
  AND EXISTS (
    SELECT 1
    FROM `project_phase_items` AS moving_item
    INNER JOIN `project_phase_items` AS existing_item
      ON existing_item.task_id = moving_item.task_id
      AND existing_item.phase_id <> moving_item.phase_id
    INNER JOIN `project_phases` AS existing_phase
      ON existing_phase.id = existing_item.phase_id
    WHERE moving_item.phase_id = OLD.id
      AND existing_phase.project_id = NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'phase tasks already belong to another phase in the target project');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_phases_reparent_membership_guard`
BEFORE UPDATE OF `project_id` ON `project_phases`
WHEN NEW.project_id IS NOT NULL
  AND NEW.project_id IS NOT OLD.project_id
  AND EXISTS (
    SELECT 1
    FROM `project_phase_items` AS moving_item
    WHERE moving_item.phase_id = OLD.id
      AND NOT EXISTS (
        SELECT 1
        FROM `task_projects`
        WHERE task_id = moving_item.task_id
          AND project_id = NEW.project_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'phase tasks must belong to the target project');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_membership_phase_cleanup_delete`
AFTER DELETE ON `task_projects`
BEGIN
  DELETE FROM `project_phase_items`
  WHERE task_id = OLD.task_id
    AND phase_id IN (
      SELECT id FROM `project_phases`
      WHERE project_id = OLD.project_id
    );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_membership_phase_cleanup_update`
AFTER UPDATE OF `task_id`, `project_id` ON `task_projects`
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.project_id IS NOT NEW.project_id
BEGIN
  DELETE FROM `project_phase_items`
  WHERE task_id = OLD.task_id
    AND phase_id IN (
      SELECT id FROM `project_phases`
      WHERE project_id = OLD.project_id
    );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_phase_insert`
AFTER INSERT ON `project_phases`
WHEN NEW.project_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `project_hierarchy_mutation_context`
    WHERE project_id = NEW.project_id
  )
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = NEW.project_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_phase_delete`
AFTER DELETE ON `project_phases`
WHEN OLD.project_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `project_hierarchy_mutation_context`
    WHERE project_id = OLD.project_id
  )
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = OLD.project_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_phase_update`
AFTER UPDATE ON `project_phases`
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = OLD.project_id
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = OLD.project_id
    );
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = NEW.project_id
    AND NEW.project_id IS NOT OLD.project_id
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = NEW.project_id
    );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_item_insert`
AFTER INSERT ON `project_phase_items`
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = (SELECT project_id FROM project_phases WHERE id = NEW.phase_id)
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = (SELECT project_id FROM project_phases WHERE id = NEW.phase_id)
    );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_item_delete`
AFTER DELETE ON `project_phase_items`
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = (SELECT project_id FROM project_phases WHERE id = OLD.phase_id)
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = (SELECT project_id FROM project_phases WHERE id = OLD.phase_id)
    );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_item_update`
AFTER UPDATE ON `project_phase_items`
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = (SELECT project_id FROM project_phases WHERE id = OLD.phase_id)
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = (SELECT project_id FROM project_phases WHERE id = OLD.phase_id)
    );
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = (SELECT project_id FROM project_phases WHERE id = NEW.phase_id)
    AND NEW.phase_id IS NOT OLD.phase_id
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = (SELECT project_id FROM project_phases WHERE id = NEW.phase_id)
    );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_task_project_insert`
AFTER INSERT ON `task_projects`
WHEN NOT EXISTS (
  SELECT 1 FROM `project_hierarchy_mutation_context`
  WHERE project_id = NEW.project_id
)
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = NEW.project_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_task_project_delete`
AFTER DELETE ON `task_projects`
WHEN NOT EXISTS (
  SELECT 1 FROM `project_hierarchy_mutation_context`
  WHERE project_id = OLD.project_id
)
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = OLD.project_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_hierarchy_revision_task_project_update`
AFTER UPDATE ON `task_projects`
BEGIN
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = OLD.project_id
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = OLD.project_id
    );
  UPDATE `hub_projects`
  SET hierarchy_revision = hierarchy_revision + 1
  WHERE id = NEW.project_id
    AND NEW.project_id IS NOT OLD.project_id
    AND NOT EXISTS (
      SELECT 1 FROM `project_hierarchy_mutation_context`
      WHERE project_id = NEW.project_id
    );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_phase_items_one_phase_per_project_update`
BEFORE UPDATE OF `phase_id`, `task_id` ON `project_phase_items`
WHEN EXISTS (
  SELECT 1
  FROM `project_phase_items` AS existing
  INNER JOIN `project_phases` AS existing_phase ON existing_phase.id = existing.phase_id
  INNER JOIN `project_phases` AS target_phase ON target_phase.id = NEW.phase_id
  WHERE existing.task_id = NEW.task_id
    AND existing_phase.project_id = target_phase.project_id
    AND target_phase.project_id IS NOT NULL
    AND existing.id <> OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'task already belongs to another phase in this project');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `project_phase_items_project_membership_update`
BEFORE UPDATE OF `phase_id`, `task_id` ON `project_phase_items`
WHEN EXISTS (
  SELECT 1
  FROM `project_phases` AS target_phase
  WHERE target_phase.id = NEW.phase_id
    AND target_phase.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `task_projects`
      WHERE task_id = NEW.task_id
        AND project_id = target_phase.project_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'task must belong to the phase project');
END;
