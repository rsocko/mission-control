ALTER TABLE "task_projects" ADD COLUMN "provenance" text DEFAULT 'local' NOT NULL;
--> statement-breakpoint
UPDATE task_projects
SET provenance = 'github-sync'
WHERE project_id IN (
  SELECT id
  FROM hub_projects
  WHERE id LIKE 'gh-project:%'
    OR metadata->>'syncManaged' = 'true'
);
--> statement-breakpoint
CREATE TEMP TABLE project_membership_recovery ON COMMIT DROP AS
WITH membership_events AS (
  SELECT
    commands.project_id,
    task_id,
    CASE commands.command_type
      WHEN 'assign_tasks' THEN true
      ELSE false
    END AS intent,
    commands.result_revision,
    commands.created_at,
    commands.id
  FROM project_hierarchy_commands AS commands
  CROSS JOIN LATERAL jsonb_array_elements_text(
    commands.request_json->'command'->'taskIds'
  ) AS task_ids(task_id)
  WHERE commands.actor_type = 'user'
    AND commands.command_type IN ('assign_tasks', 'remove_tasks')

  UNION ALL

  SELECT
    commands.project_id,
    state->>'taskId' AS task_id,
    (state->>'member')::boolean AS intent,
    commands.result_revision,
    commands.created_at,
    commands.id
  FROM project_hierarchy_commands AS commands
  CROSS JOIN LATERAL jsonb_array_elements(
    commands.request_json->'command'->'states'
  ) AS state
  WHERE commands.actor_type = 'user'
    AND commands.command_type = 'restore_project_tasks'
),
ranked_events AS (
  SELECT
    project_id,
    task_id,
    intent,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY project_id, task_id
      ORDER BY result_revision DESC, created_at DESC, id DESC
    ) AS event_rank
  FROM membership_events
  WHERE task_id IS NOT NULL
)
SELECT project_id, task_id, intent, created_at
FROM ranked_events
WHERE event_rank = 1;
--> statement-breakpoint
DELETE FROM task_projects
USING project_membership_recovery AS recovery
WHERE recovery.project_id = task_projects.project_id
  AND recovery.task_id = task_projects.task_id
  AND recovery.intent = false;
--> statement-breakpoint
INSERT INTO project_auto_include_exclusions (project_id, task_id, excluded_at)
SELECT recovery.project_id, recovery.task_id, recovery.created_at
FROM project_membership_recovery AS recovery
JOIN hub_projects ON hub_projects.id = recovery.project_id
JOIN tasks ON tasks.id = recovery.task_id
WHERE recovery.intent = false
ON CONFLICT(project_id, task_id)
DO UPDATE SET excluded_at = EXCLUDED.excluded_at;
--> statement-breakpoint
DELETE FROM project_auto_include_exclusions
USING project_membership_recovery AS recovery
WHERE recovery.project_id = project_auto_include_exclusions.project_id
  AND recovery.task_id = project_auto_include_exclusions.task_id
  AND recovery.intent = true;
--> statement-breakpoint
INSERT INTO task_projects (task_id, project_id, provenance)
SELECT recovery.task_id, recovery.project_id, 'local'
FROM project_membership_recovery AS recovery
JOIN hub_projects ON hub_projects.id = recovery.project_id
JOIN tasks ON tasks.id = recovery.task_id
WHERE recovery.intent = true
ON CONFLICT(task_id, project_id)
DO UPDATE SET provenance = 'local';
--> statement-breakpoint
DROP TABLE project_membership_recovery;